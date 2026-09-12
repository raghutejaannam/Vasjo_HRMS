// src/leave.js — BLOCK 3: Advanced Leave Management
//
// The basic leave system (leave types, balances, single-approver apply/
// decide/cancel) already existed in db.js before this file. This module
// adds the "advanced" layer on top: per-employee/department policy
// overrides, eligibility waiting periods, sandwich-leave day counting,
// hour-based leave, comp-off, multi-level approval, monthly accrual,
// year-end carry-forward + expiry, and team leave calendar/conflict views.

const db = require('./db');
const { nowStr, todayStr } = require('./utils');

function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function daysBetweenInclusive(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00Z');
  const to = new Date(toStr + 'T00:00:00Z');
  return Math.round((to - from) / 86400000) + 1;
}

async function nextLeaveApplicationId() {
  // Mirrors the ID scheme the existing basic leave flow uses elsewhere in
  // db.js (short prefixed IDs) closely enough for our purposes without
  // depending on an internal counter — collisions are astronomically
  // unlikely and the column has no uniqueness requirement beyond primary key.
  return `LV${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
}

// ---------------------------------------------------------------------------
// POLICY RESOLUTION
// ---------------------------------------------------------------------------

async function getEffectiveLeavePolicy(userId, leaveTypeId) {
  const policy = await db.resolveLeavePolicy(userId, leaveTypeId);
  if (policy) {
    return {
      source: policy.user_id ? 'employee' : 'department',
      annualDays: policy.annual_days, accrualMethod: policy.accrual_method, monthlyAccrualDays: policy.monthly_accrual_days,
      carryForwardEnabled: !!policy.carry_forward_enabled, maxCarryForwardDays: policy.max_carry_forward_days,
      carryForwardExpiryMonths: policy.carry_forward_expiry_months, minServiceDaysBeforeEligible: policy.min_service_days_before_eligible,
      allowNegativeBalance: !!policy.allow_negative_balance, maxNegativeDays: policy.max_negative_days,
      isSandwichLeave: !!policy.is_sandwich_leave, unit: policy.unit,
    };
  }
  const leaveType = await db.getLeaveType(leaveTypeId);
  if (!leaveType) throw new Error('Leave type not found');
  return {
    source: 'default', annualDays: leaveType.default_annual_days, accrualMethod: 'annual', monthlyAccrualDays: null,
    carryForwardEnabled: (leaveType.max_carry_forward_days || 0) > 0, maxCarryForwardDays: leaveType.max_carry_forward_days || 0,
    carryForwardExpiryMonths: 3, minServiceDaysBeforeEligible: 0, allowNegativeBalance: false, maxNegativeDays: 0,
    isSandwichLeave: false, unit: 'day',
  };
}

// ---------------------------------------------------------------------------
// DAY COUNTING (sandwich-aware)
// ---------------------------------------------------------------------------

async function computeLeaveDayCount(from, to, halfDay, isSandwichLeave) {
  if (halfDay) return { days: 0.5, isSandwich: false };
  if (isSandwichLeave) {
    // Sandwich rule: weekends/holidays that fall WITHIN the requested range
    // count as leave too (as opposed to normal leave, which only counts
    // working days and skips non-working days inside the range).
    return { days: daysBetweenInclusive(from, to), isSandwich: true };
  }
  const [holidays, weeklyOffDays] = await Promise.all([db.getHolidaysInRange(from, to), db.getWeeklyOffDays()]);
  const holidaySet = new Set(holidays.map(h => h.holiday_date));
  let count = 0;
  const totalDays = daysBetweenInclusive(from, to);
  const start = new Date(from + 'T00:00:00Z');
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
    const dateStr = d.toISOString().slice(0, 10);
    const dow = d.getUTCDay();
    if (holidaySet.has(dateStr) || weeklyOffDays.includes(dow)) continue;
    count++;
  }
  return { days: count, isSandwich: false };
}

// ---------------------------------------------------------------------------
// ELIGIBILITY
// ---------------------------------------------------------------------------

async function checkEligibility(userId, leaveTypeId, policy) {
  if (!policy.minServiceDaysBeforeEligible) return;
  const user = await db.findUserById(userId);
  if (!user || !user.joined_date) return;
  const serviceDays = daysBetweenInclusive(user.joined_date, todayStr()) - 1;
  if (serviceDays < policy.minServiceDaysBeforeEligible) {
    throw new Error(`Not yet eligible for this leave type — requires ${policy.minServiceDaysBeforeEligible} days of service (${serviceDays} completed)`);
  }
}

// ---------------------------------------------------------------------------
// APPLY FOR LEAVE (advanced: policy-aware, sandwich, negative balance,
// hour-based, multi-level approval assignment)
// ---------------------------------------------------------------------------

async function applyForLeaveAdvanced({ userId, leaveTypeId, from, to, halfDay, hours, reason, requiredApprovalLevels }) {
  if (to < from) throw new Error('to date cannot be before from date');
  const policy = await getEffectiveLeavePolicy(userId, leaveTypeId);
  await checkEligibility(userId, leaveTypeId, policy);

  let days, unit = policy.unit, isSandwich = false;
  if (policy.unit === 'hour') {
    if (!(hours > 0)) throw new Error('hours is required for hour-based leave');
    days = hours;
  } else {
    const counted = await computeLeaveDayCount(from, to, halfDay, policy.isSandwichLeave);
    days = counted.days;
    isSandwich = counted.isSandwich;
  }
  if (days <= 0) throw new Error('The selected range contains no working days to apply leave for');

  const year = Number(from.slice(0, 4));
  const balance = await db.getLeaveBalanceRow(userId, leaveTypeId, year);
  const available = balance ? (Number(balance.total_days) + Number(balance.carried_forward_days || 0) - Number(balance.used_days)) : 0;
  const projectedRemaining = available - days;
  if (projectedRemaining < 0 && !policy.allowNegativeBalance) {
    throw new Error(`Insufficient leave balance — ${available} available, ${days} requested`);
  }
  if (projectedRemaining < 0 && policy.allowNegativeBalance && Math.abs(projectedRemaining) > policy.maxNegativeDays) {
    throw new Error(`This would exceed the maximum allowed negative balance of ${policy.maxNegativeDays} for this leave type`);
  }

  const levels = requiredApprovalLevels || (days > 5 ? 2 : 1); // longer leave defaults to a second approval level

  const id = await nextLeaveApplicationId();
  await db.dbRun(`
    INSERT INTO leave_applications (id, user_id, leave_type_id, from_date, to_date, days, unit, reason, applied_at, is_sandwich, required_approval_levels)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [id, userId, leaveTypeId, from, to, days, unit, reason || null, nowStr(), isSandwich ? 1 : 0, levels]);

  return { id, days, unit, isSandwich, requiredApprovalLevels: levels };
}

// ---------------------------------------------------------------------------
// MULTI-LEVEL APPROVAL
// ---------------------------------------------------------------------------

async function decideLeaveApplicationMultiLevel(applicationId, decision, actorId, comment) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const application = await db.getLeaveApplicationRow(applicationId);
  if (!application) throw new Error('Leave application not found');
  if (application.status !== 'pending') throw new Error('This leave application has already been decided');

  await db.createLeaveApproval({ leaveApplicationId: applicationId, level: application.current_approval_level, approverId: actorId, decision, comment });

  if (decision === 'rejected') {
    await db.dbRun(`UPDATE leave_applications SET status = 'rejected', decided_at = ?, decided_by = ?, last_comment = ? WHERE id = ?`,
      [nowStr(), actorId, comment || null, applicationId]);
    return { status: 'rejected' };
  }

  if (application.current_approval_level < application.required_approval_levels) {
    await db.advanceLeaveApprovalLevel(applicationId);
    return { status: 'pending', nextLevel: application.current_approval_level + 1 };
  }

  // Final level approved — commit the balance deduction (or comp-off redemption).
  return db.withTx(async (tx) => {
    const year = Number(application.from_date.slice(0, 4));
    if (application.comp_off_id) {
      await db.markCompOffUsed(application.comp_off_id, applicationId, tx);
    } else {
      const balance = await db.getLeaveBalanceRow(application.user_id, application.leave_type_id, year, tx);
      const newUsed = roundMoney((balance ? Number(balance.used_days) : 0) + Number(application.days));
      if (balance) await db.upsertLeaveBalance(application.user_id, application.leave_type_id, year, { used_days: newUsed }, tx);
      else await db.upsertLeaveBalance(application.user_id, application.leave_type_id, year, { total_days: 0, used_days: newUsed }, tx);
    }
    await db.dbRun(`UPDATE leave_applications SET status = 'approved', decided_at = ?, decided_by = ?, last_comment = ? WHERE id = ?`,
      [nowStr(), actorId, comment || null, applicationId], tx);
    return { status: 'approved' };
  });
}

// ---------------------------------------------------------------------------
// COMP-OFF
// ---------------------------------------------------------------------------

async function requestCompOff({ userId, workedDate, earnedDays, reason }) {
  if (!workedDate) throw new Error('workedDate is required');
  return db.createCompOffRequest({ userId, workedDate, earnedDays: earnedDays || 1, reason });
}

async function decideCompOffRequest(id, decision, actorId, expiryMonths) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const compOff = await db.getCompOff(id);
  if (!compOff) throw new Error('Comp-off request not found');
  if (compOff.status !== 'pending') throw new Error('This comp-off request has already been decided');
  await db.decideCompOff(id, decision, actorId, expiryMonths);
  return db.getCompOff(id);
}

const COMP_OFF_LEAVE_TYPE_NAME = 'Comp Off';

async function ensureCompOffLeaveType() {
  const types = await db.listLeaveTypes(false);
  const existing = types.find(t => t.name === COMP_OFF_LEAVE_TYPE_NAME);
  if (existing) return existing.id;
  return db.createLeaveType(COMP_OFF_LEAVE_TYPE_NAME, 0, 0);
}

async function redeemCompOff({ userId, compOffId, date }) {
  const compOff = await db.getCompOff(compOffId);
  if (!compOff) throw new Error('Comp-off credit not found');
  if (compOff.user_id !== userId) throw new Error('This comp-off credit does not belong to this employee');
  if (compOff.status !== 'approved') throw new Error('This comp-off credit is not available to redeem');
  if (compOff.expires_on && compOff.expires_on < todayStr()) throw new Error('This comp-off credit has expired');

  const leaveTypeId = await ensureCompOffLeaveType();
  const id = await nextLeaveApplicationId();
  const days = compOff.earned_days;
  await db.dbRun(`
    INSERT INTO leave_applications (id, user_id, leave_type_id, from_date, to_date, days, unit, reason, applied_at, comp_off_id, required_approval_levels)
    VALUES (?, ?, ?, ?, ?, ?, 'day', ?, ?, ?, 1)
  `, [id, userId, leaveTypeId, date, date, days, `Comp-off redemption for ${compOff.worked_date}`, nowStr(), compOffId]);

  return { id, days };
}

// ---------------------------------------------------------------------------
// MONTHLY ACCRUAL
// ---------------------------------------------------------------------------

async function runMonthlyAccrual(year, month) {
  const combos = await db.listActiveUsersWithLeaveType();
  let accrued = 0;
  for (const combo of combos) {
    const policy = await getEffectiveLeavePolicy(combo.user_id, combo.leave_type_id);
    if (policy.accrualMethod !== 'monthly' || !(policy.monthlyAccrualDays > 0)) continue;

    // Don't accrue leave for months before the employee joined.
    if (combo.joined_date) {
      const joinedYm = combo.joined_date.slice(0, 7);
      const targetYm = `${year}-${String(month).padStart(2, '0')}`;
      if (joinedYm > targetYm) continue;
    }

    const balance = await db.getLeaveBalanceRow(combo.user_id, combo.leave_type_id, year);
    const newTotal = roundMoney((balance ? Number(balance.total_days) : 0) + policy.monthlyAccrualDays);
    if (balance) await db.upsertLeaveBalance(combo.user_id, combo.leave_type_id, year, { total_days: newTotal });
    else await db.upsertLeaveBalance(combo.user_id, combo.leave_type_id, year, { total_days: newTotal, used_days: 0 });
    accrued++;
  }
  return { year, month, accrualsApplied: accrued };
}

// ---------------------------------------------------------------------------
// YEAR-END CARRY-FORWARD + EXPIRY
// ---------------------------------------------------------------------------

async function runYearEndCarryForward(fromYear, toYear) {
  const combos = await db.listActiveUsersWithLeaveType();
  let processed = 0;
  for (const combo of combos) {
    const policy = await getEffectiveLeavePolicy(combo.user_id, combo.leave_type_id);
    if (!policy.carryForwardEnabled) continue;

    const fromBalance = await db.getLeaveBalanceRow(combo.user_id, combo.leave_type_id, fromYear);
    if (!fromBalance) continue;
    const unused = roundMoney(Number(fromBalance.total_days) + Number(fromBalance.carried_forward_days || 0) - Number(fromBalance.used_days));
    if (unused <= 0) continue;
    const carryForward = Math.min(unused, policy.maxCarryForwardDays);
    if (carryForward <= 0) continue;

    const expiresOn = new Date(Date.UTC(toYear, 0, 1));
    expiresOn.setUTCMonth(expiresOn.getUTCMonth() + policy.carryForwardExpiryMonths);
    const expiresOnStr = expiresOn.toISOString().slice(0, 10);

    const toBalance = await db.getLeaveBalanceRow(combo.user_id, combo.leave_type_id, toYear);
    const baseTotal = toBalance ? Number(toBalance.total_days) : policy.annualDays;
    await db.upsertLeaveBalance(combo.user_id, combo.leave_type_id, toYear, {
      total_days: roundMoney(baseTotal + carryForward), carried_forward_days: carryForward, carry_forward_expires_on: expiresOnStr,
    });
    processed++;
  }
  return { fromYear, toYear, employeesProcessed: processed };
}

// Deducts any carried-forward days that expired without being used. Assumes
// carry-forward is drawn down first (a common, simple convention) — if
// used_days hasn't yet consumed the full carried-forward amount by the
// expiry date, the unused remainder is removed from the balance.
async function expireCarriedForwardLeave(asOfDate) {
  const today = asOfDate || todayStr();
  const stale = await db.dbAll(`
    SELECT * FROM leave_balances WHERE carried_forward_days > 0 AND carry_forward_expires_on IS NOT NULL AND carry_forward_expires_on < ?
  `, [today]);
  let expired = 0;
  for (const bal of stale) {
    const unusedCarryForward = Math.max(0, Number(bal.carried_forward_days) - Number(bal.used_days));
    if (unusedCarryForward <= 0) { await db.upsertLeaveBalance(bal.user_id, bal.leave_type_id, bal.year, { carried_forward_days: 0 }); continue; }
    const newTotal = roundMoney(Number(bal.total_days) - unusedCarryForward);
    await db.upsertLeaveBalance(bal.user_id, bal.leave_type_id, bal.year, { total_days: Math.max(0, newTotal), carried_forward_days: 0 });
    expired++;
  }
  return { expiredCount: expired };
}

// ---------------------------------------------------------------------------
// TEAM LEAVE CALENDAR / CONFLICT DETECTION
// ---------------------------------------------------------------------------

async function getTeamLeaveCalendar(userIds, from, to) {
  return db.getLeaveCalendarRange(userIds, from, to);
}

async function getLeaveConflicts(userIds, from, to, excludeApplicationId) {
  return db.countOverlappingApprovedLeave(userIds, from, to, excludeApplicationId);
}

module.exports = {
  getEffectiveLeavePolicy,
  computeLeaveDayCount,
  checkEligibility,
  applyForLeaveAdvanced,
  decideLeaveApplicationMultiLevel,
  requestCompOff,
  decideCompOffRequest,
  redeemCompOff,
  runMonthlyAccrual,
  runYearEndCarryForward,
  expireCarriedForwardLeave,
  getTeamLeaveCalendar,
  getLeaveConflicts,
};
