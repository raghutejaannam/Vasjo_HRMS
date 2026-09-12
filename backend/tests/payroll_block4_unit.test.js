// tests/payroll_block4_unit.test.js
//
// Offline unit tests for the Block 4 (Advanced Payroll Engine) additions:
// formula/conditional salary components, employee loans, salary advances,
// leave encashment, retroactive-revision arrears, gratuity estimation, and
// the month-to-month comparison/variance reports.
//
// Unlike tests/regression.test.js, this file needs NO real PostgreSQL
// database and NO network access — it drives payroll.js directly and
// monkey-patches the handful of db.js functions each test touches (db.js
// exports a shared object, so reassigning a property on it here is visible
// to payroll.js, which required the same module instance).
//
// Run with:  node --test tests/payroll_block4_unit.test.js
// (from backend/, after `npm install`; a `@prisma/client`/`dotenv` stub is
// NOT needed once real dependencies are installed — this file works either
// way since it never lets a real query run.)

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const payroll = require('../src/payroll');
const utils = require('../src/utils');

// Keeps track of which db.* functions each test overrides so we can restore
// the originals afterwards and tests can't leak mocks into one another.
let patched = [];
function mock(name, fn) {
  patched.push([name, db[name]]);
  db[name] = fn;
}
afterEach(() => {
  for (const [name, original] of patched) db[name] = original;
  patched = [];
});

// ---------------------------------------------------------------------------
// Formula / conditional salary component evaluation
// ---------------------------------------------------------------------------

test('evaluateArithmeticFormula supports +-*/ and parentheses with variables', () => {
  assert.equal(utils.evaluateArithmeticFormula('monthlyBasic*0.4 + 500', { monthlyBasic: 40000 }), 16500);
  assert.equal(utils.evaluateArithmeticFormula('(monthlyBasic + 1000) / 2', { monthlyBasic: 40000 }), 20500);
});

test('evaluateArithmeticFormula rejects unknown variables and malformed input', () => {
  assert.throws(() => utils.evaluateArithmeticFormula('unknownVar * 2', { monthlyBasic: 1 }), /Unknown variable/);
  assert.throws(() => utils.evaluateArithmeticFormula('1 + ', {}), /formula/i);
});

test('evaluateConditionalRule picks thenValue/elseValue per operator', () => {
  const rule = { variable: 'monthlyBasic', operator: '>', threshold: 50000, thenValue: 2000, elseValue: 1000 };
  assert.equal(utils.evaluateConditionalRule(rule, { monthlyBasic: 60000 }), 2000);
  assert.equal(utils.evaluateConditionalRule(rule, { monthlyBasic: 40000 }), 1000);
});

// ---------------------------------------------------------------------------
// EMI calculation
// ---------------------------------------------------------------------------

test('computeEmi matches reducing-balance EMI formula, and is a plain split at 0% interest', () => {
  assert.equal(utils.computeEmi(120000, 12, 12), 10661.85);
  assert.equal(utils.computeEmi(120000, 0, 12), 10000);
  assert.equal(utils.computeEmi(0, 12, 12), 0);
});

// ---------------------------------------------------------------------------
// Gratuity (Payment of Gratuity Act, 1972 convention)
// ---------------------------------------------------------------------------

test('calculateGratuity: not eligible before 5 completed years of service', async () => {
  mock('findUserById', async () => ({ id: 1, joined_date: '2023-01-01' }));
  mock('getActiveFinancialYear', async () => ({ id: 1 }));
  mock('getSalaryStructureAsOf', async () => ({ id: 10 }));
  mock('getStructureComponents', async () => [{ code: 'BASIC', amount: 50000 }]);

  const result = await payroll.calculateGratuity(1, null, '2026-06-01');
  assert.equal(result.eligible, false);
  assert.equal(result.gratuityAmount, 0);
});

test('calculateGratuity: eligible employee gets (basic*15*years)/26, capped at the statutory ceiling', async () => {
  mock('findUserById', async () => ({ id: 2, joined_date: '2015-01-01' }));
  mock('getActiveFinancialYear', async () => ({ id: 1 }));
  mock('getSalaryStructureAsOf', async () => ({ id: 11 }));
  mock('getStructureComponents', async () => [{ code: 'BASIC', amount: 60000 }]);

  const result = await payroll.calculateGratuity(2, null, '2026-06-01');
  assert.equal(result.eligible, true);
  assert.equal(result.yearsOfService, 11);
  const expectedRaw = Math.round(((60000 * 15 * 11) / 26) * 100) / 100;
  assert.equal(result.rawAmount, expectedRaw);
  assert.equal(result.gratuityAmount, Math.min(expectedRaw, 2000000));
});

test('calculateGratuity: very long tenure at a high basic is capped at the statutory ceiling', async () => {
  mock('findUserById', async () => ({ id: 3, joined_date: '1995-01-01' }));
  mock('getActiveFinancialYear', async () => ({ id: 1 }));
  mock('getSalaryStructureAsOf', async () => ({ id: 12 }));
  mock('getStructureComponents', async () => [{ code: 'BASIC', amount: 300000 }]);

  const result = await payroll.calculateGratuity(3, null, '2026-06-01');
  assert.equal(result.statutoryCapApplied, true);
  assert.equal(result.gratuityAmount, 2000000);
});

// ---------------------------------------------------------------------------
// Loan / advance request validation
// ---------------------------------------------------------------------------

test('requestLoan rejects non-positive principal or tenure', async () => {
  await assert.rejects(() => payroll.requestLoan({ userId: 1, principalAmount: 0, tenureMonths: 6 }), /Principal amount/);
  await assert.rejects(() => payroll.requestLoan({ userId: 1, principalAmount: 1000, tenureMonths: 0 }), /Tenure/);
});

test('requestLoan creates a pending loan row via db.createLoan', async () => {
  let captured;
  mock('createLoan', async (data) => { captured = data; return 42; });
  const id = await payroll.requestLoan({ userId: 5, principalAmount: 50000, interestRateAnnual: 10, tenureMonths: 10, purpose: 'Medical' });
  assert.equal(id, 42);
  assert.equal(captured.userId, 5);
  assert.equal(captured.principalAmount, 50000);
});

test('decideLoanRequest refuses to re-decide an already-decided loan', async () => {
  mock('getLoan', async () => ({ id: 1, status: 'approved' }));
  await assert.rejects(() => payroll.decideLoanRequest(1, 'approved', 99), /already been decided/);
});

test('disburseLoanFull computes and stores the EMI, only from approved status', async () => {
  mock('getLoan', async (id) => ({ id, status: 'approved', principal_amount: 120000, interest_rate_annual: 12, tenure_months: 12 }));
  let disbursedEmi;
  mock('disburseLoan', async (id, emi) => { disbursedEmi = emi; });
  mock('logPayrollAudit', async () => {});
  await payroll.disburseLoanFull(1, 99);
  assert.equal(disbursedEmi, 10661.85);
});

test('requestSalaryAdvance rejects non-positive amount', async () => {
  await assert.rejects(() => payroll.requestSalaryAdvance({ userId: 1, amount: 0 }), /greater than zero/);
});

// ---------------------------------------------------------------------------
// Leave encashment
// ---------------------------------------------------------------------------

test('requestLeaveEncashment blocks encashing more days than available balance', async () => {
  mock('getFinancialYear', async () => ({ id: 1, start_date: '2025-04-01' }));
  mock('dbGet', async () => ({ total_days: 12, used_days: 10 })); // 2 days available
  await assert.rejects(
    () => payroll.requestLeaveEncashment({ userId: 1, leaveTypeId: 1, financialYearId: 1, days: 5 }),
    /Only 2 day\(s\) available/
  );
});

test('requestLeaveEncashment computes amount as (monthlyBasic/26)*days', async () => {
  mock('getFinancialYear', async () => ({ id: 1, start_date: '2025-04-01' }));
  mock('dbGet', async () => ({ total_days: 12, used_days: 2 }));
  mock('getActiveSalaryStructure', async () => ({ id: 7 }));
  mock('getStructureComponents', async () => [{ code: 'BASIC', amount: 52000 }]);
  mock('createLeaveEncashmentRequest', async () => ({ lastInsertRowid: 501 }));

  const result = await payroll.requestLeaveEncashment({ userId: 1, leaveTypeId: 1, financialYearId: 1, days: 4 });
  assert.equal(result.perDayAmount, 2000); // 52000/26
  assert.equal(result.amount, 8000);
});

// ---------------------------------------------------------------------------
// Arrears from retroactive salary revisions
// ---------------------------------------------------------------------------

test('generateArrearsForRetroactiveRevision creates one row per already-settled month, prorated by paid/working days', async () => {
  mock('listSettledPayrollMonthsForUser', async () => ([
    { payroll_month: '2026-04', paid_days: 22, working_days: 22 },
    { payroll_month: '2026-05', paid_days: 20, working_days: 22 }, // some LOP that month
  ]));
  const created = [];
  mock('createArrearsPayment', async (data) => { created.push(data); return { lastInsertRowid: created.length }; });

  const result = await payroll.generateArrearsForRetroactiveRevision({
    userId: 1, financialYearId: 1, effectiveDate: '2026-04-01',
    previousMonthlyCtc: 80000, newMonthlyCtc: 90000, revisionId: 77, tx: {},
  });

  assert.equal(result.length, 2);
  assert.equal(result[0].amount, 10000); // full ratio
  assert.equal(result[1].amount, Math.round(10000 * (20 / 22) * 100) / 100);
  assert.equal(created[0].salaryRevisionId, 77);
});

test('generateArrearsForRetroactiveRevision is a no-op when CTC did not actually change', async () => {
  mock('listSettledPayrollMonthsForUser', async () => { throw new Error('should not be called when delta is 0'); });
  const result = await payroll.generateArrearsForRetroactiveRevision({
    userId: 1, financialYearId: 1, effectiveDate: '2026-04-01',
    previousMonthlyCtc: 80000, newMonthlyCtc: 80000, revisionId: 1, tx: {},
  });
  assert.deepEqual(result, []);
});

// ---------------------------------------------------------------------------
// Month-to-month comparison & variance report
// ---------------------------------------------------------------------------

test('comparePayrollMonths totals both months and flags employees present in only one', async () => {
  mock('getPayrollDetailsByMonth', async (fyId, month) => {
    if (month === '2026-04') return [
      { user_id: 1, user_name: 'Asha', gross_earning: 80000, net_salary: 70000, tds_deduction: 5000 },
      { user_id: 2, user_name: 'Ravi', gross_earning: 60000, net_salary: 52000, tds_deduction: 3000 },
    ];
    return [
      { user_id: 1, user_name: 'Asha', gross_earning: 88000, net_salary: 76000, tds_deduction: 5500 },
      { user_id: 3, user_name: 'Priya', gross_earning: 50000, net_salary: 45000, tds_deduction: 1000 },
    ];
  });

  const cmp = await payroll.comparePayrollMonths(1, '2026-04', '2026-05');
  assert.equal(cmp.totals.grossA, 140000);
  assert.equal(cmp.totals.grossB, 138000);
  const asha = cmp.employees.find(e => e.userId === 1);
  assert.equal(asha.grossDelta, 8000);
  const ravi = cmp.employees.find(e => e.userId === 2);
  assert.equal(ravi.presentInB, false);
  const priya = cmp.employees.find(e => e.userId === 3);
  assert.equal(priya.presentInA, false);
});

test('payrollVarianceReport flags only employees present in both months whose net changed beyond the threshold', async () => {
  mock('getPayrollDetailsByMonth', async (fyId, month) => {
    if (month === '2026-04') return [
      { user_id: 1, user_name: 'Asha', gross_earning: 80000, net_salary: 70000, tds_deduction: 5000 },
      { user_id: 2, user_name: 'Ravi', gross_earning: 60000, net_salary: 52000, tds_deduction: 3000 },
    ];
    return [
      { user_id: 1, user_name: 'Asha', gross_earning: 88000, net_salary: 84000, tds_deduction: 5500 }, // +20% net
      { user_id: 2, user_name: 'Ravi', gross_earning: 60500, net_salary: 52200, tds_deduction: 3000 }, // ~0.4% net
    ];
  });

  const report = await payroll.payrollVarianceReport(1, '2026-04', '2026-05', 10);
  assert.equal(report.flagged.length, 1);
  assert.equal(report.flagged[0].userId, 1);
});

console.log('payroll_block4_unit.test.js loaded — run with `node --test tests/payroll_block4_unit.test.js`');
