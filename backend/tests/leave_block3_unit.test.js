// tests/leave_block3_unit.test.js
//
// Offline unit tests for Block 3 (Advanced Leave Management). Same approach
// as the other *_unit.test.js files: db.js functions are monkey-patched per
// test, no real database or network needed.
//
// Run with:  node --test tests/leave_block3_unit.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const leave = require('../src/leave');

let patched = [];
function mock(name, fn) { patched.push([name, db[name]]); db[name] = fn; }
afterEach(() => {
  for (const [name, original] of patched) db[name] = original;
  patched = [];
});

// ---------------------------------------------------------------------------
// Policy resolution
// ---------------------------------------------------------------------------

test('getEffectiveLeavePolicy prefers an employee-specific policy over department or default', async () => {
  mock('resolveLeavePolicy', async () => ({
    user_id: 5, annual_days: 30, accrual_method: 'annual', carry_forward_enabled: 1, max_carry_forward_days: 10,
    carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 0, max_negative_days: 0,
    is_sandwich_leave: 0, unit: 'day',
  }));
  const policy = await leave.getEffectiveLeavePolicy(5, 1);
  assert.equal(policy.source, 'employee');
  assert.equal(policy.annualDays, 30);
});

test('getEffectiveLeavePolicy falls back to the leave type defaults when no policy row exists', async () => {
  mock('resolveLeavePolicy', async () => null);
  mock('getLeaveType', async () => ({ default_annual_days: 12, max_carry_forward_days: 0 }));
  const policy = await leave.getEffectiveLeavePolicy(5, 1);
  assert.equal(policy.source, 'default');
  assert.equal(policy.annualDays, 12);
  assert.equal(policy.carryForwardEnabled, false);
});

// ---------------------------------------------------------------------------
// Day counting
// ---------------------------------------------------------------------------

test('computeLeaveDayCount returns 0.5 for a half-day request regardless of policy', async () => {
  const result = await leave.computeLeaveDayCount('2026-06-01', '2026-06-01', true, false);
  assert.equal(result.days, 0.5);
});

test('computeLeaveDayCount skips weekends and holidays within the range under the normal (non-sandwich) rule', async () => {
  mock('getHolidaysInRange', async () => [{ holiday_date: '2026-06-03' }]); // Wednesday holiday
  mock('getWeeklyOffDays', async () => [0, 6]);
  // Mon 06-01 .. Sun 06-07: business days are Mon,Tue,Thu,Fri (Wed is holiday, Sat/Sun weekend) = 4
  const result = await leave.computeLeaveDayCount('2026-06-01', '2026-06-07', false, false);
  assert.equal(result.days, 4);
  assert.equal(result.isSandwich, false);
});

test('computeLeaveDayCount counts every calendar day under the sandwich rule', async () => {
  const result = await leave.computeLeaveDayCount('2026-06-01', '2026-06-07', false, true);
  assert.equal(result.days, 7); // all 7 days count, including the weekend
  assert.equal(result.isSandwich, true);
});

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

test('checkEligibility rejects an application before the policy waiting period has elapsed', async () => {
  const today = new Date().toISOString().slice(0, 10);
  mock('findUserById', async () => ({ joined_date: today })); // joined today
  await assert.rejects(
    () => leave.checkEligibility(1, 1, { minServiceDaysBeforeEligible: 90 }),
    /Not yet eligible/
  );
});

test('checkEligibility passes when there is no waiting period configured', async () => {
  await leave.checkEligibility(1, 1, { minServiceDaysBeforeEligible: 0 }); // should not throw, no db calls needed
});

// ---------------------------------------------------------------------------
// Apply for leave (advanced)
// ---------------------------------------------------------------------------

function mockApplyBasics(overrides = {}) {
  mock('resolveLeavePolicy', async () => overrides.policy || null);
  mock('getLeaveType', async () => ({ default_annual_days: 12, max_carry_forward_days: 0 }));
  mock('findUserById', async () => ({ joined_date: '2020-01-01' }));
  mock('getHolidaysInRange', async () => []);
  mock('getWeeklyOffDays', async () => [0, 6]);
  mock('getLeaveBalanceRow', async () => overrides.balance !== undefined ? overrides.balance : { total_days: 12, used_days: 0, carried_forward_days: 0 });
  mock('dbRun', async () => {});
}

test('applyForLeaveAdvanced rejects a to-date before the from-date', async () => {
  await assert.rejects(
    () => leave.applyForLeaveAdvanced({ userId: 1, leaveTypeId: 1, from: '2026-06-10', to: '2026-06-01' }),
    /cannot be before/
  );
});

test('applyForLeaveAdvanced rejects when balance is insufficient and negative balance is not allowed', async () => {
  mockApplyBasics({ balance: { total_days: 2, used_days: 0, carried_forward_days: 0 } });
  await assert.rejects(
    () => leave.applyForLeaveAdvanced({ userId: 1, leaveTypeId: 1, from: '2026-06-01', to: '2026-06-05' }), // 5 business days (Mon-Fri)
    /Insufficient leave balance/
  );
});

test('applyForLeaveAdvanced allows going negative up to the policy cap when negative balance is enabled', async () => {
  mockApplyBasics({
    policy: { user_id: 1, annual_days: 12, accrual_method: 'annual', carry_forward_enabled: 0, max_carry_forward_days: 0, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 1, max_negative_days: 3, is_sandwich_leave: 0, unit: 'day' },
    balance: { total_days: 2, used_days: 0, carried_forward_days: 0 },
  });
  const result = await leave.applyForLeaveAdvanced({ userId: 1, leaveTypeId: 1, from: '2026-06-01', to: '2026-06-03' }); // 3 business days, balance 2 -> -1, within cap of 3
  assert.equal(result.days, 3);
});

test('applyForLeaveAdvanced rejects when negative balance would exceed the policy cap', async () => {
  mockApplyBasics({
    policy: { user_id: 1, annual_days: 12, accrual_method: 'annual', carry_forward_enabled: 0, max_carry_forward_days: 0, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 1, max_negative_days: 1, is_sandwich_leave: 0, unit: 'day' },
    balance: { total_days: 0, used_days: 0, carried_forward_days: 0 },
  });
  await assert.rejects(
    () => leave.applyForLeaveAdvanced({ userId: 1, leaveTypeId: 1, from: '2026-06-01', to: '2026-06-05' }), // 5 days requested, cap only allows 1 negative
    /maximum allowed negative balance/
  );
});

test('applyForLeaveAdvanced supports hour-based leave using the hours field', async () => {
  mockApplyBasics({
    policy: { user_id: 1, annual_days: 40, accrual_method: 'annual', carry_forward_enabled: 0, max_carry_forward_days: 0, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 0, max_negative_days: 0, is_sandwich_leave: 0, unit: 'hour' },
    balance: { total_days: 40, used_days: 0, carried_forward_days: 0 },
  });
  const result = await leave.applyForLeaveAdvanced({ userId: 1, leaveTypeId: 1, from: '2026-06-01', to: '2026-06-01', hours: 4 });
  assert.equal(result.unit, 'hour');
  assert.equal(result.days, 4);
});

test('applyForLeaveAdvanced defaults to a second approval level for requests longer than 5 days', async () => {
  mockApplyBasics({ balance: { total_days: 20, used_days: 0, carried_forward_days: 0 } });
  const result = await leave.applyForLeaveAdvanced({ userId: 1, leaveTypeId: 1, from: '2026-06-01', to: '2026-06-10' }); // > 5 business days
  assert.equal(result.requiredApprovalLevels, 2);
});

// ---------------------------------------------------------------------------
// Multi-level approval
// ---------------------------------------------------------------------------

test('decideLeaveApplicationMultiLevel refuses to decide an already-decided application', async () => {
  mock('getLeaveApplicationRow', async () => ({ status: 'approved' }));
  await assert.rejects(() => leave.decideLeaveApplicationMultiLevel('LV1', 'approved', 9), /already been decided/);
});

test('decideLeaveApplicationMultiLevel rejects immediately without advancing levels', async () => {
  mock('getLeaveApplicationRow', async () => ({ status: 'pending', current_approval_level: 1, required_approval_levels: 2 }));
  mock('createLeaveApproval', async () => {});
  let advanced = false;
  mock('advanceLeaveApprovalLevel', async () => { advanced = true; });
  mock('dbRun', async () => {});
  const result = await leave.decideLeaveApplicationMultiLevel('LV1', 'rejected', 9, 'not enough coverage');
  assert.equal(result.status, 'rejected');
  assert.equal(advanced, false);
});

test('decideLeaveApplicationMultiLevel advances to the next level on approval when more levels remain', async () => {
  mock('getLeaveApplicationRow', async () => ({ status: 'pending', current_approval_level: 1, required_approval_levels: 2 }));
  mock('createLeaveApproval', async () => {});
  let advanced = false;
  mock('advanceLeaveApprovalLevel', async () => { advanced = true; });
  const result = await leave.decideLeaveApplicationMultiLevel('LV1', 'approved', 9);
  assert.equal(result.status, 'pending');
  assert.equal(result.nextLevel, 2);
  assert.equal(advanced, true);
});

test('decideLeaveApplicationMultiLevel commits the balance deduction on final-level approval', async () => {
  mock('getLeaveApplicationRow', async () => ({ id: 'LV1', status: 'pending', current_approval_level: 2, required_approval_levels: 2, user_id: 1, leave_type_id: 1, from_date: '2026-06-01', days: 3, comp_off_id: null }));
  mock('createLeaveApproval', async () => {});
  mock('getLeaveBalanceRow', async () => ({ id: 1, total_days: 12, used_days: 2 }));
  let capturedUsed;
  mock('upsertLeaveBalance', async (userId, leaveTypeId, year, data) => { capturedUsed = data.used_days; });
  mock('dbRun', async () => {});
  const result = await leave.decideLeaveApplicationMultiLevel('LV1', 'approved', 9);
  assert.equal(result.status, 'approved');
  assert.equal(capturedUsed, 5); // 2 + 3
});

// ---------------------------------------------------------------------------
// Comp-off
// ---------------------------------------------------------------------------

test('decideCompOffRequest refuses to re-decide', async () => {
  mock('getCompOff', async () => ({ status: 'approved' }));
  await assert.rejects(() => leave.decideCompOffRequest(1, 'approved', 9), /already been decided/);
});

test('redeemCompOff refuses a credit belonging to a different employee', async () => {
  mock('getCompOff', async () => ({ user_id: 2, status: 'approved' }));
  await assert.rejects(() => leave.redeemCompOff({ userId: 1, compOffId: 1, date: '2026-06-01' }), /does not belong/);
});

test('redeemCompOff refuses an expired credit', async () => {
  mock('getCompOff', async () => ({ user_id: 1, status: 'approved', expires_on: '2020-01-01' }));
  await assert.rejects(() => leave.redeemCompOff({ userId: 1, compOffId: 1, date: '2026-06-01' }), /expired/);
});

test('redeemCompOff refuses a credit that is not in approved status', async () => {
  mock('getCompOff', async () => ({ user_id: 1, status: 'pending' }));
  await assert.rejects(() => leave.redeemCompOff({ userId: 1, compOffId: 1, date: '2026-06-01' }), /not available to redeem/);
});

// ---------------------------------------------------------------------------
// Monthly accrual
// ---------------------------------------------------------------------------

test('runMonthlyAccrual only accrues for user/leave-type combos on a monthly-accrual policy', async () => {
  mock('listActiveUsersWithLeaveType', async () => ([
    { user_id: 1, dept: 'Eng', joined_date: '2020-01-01', leave_type_id: 1, default_annual_days: 12 },
    { user_id: 1, dept: 'Eng', joined_date: '2020-01-01', leave_type_id: 2, default_annual_days: 12 },
  ]));
  mock('resolveLeavePolicy', async (userId, leaveTypeId) => {
    if (leaveTypeId === 1) return { user_id: 1, annual_days: 12, accrual_method: 'monthly', monthly_accrual_days: 1, carry_forward_enabled: 0, max_carry_forward_days: 0, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 0, max_negative_days: 0, is_sandwich_leave: 0, unit: 'day' };
    return null; // leave type 2 has no policy -> defaults to 'annual' accrual, should be skipped
  });
  mock('getLeaveType', async () => ({ default_annual_days: 12, max_carry_forward_days: 0 }));
  mock('getLeaveBalanceRow', async () => ({ total_days: 5, used_days: 0 }));
  let upserted = 0;
  mock('upsertLeaveBalance', async () => { upserted++; });

  const result = await leave.runMonthlyAccrual(2026, 6);
  assert.equal(result.accrualsApplied, 1);
  assert.equal(upserted, 1);
});

test('runMonthlyAccrual skips months before the employee joined', async () => {
  mock('listActiveUsersWithLeaveType', async () => ([
    { user_id: 1, dept: 'Eng', joined_date: '2026-08-01', leave_type_id: 1, default_annual_days: 12 },
  ]));
  mock('resolveLeavePolicy', async () => ({ user_id: 1, annual_days: 12, accrual_method: 'monthly', monthly_accrual_days: 1, carry_forward_enabled: 0, max_carry_forward_days: 0, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 0, max_negative_days: 0, is_sandwich_leave: 0, unit: 'day' }));
  let upserted = 0;
  mock('upsertLeaveBalance', async () => { upserted++; });

  const result = await leave.runMonthlyAccrual(2026, 6); // joined August, running for June
  assert.equal(result.accrualsApplied, 0);
  assert.equal(upserted, 0);
});

// ---------------------------------------------------------------------------
// Carry-forward + expiry
// ---------------------------------------------------------------------------

test('runYearEndCarryForward caps the carried-forward amount at the policy maximum', async () => {
  mock('listActiveUsersWithLeaveType', async () => ([{ user_id: 1, dept: 'Eng', joined_date: '2020-01-01', leave_type_id: 1, default_annual_days: 12 }]));
  mock('resolveLeavePolicy', async () => ({ user_id: 1, annual_days: 12, accrual_method: 'annual', carry_forward_enabled: 1, max_carry_forward_days: 5, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 0, max_negative_days: 0, is_sandwich_leave: 0, unit: 'day' }));
  mock('getLeaveBalanceRow', async (userId, typeId, year) => {
    if (year === 2026) return { total_days: 12, used_days: 2, carried_forward_days: 0 }; // 10 unused
    return null; // no 2027 balance yet
  });
  let captured;
  mock('upsertLeaveBalance', async (userId, typeId, year, data) => { captured = data; });

  await leave.runYearEndCarryForward(2026, 2027);
  assert.equal(captured.carried_forward_days, 5); // capped, even though 10 was unused
  assert.equal(captured.total_days, 17); // 12 default annual + 5 carried forward
});

test('runYearEndCarryForward skips employees with no carry-forward policy', async () => {
  mock('listActiveUsersWithLeaveType', async () => ([{ user_id: 1, dept: 'Eng', joined_date: '2020-01-01', leave_type_id: 1, default_annual_days: 12 }]));
  mock('resolveLeavePolicy', async () => ({ user_id: 1, annual_days: 12, accrual_method: 'annual', carry_forward_enabled: 0, max_carry_forward_days: 0, carry_forward_expiry_months: 3, min_service_days_before_eligible: 0, allow_negative_balance: 0, max_negative_days: 0, is_sandwich_leave: 0, unit: 'day' }));
  mock('getLeaveBalanceRow', async () => { throw new Error('should not be queried when carry-forward is disabled'); });
  const result = await leave.runYearEndCarryForward(2026, 2027);
  assert.equal(result.employeesProcessed, 0);
});

test('expireCarriedForwardLeave deducts unused carried-forward days past their expiry', async () => {
  mock('dbAll', async () => ([
    { user_id: 1, leave_type_id: 1, year: 2027, total_days: 17, used_days: 2, carried_forward_days: 5, carry_forward_expires_on: '2027-04-01' },
  ]));
  let captured;
  mock('upsertLeaveBalance', async (userId, typeId, year, data) => { captured = data; });

  const result = await leave.expireCarriedForwardLeave('2027-05-01');
  assert.equal(result.expiredCount, 1);
  assert.equal(captured.total_days, 14); // 17 - (5 unused carry-forward, since used_days 2 < carried 5)
  assert.equal(captured.carried_forward_days, 0);
});

test('expireCarriedForwardLeave leaves the total untouched if carry-forward was already fully used', async () => {
  mock('dbAll', async () => ([
    { user_id: 1, leave_type_id: 1, year: 2027, total_days: 17, used_days: 6, carried_forward_days: 5, carry_forward_expires_on: '2027-04-01' },
  ]));
  let captured;
  mock('upsertLeaveBalance', async (userId, typeId, year, data) => { captured = data; });

  await leave.expireCarriedForwardLeave('2027-05-01');
  assert.equal(captured.carried_forward_days, 0);
  assert.equal('total_days' in captured, false); // total untouched — no unused carry-forward to claw back
});
