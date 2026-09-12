// src/attendance.js — BLOCK 2: Advanced Attendance Management
//
// Daily check-in/check-out, shift assignment, attendance correction
// ("regularization") requests, the monthly attendance calendar, and the
// summary payroll.js consumes for loss-of-pay (LOP) calculation.
//
// Deliberately requires only db.js and utils.js (not payroll.js), so
// payroll.js can safely require this module without a circular dependency.

const db = require('./db');
const { nowStr, todayStr } = require('./utils');

function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function daysInMonthUTC(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function minutesBetween(aStr, bStr) {
  // Both are 'YYYY-MM-DD HH:MM:SS' UTC strings (see utils.nowStr).
  const a = new Date(aStr.replace(' ', 'T') + 'Z');
  const b = new Date(bStr.replace(' ', 'T') + 'Z');
  return Math.round((b - a) / 60000);
}

function minutesSinceMidnight(timeHHMM) {
  const [h, m] = String(timeHHMM).split(':').map(Number);
  return h * 60 + m;
}

// ---------------------------------------------------------------------------
// SHIFTS
// ---------------------------------------------------------------------------

async function createShift(data) {
  if (!data.code || !data.name || !data.startTime || !data.endTime) {
    throw new Error('code, name, startTime and endTime are required');
  }
  return db.createShift(data);
}

async function assignShift({ userId, shiftId, effectiveFrom, createdBy }) {
  const shift = await db.getShift(shiftId);
  if (!shift) throw new Error('Shift not found');
  return db.assignShift(userId, shiftId, effectiveFrom || todayStr(), createdBy);
}

async function resolveShiftForUser(userId, date) {
  const assigned = await db.getShiftForUserOnDate(userId, date);
  if (assigned) return assigned;
  // No explicit assignment — fall back to whichever active shift was
  // created first, so a freshly-seeded company always has a working
  // default instead of every check-in failing for lack of a shift.
  const shifts = await db.listShifts(true);
  return shifts[0] || null;
}

// ---------------------------------------------------------------------------
// CHECK-IN / CHECK-OUT
// ---------------------------------------------------------------------------

async function checkIn(userId, timestamp) {
  timestamp = timestamp || nowStr();
  const date = timestamp.slice(0, 10);
  const existing = await db.getAttendanceRecord(userId, date);
  if (existing && existing.check_in_at) throw new Error('Already checked in today');

  const shift = await resolveShiftForUser(userId, date);
  let lateMinutes = 0;
  if (shift) {
    const shiftStartMinutes = minutesSinceMidnight(shift.start_time);
    const [, hh, mm] = timestamp.match(/(\d{2}):(\d{2}):\d{2}$/) || [null, '00', '00'];
    const checkInMinutes = Number(hh) * 60 + Number(mm);
    lateMinutes = Math.max(0, checkInMinutes - shiftStartMinutes - (shift.grace_period_minutes || 0));
  }

  await db.upsertAttendanceRecord({
    userId, date, shiftId: shift ? shift.id : null, checkInAt: timestamp,
    status: 'present', workedMinutes: 0, lateMinutes, earlyLeaveMinutes: 0, source: 'check_in_out',
  });
  return { date, checkInAt: timestamp, lateMinutes, shift: shift ? shift.code : null };
}

async function checkOut(userId, timestamp) {
  timestamp = timestamp || nowStr();
  const date = timestamp.slice(0, 10);
  const existing = await db.getAttendanceRecord(userId, date);
  if (!existing || !existing.check_in_at) throw new Error('No check-in found for today — check in first');
  if (existing.check_out_at) throw new Error('Already checked out today');

  const shift = existing.shift_id ? await db.getShift(existing.shift_id) : await resolveShiftForUser(userId, date);
  const grossMinutes = Math.max(0, minutesBetween(existing.check_in_at, timestamp));
  const workedMinutes = Math.max(0, grossMinutes - (shift ? shift.break_minutes || 0 : 0));

  let earlyLeaveMinutes = 0;
  let status = 'present';
  if (shift) {
    const shiftEndMinutes = minutesSinceMidnight(shift.end_time);
    const [, hh, mm] = timestamp.match(/(\d{2}):(\d{2}):\d{2}$/) || [null, '00', '00'];
    const checkOutMinutes = Number(hh) * 60 + Number(mm);
    earlyLeaveMinutes = Math.max(0, shiftEndMinutes - checkOutMinutes);
    if (workedMinutes < shift.half_day_min_minutes) status = 'absent';
    else if (workedMinutes < shift.full_day_min_minutes) status = 'half_day';
    else status = 'present';
  }

  await db.upsertAttendanceRecord({
    userId, date, shiftId: shift ? shift.id : existing.shift_id, checkInAt: existing.check_in_at, checkOutAt: timestamp,
    status, workedMinutes, lateMinutes: existing.late_minutes, earlyLeaveMinutes, source: 'check_in_out',
  });
  return { date, checkOutAt: timestamp, workedMinutes, earlyLeaveMinutes, status };
}

// ---------------------------------------------------------------------------
// MANUAL / ADMIN MARKING (WFH, on-duty, holiday, absent, leave, etc.)
// ---------------------------------------------------------------------------

const MANUAL_STATUSES = ['present', 'absent', 'half_day', 'wfh', 'on_duty', 'holiday', 'weekly_off', 'leave'];

async function markAttendance({ userId, date, status, actorId, notes }) {
  if (!MANUAL_STATUSES.includes(status)) throw new Error(`status must be one of: ${MANUAL_STATUSES.join(', ')}`);
  await db.upsertAttendanceRecord({ userId, date, status, source: 'manual', markedBy: actorId, notes });
  return db.getAttendanceRecord(userId, date);
}

// ---------------------------------------------------------------------------
// CORRECTION / REGULARIZATION REQUESTS
// ---------------------------------------------------------------------------

async function requestCorrection({ userId, date, requestedCheckInAt, requestedCheckOutAt, requestedStatus, reason }) {
  if (!reason || !reason.trim()) throw new Error('A reason is required for an attendance correction request');
  if (!requestedCheckInAt && !requestedCheckOutAt && !requestedStatus) {
    throw new Error('Provide a requested check-in/check-out time or a requested status');
  }
  const existing = await db.getAttendanceRecord(userId, date);
  return db.createAttendanceCorrectionRequest({
    userId, date, attendanceRecordId: existing ? existing.id : null,
    requestedCheckInAt, requestedCheckOutAt, requestedStatus, reason: reason.trim(),
  });
}

async function decideCorrection(requestId, decision, actorId) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const request = await db.getAttendanceCorrectionRequest(requestId);
  if (!request) throw new Error('Correction request not found');
  if (request.status !== 'pending') throw new Error('This correction request has already been decided');

  await db.decideAttendanceCorrectionRequest(requestId, decision, actorId);

  if (decision === 'approved') {
    if (request.requested_status) {
      await markAttendance({ userId: request.user_id, date: request.date, status: request.requested_status, actorId, notes: `Regularized: ${request.reason}` });
    } else {
      // Recompute worked time the same way check-out would, using the
      // employee's own check-in if only check-out was corrected (or vice
      // versa), so a regularized day gets the same downstream treatment as
      // a normal check-in/check-out pair.
      const existing = await db.getAttendanceRecord(request.user_id, request.date);
      const checkInAt = request.requested_check_in_at || (existing ? existing.check_in_at : null);
      const checkOutAt = request.requested_check_out_at || (existing ? existing.check_out_at : null);
      const shift = (existing && existing.shift_id) ? await db.getShift(existing.shift_id) : await resolveShiftForUser(request.user_id, request.date);

      let workedMinutes = existing ? existing.worked_minutes : 0;
      let status = existing ? existing.status : 'present';
      if (checkInAt && checkOutAt) {
        const grossMinutes = Math.max(0, minutesBetween(checkInAt, checkOutAt));
        workedMinutes = Math.max(0, grossMinutes - (shift ? shift.break_minutes || 0 : 0));
        status = !shift ? 'present' : workedMinutes < shift.half_day_min_minutes ? 'absent' : workedMinutes < shift.full_day_min_minutes ? 'half_day' : 'present';
      }
      await db.upsertAttendanceRecord({
        userId: request.user_id, date: request.date, shiftId: shift ? shift.id : null,
        checkInAt, checkOutAt, status, workedMinutes,
        lateMinutes: existing ? existing.late_minutes : 0, earlyLeaveMinutes: existing ? existing.early_leave_minutes : 0,
        source: 'regularization', markedBy: actorId, notes: `Regularized: ${request.reason}`,
      });
    }
  }
  return db.getAttendanceCorrectionRequest(requestId);
}

// ---------------------------------------------------------------------------
// MONTHLY CALENDAR
// ---------------------------------------------------------------------------

async function getMonthlyCalendar(userId, year, month) {
  const totalDays = daysInMonthUTC(year, month);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(totalDays).padStart(2, '0')}`;

  const [holidays, weeklyOffDays, records] = await Promise.all([
    db.getHolidaysInRange(monthStart, monthEnd),
    db.getWeeklyOffDays(),
    db.listAttendanceRecordsForUserInRange(userId, monthStart, monthEnd),
  ]);
  const holidaySet = new Set(holidays.map(h => h.holiday_date));
  const recordByDate = new Map(records.map(r => [r.date, r]));
  const today = todayStr();

  const days = [];
  for (let d = 1; d <= totalDays; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const record = recordByDate.get(date);
    let status;
    if (record) status = record.status;
    else if (holidaySet.has(date)) status = 'holiday';
    else if (weeklyOffDays.includes(dow)) status = 'weekly_off';
    else if (date < today) status = 'absent'; // past working day, no record and no manual marking
    else status = 'pending';

    days.push({
      date, status,
      checkInAt: record ? record.check_in_at : null,
      checkOutAt: record ? record.check_out_at : null,
      workedMinutes: record ? record.worked_minutes : 0,
      lateMinutes: record ? record.late_minutes : 0,
      earlyLeaveMinutes: record ? record.early_leave_minutes : 0,
      isHoliday: holidaySet.has(date),
      isWeeklyOff: weeklyOffDays.includes(dow),
    });
  }
  return { year, month, days };
}

// ---------------------------------------------------------------------------
// PAYROLL INTEGRATION — the summary payroll.js's getAttendanceForPayroll
// consumes. Returns null if this employee has zero attendance records for
// the month (attendance module not yet adopted for them), so the caller can
// fall back to its legacy leave-based LOP logic and nothing breaks for
// companies still ramping up on Block 2.
// ---------------------------------------------------------------------------

const PAID_STATUSES = new Set(['present', 'wfh', 'on_duty', 'leave']);

async function computeAttendanceSummaryForPayroll(userId, year, month) {
  const totalDays = daysInMonthUTC(year, month);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(totalDays).padStart(2, '0')}`;

  const records = await db.listAttendanceRecordsForUserInRange(userId, monthStart, monthEnd);
  if (records.length === 0) return null;

  const [holidays, weeklyOffDays] = await Promise.all([db.getHolidaysInRange(monthStart, monthEnd), db.getWeeklyOffDays()]);
  const holidaySet = new Set(holidays.map(h => h.holiday_date));
  const recordByDate = new Map(records.map(r => [r.date, r]));
  const today = todayStr();

  let workingDays = 0;
  let paidDays = 0;
  for (let d = 1; d <= totalDays; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (date > today && date > monthEnd) continue; // never happens given monthEnd bound, kept for clarity
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    if (holidaySet.has(date) || weeklyOffDays.includes(dow)) continue; // not a working day
    workingDays++;
    const record = recordByDate.get(date);
    if (!record) { continue; } // no record on a working day = LOP (0 paid weight)
    if (PAID_STATUSES.has(record.status)) paidDays += 1;
    else if (record.status === 'half_day') paidDays += 0.5;
    // 'absent' contributes 0; 'holiday'/'weekly_off' shouldn't appear on a working day but are ignored defensively
  }

  const lopDays = Math.max(0, roundMoney(workingDays - paidDays));
  return { workingDays, paidDays: roundMoney(paidDays), lopDays };
}

module.exports = {
  createShift,
  assignShift,
  resolveShiftForUser,
  checkIn,
  checkOut,
  markAttendance,
  requestCorrection,
  decideCorrection,
  getMonthlyCalendar,
  computeAttendanceSummaryForPayroll,
  MANUAL_STATUSES,
};
