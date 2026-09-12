// tests/fnf_block6_unit.test.js
//
// Offline unit tests for Block 6 (Full & Final Settlement): separation
// validation, settlement generation (notice recovery, unpaid salary, leave
// encashment, gratuity, loan/advance recovery), and the approval/payout
// workflow's state-machine guards.
//
// Run with:  node --test tests/fnf_block6_unit.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const payroll = require('../src/payroll');
const fnf = require('../src/fnf');

let patched = [];
function mockDb(name, fn) { patched.push([db, name, db[name]]); db[name] = fn; }
function mockPayroll(name, fn) { patched.push([payroll, name, payroll[name]]); payroll[name] = fn; }
afterEach(() => {
  for (const [obj, name, original] of patched) obj[name] = original;
  patched = [];
});

// ---------------------------------------------------------------------------
// Separation initiation
// ---------------------------------------------------------------------------

test('initiateSeparation rejects a last working date before the resignation date', async () => {
  mockDb('getActiveSeparationForUser', async () => null);
  await assert.rejects(
    () => fnf.initiateSeparation({ userId: 1, resignationDate: '2026-06-10', lastWorkingDate: '2026-06-01', noticePeriodRequiredDays: 30, initiatedBy: 9 }),
    /cannot be before/
  );
});

test('initiateSeparation refuses a second active separation for the same employee', async () => {
  mockDb('getActiveSeparationForUser', async () => ({ id: 1, status: 'pending' }));
  await assert.rejects(
    () => fnf.initiateSeparation({ userId: 1, resignationDate: '2026-06-01', lastWorkingDate: '2026-07-01', noticePeriodRequiredDays: 30, initiatedBy: 9 }),
    /already has an active resignation/
  );
});

test('decideSeparationRequest refuses to re-decide', async () => {
  mockDb('getSeparation', async () => ({ id: 1, status: 'approved' }));
  await assert.rejects(() => fnf.decideSeparationRequest(1, 'approved', 9), /already been decided/);
});

// ---------------------------------------------------------------------------
// Settlement generation
// ---------------------------------------------------------------------------

function baseGenerateMocks(overrides = {}) {
  mockDb('getSeparation', async () => ({
    id: 1, user_id: 1, status: 'approved', resignation_date: '2026-05-01', last_working_date: '2026-05-31',
    notice_period_required_days: 30, ...overrides.separation,
  }));
  mockDb('getFnfSettlementBySeparation', async () => overrides.existing || null);
  mockDb('listFinancialYears', async () => [{ id: 1, start_date: '2026-04-01', end_date: '2027-03-31' }]);
  mockDb('getActiveFinancialYear', async () => ({ id: 1, start_date: '2026-04-01', end_date: '2027-03-31' }));
  mockDb('getActiveSalaryStructure', async () => ({ id: 10 }));
  mockDb('getStructureComponents', async () => overrides.components || [
    { type: 'earning', code: 'BASIC', amount: 40000 },
    { type: 'earning', code: 'HRA', amount: 16000 },
    { type: 'deduction', code: 'PF_EMPLOYEE', amount: 4800 },
  ]);
  mockDb('dbGet', overrides.dbGet || (async () => null)); // "already payrolled" check defaults to "not found"
  mockDb('getHolidaysInRange', async () => overrides.holidays || []);
  mockDb('getWeeklyOffDays', async () => [0, 6]);
  mockDb('dbAll', overrides.dbAll || (async () => [])); // leave_balances query
  mockPayroll('calculateGratuity', async () => overrides.gratuity || { gratuityAmount: 0, eligible: false });
  mockDb('listActiveLoansForUser', async () => overrides.loans || []);
  mockDb('listRecoveringAdvancesForUser', async () => overrides.advances || []);
  mockDb('createFnfSettlement', async (data) => { overrides.captured = data; return { lastInsertRowid: 501 }; });
  mockDb('updateFnfSettlementLineItems', async (id, data) => { overrides.captured = data; });
  mockDb('getFnfSettlement', async () => overrides.captured);
}

test('generateSettlement refuses when the separation is not yet approved', async () => {
  mockDb('getSeparation', async () => ({ id: 1, status: 'pending' }));
  await assert.rejects(() => fnf.generateSettlement(1, 9), /must be approved/);
});

test('generateSettlement refuses to regenerate a non-draft settlement', async () => {
  mockDb('getSeparation', async () => ({ id: 1, status: 'approved' }));
  mockDb('getFnfSettlementBySeparation', async () => ({ id: 5, status: 'approved' }));
  await assert.rejects(() => fnf.generateSettlement(1, 9), /can only be regenerated while in draft/);
});

test('generateSettlement computes notice-period shortfall recovery when resignation notice was short', async () => {
  const ctx = {};
  baseGenerateMocks(ctx);
  await fnf.generateSettlement(1, 9);
  // resignation 2026-05-01 -> last working 2026-05-31 = 30 days served (inclusive minus 1 for "served after giving notice")
  // servedDays = daysBetweenInclusive(05-01,05-31) - 1 = 31 - 1 = 30; required 30 -> shortfall 0
  assert.equal(ctx.captured.noticeRecoveryDays, 0);
  assert.equal(ctx.captured.noticeRecoveryAmount, 0);
});

test('generateSettlement recovers pay for a genuine notice-period shortfall', async () => {
  const ctx = {};
  Object.assign(ctx, { separation: { resignation_date: '2026-05-01', last_working_date: '2026-05-15', notice_period_required_days: 30 } });
  baseGenerateMocks(ctx);
  await fnf.generateSettlement(1, 9);
  // served = daysBetween(05-01,05-15) - 1 = 15 - 1 = 14 days; required 30 -> shortfall 16 days
  const monthlyGross = 56000; // 40000 basic + 16000 hra
  const perDay = Math.round((monthlyGross / 26) * 100) / 100;
  assert.equal(ctx.captured.noticeRecoveryDays, 16);
  assert.equal(ctx.captured.noticeRecoveryAmount, Math.round(perDay * 16 * 100) / 100);
});

test('generateSettlement skips unpaid-salary calculation when the final month was already payrolled', async () => {
  const ctx = {};
  Object.assign(ctx, { dbGet: async () => ({ found: 1 }) }); // "already payrolled" check returns a row
  baseGenerateMocks(ctx);
  await fnf.generateSettlement(1, 9);
  assert.equal(ctx.captured.unpaidSalaryDays, 0);
  assert.equal(ctx.captured.unpaidSalaryAmount, 0);
});

test('generateSettlement sums outstanding loan and advance balances into recovery lines', async () => {
  const ctx = {};
  Object.assign(ctx, {
    loans: [{ outstanding_balance: 20000 }, { outstanding_balance: 5000 }],
    advances: [{ outstanding_balance: 3000 }],
  });
  baseGenerateMocks(ctx);
  await fnf.generateSettlement(1, 9);
  assert.equal(ctx.captured.loanRecoveryAmount, 25000);
  assert.equal(ctx.captured.advanceRecoveryAmount, 3000);
});

test('generateSettlement includes gratuity and honors manual overrides for bonus/reimbursements/asset recovery', async () => {
  const ctx = {};
  Object.assign(ctx, { gratuity: { gratuityAmount: 150000, eligible: true } });
  baseGenerateMocks(ctx);
  await fnf.generateSettlement(1, 9, { bonusAmount: 10000, reimbursementsAmount: 2500, assetRecoveryAmount: 1000, otherDeductionsAmount: 500, otherDeductionsNotes: 'Laptop not returned' });
  assert.equal(ctx.captured.gratuityAmount, 150000);
  assert.equal(ctx.captured.bonusAmount, 10000);
  assert.equal(ctx.captured.reimbursementsAmount, 2500);
  assert.equal(ctx.captured.assetRecoveryAmount, 1000);
  assert.equal(ctx.captured.otherDeductionsNotes, 'Laptop not returned');
});

test('generateSettlement computes finalPayable as totalEarnings minus totalDeductions', async () => {
  const ctx = {};
  Object.assign(ctx, { gratuity: { gratuityAmount: 50000, eligible: true }, loans: [{ outstanding_balance: 10000 }] });
  baseGenerateMocks(ctx);
  await fnf.generateSettlement(1, 9, { bonusAmount: 5000 });
  const expected = Math.round((ctx.captured.totalEarnings - ctx.captured.totalDeductions) * 100) / 100;
  assert.equal(ctx.captured.finalPayable, expected);
});

// ---------------------------------------------------------------------------
// Approval / payout workflow guards
// ---------------------------------------------------------------------------

test('submitSettlementForApproval only allows a draft settlement to move forward', async () => {
  mockDb('getFnfSettlement', async () => ({ id: 1, status: 'pending_approval' }));
  await assert.rejects(() => fnf.submitSettlementForApproval(1), /Only a draft settlement/);
});

test('decideSettlement only allows deciding a settlement that is pending_approval', async () => {
  mockDb('getFnfSettlement', async () => ({ id: 1, status: 'draft' }));
  await assert.rejects(() => fnf.decideSettlement(1, 'approved', 9), /not pending approval/);
});

test('markSettlementPaid only allows finalizing an approved settlement', async () => {
  mockDb('getFnfSettlement', async () => ({ id: 1, status: 'pending_approval' }));
  await assert.rejects(() => fnf.markSettlementPaid(1, 9), /Only an approved settlement/);
});
