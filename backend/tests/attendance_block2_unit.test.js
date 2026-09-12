// tests/attendance_block2_unit.test.js
//
// Offline unit tests for Block 2 (Attendance Management): shift-aware
// check-in/check-out math, manual marking, correction/regularization
// requests, the monthly calendar builder, and computeAttendanceSummaryForPayroll
// (the function payroll.js's getAttendanceForPayroll now consults first).
//
// Same approach as tests/payroll_block4_unit.test.js: no real database or
// network — db.js functions are monkey-patched per test.
//
// Run with:  node --test tests/attendance_block2_unit.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const attendance = require('../src/attendance');

let patched = [];
function mock(name, fn) {
  patched.push([name, db[name]]);
  db[name] = fn;
}
afterEach(() => {
  for (const [name, original] of patched) db[name] = original;
  patched = [];
});

const SHIFT_9_TO_6 = {
  id: 1, code: 'GEN', start_time: '09:00', end_time: '18:00',
  grace_period_minutes: 10, break_minutes: 60, full_day_min_minutes: 480, half_day_min_minutes: 240,
};

// ---------------------------------------------------------------------------
// Check-in
// ---------------------------------------------------------------------------

test('checkIn records no late minutes when within the grace period', async () => {
  mock('getAttendanceRecord', async () => null);
  mock('getShiftForUserOnDate', async () => SHIFT_9_TO_6);
  let saved;
  mock('upsertAttendanceRecord', async (data) => { saved = data; });

  const result = await attendance.checkIn(1, '2026-06-01 09:08:00');
  assert.equal(result.lateMinutes, 0); // within 10-minute grace
  assert.equal(saved.status, 'present');
});

test('checkIn records late minutes beyond the shift start + grace period', async () => {
  mock('getAttendanceRecord', async () => null);
  mock('getShiftForUserOnDate', async () => SHIFT_9_TO_6);
  let saved;
  mock('upsertAttendanceRecord', async (data) => { saved = data; });

  const result = await attendance.checkIn(1, '2026-06-01 09:25:00');
  assert.equal(result.lateMinutes, 15); // 25 min late - 10 min grace
  assert.equal(saved.lateMinutes, 15);
});

test('checkIn refuses a second check-in on the same day', async () => {
  mock('getAttendanceRecord', async () => ({ check_in_at: '2026-06-01 09:00:00' }));
  await assert.rejects(() => attendance.checkIn(1, '2026-06-01 09:30:00'), /Already checked in/);
});

// ---------------------------------------------------------------------------
// Check-out
// ---------------------------------------------------------------------------

test('checkOut computes worked minutes net of the shift break and marks present for a full day', async () => {
  mock('getAttendanceRecord', async () => ({ check_in_at: '2026-06-01 09:00:00', check_out_at: null, shift_id: 1, late_minutes: 0 }));
  mock('getShift', async () => SHIFT_9_TO_6);
  let saved;
  mock('upsertAttendanceRecord', async (data) => { saved = data; });

  const result = await attendance.checkOut(1, '2026-06-01 18:30:00'); // 9.5h gross - 1h break = 8.5h = 510 min
  assert.equal(result.workedMinutes, 510);
  assert.equal(result.status, 'present');
  assert.equal(saved.status, 'present');
});

test('checkOut marks half_day when worked minutes fall between half-day and full-day thresholds', async () => {
  mock('getAttendanceRecord', async () => ({ check_in_at: '2026-06-01 09:00:00', check_out_at: null, shift_id: 1, late_minutes: 0 }));
  mock('getShift', async () => SHIFT_9_TO_6);
  mock('upsertAttendanceRecord', async () => {});

  // 09:00 -> 14:00 = 5h gross - 1h break = 4h = 240 min = exactly half-day threshold... use 14:30 for clearly half-day
  const result = await attendance.checkOut(1, '2026-06-01 14:30:00'); // 5.5h - 1h = 4.5h = 270 min
  assert.equal(result.status, 'half_day');
});

test('checkOut marks absent when worked minutes are below the half-day threshold', async () => {
  mock('getAttendanceRecord', async () => ({ check_in_at: '2026-06-01 09:00:00', check_out_at: null, shift_id: 1, late_minutes: 0 }));
  mock('getShift', async () => SHIFT_9_TO_6);
  mock('upsertAttendanceRecord', async () => {});

  const result = await attendance.checkOut(1, '2026-06-01 10:30:00'); // 1.5h gross, break not even fully taken
  assert.equal(result.status, 'absent');
});

test('checkOut refuses without a prior check-in, and refuses a second check-out', async () => {
  mock('getAttendanceRecord', async () => null);
  await assert.rejects(() => attendance.checkOut(1, '2026-06-01 18:00:00'), /No check-in found/);

  mock('getAttendanceRecord', async () => ({ check_in_at: '2026-06-01 09:00:00', check_out_at: '2026-06-01 18:00:00' }));
  await assert.rejects(() => attendance.checkOut(1, '2026-06-01 18:05:00'), /Already checked out/);
});

// ---------------------------------------------------------------------------
// Manual marking
// ---------------------------------------------------------------------------

test('markAttendance rejects an unknown status', async () => {
  await assert.rejects(() => attendance.markAttendance({ userId: 1, date: '2026-06-01', status: 'on_vacation', actorId: 9 }), /status must be one of/);
});

test('markAttendance accepts wfh and stores it with source=manual', async () => {
  let saved;
  mock('upsertAttendanceRecord', async (data) => { saved = data; });
  mock('getAttendanceRecord', async () => ({ status: 'wfh' }));
  await attendance.markAttendance({ userId: 1, date: '2026-06-01', status: 'wfh', actorId: 9, notes: 'Approved WFH' });
  assert.equal(saved.status, 'wfh');
  assert.equal(saved.source, 'manual');
  assert.equal(saved.markedBy, 9);
});

// ---------------------------------------------------------------------------
// Correction / regularization requests
// ---------------------------------------------------------------------------

test('requestCorrection requires a reason and at least one requested field', async () => {
  await assert.rejects(
    () => attendance.requestCorrection({ userId: 1, date: '2026-06-01', reason: '' }),
    /reason is required/
  );
  await assert.rejects(
    () => attendance.requestCorrection({ userId: 1, date: '2026-06-01', reason: 'Forgot to check out' }),
    /Provide a requested/
  );
});

test('decideCorrection refuses to re-decide an already-decided request', async () => {
  mock('getAttendanceCorrectionRequest', async () => ({ id: 1, status: 'approved' }));
  await assert.rejects(() => attendance.decideCorrection(1, 'approved', 9), /already been decided/);
});

test('decideCorrection with a requested status marks attendance directly', async () => {
  mock('getAttendanceCorrectionRequest', async () => ({
    id: 1, status: 'pending', user_id: 1, date: '2026-06-01', requested_status: 'wfh', reason: 'Worked from home',
  }));
  mock('decideAttendanceCorrectionRequest', async () => {});
  let saved;
  mock('upsertAttendanceRecord', async (data) => { saved = data; });
  await attendance.decideCorrection(1, 'approved', 9);
  assert.equal(saved.status, 'wfh');
  assert.equal(saved.source, 'manual'); // markAttendance always writes source: 'manual'
});

test('decideCorrection with requested check-in/out recomputes worked minutes and status', async () => {
  mock('getAttendanceCorrectionRequest', async () => ({
    id: 2, status: 'pending', user_id: 1, date: '2026-06-01',
    requested_check_in_at: '2026-06-01 09:00:00', requested_check_out_at: '2026-06-01 18:00:00',
    requested_status: null, reason: 'Forgot to check out, worked full day',
  }));
  mock('decideAttendanceCorrectionRequest', async () => {});
  mock('getAttendanceRecord', async () => ({ shift_id: 1, status: 'absent', worked_minutes: 0, late_minutes: 0, early_leave_minutes: 0 }));
  mock('getShift', async () => SHIFT_9_TO_6);
  let saved;
  mock('upsertAttendanceRecord', async (data) => { saved = data; });

  await attendance.decideCorrection(2, 'approved', 9);
  assert.equal(saved.workedMinutes, 480); // 9h gross - 1h break = 8h = 480 min
  assert.equal(saved.status, 'present');
  assert.equal(saved.source, 'regularization');
});

// ---------------------------------------------------------------------------
// Monthly calendar
// ---------------------------------------------------------------------------

test('getMonthlyCalendar classifies holidays, weekly-offs, recorded days and past-with-no-record as absent', async () => {
  mock('getHolidaysInRange', async () => [{ holiday_date: '2026-06-15' }]);
  mock('getWeeklyOffDays', async () => [0, 6]); // Sun, Sat
  mock('listAttendanceRecordsForUserInRange', async () => [
    { date: '2026-06-02', status: 'present', check_in_at: '2026-06-02 09:00:00', check_out_at: '2026-06-02 18:00:00', worked_minutes: 480, late_minutes: 0, early_leave_minutes: 0 },
  ]);

  const cal = await attendance.getMonthlyCalendar(1, 2026, 6);
  const byDate = Object.fromEntries(cal.days.map(d => [d.date, d]));
  assert.equal(byDate['2026-06-15'].status, 'holiday');
  assert.equal(byDate['2026-06-02'].status, 'present');
  // 2026-06-06 is a Saturday
  assert.equal(byDate['2026-06-06'].status, 'weekly_off');
  assert.equal(cal.days.length, 30);
});

// ---------------------------------------------------------------------------
// Payroll integration
// ---------------------------------------------------------------------------

test('computeAttendanceSummaryForPayroll returns null when the employee has no attendance records that month', async () => {
  mock('listAttendanceRecordsForUserInRange', async () => []);
  const result = await attendance.computeAttendanceSummaryForPayroll(1, 2026, 6);
  assert.equal(result, null);
});

test('computeAttendanceSummaryForPayroll: present/wfh/on_duty/leave count full, half_day counts half, absent counts zero', async () => {
  mock('getHolidaysInRange', async () => []);
  mock('getWeeklyOffDays', async () => [0, 6]);
  // June 2026: 1st is a Monday. Give it a small, fully-specified working set.
  mock('listAttendanceRecordsForUserInRange', async () => [
    { date: '2026-06-01', status: 'present' },
    { date: '2026-06-02', status: 'half_day' },
    { date: '2026-06-03', status: 'wfh' },
    { date: '2026-06-04', status: 'absent' },
    { date: '2026-06-05', status: 'on_duty' },
    // 2026-06-08 (a working day) has no record at all -> LOP
  ]);
  const result = await attendance.computeAttendanceSummaryForPayroll(1, 2026, 6);
  assert.ok(result.workingDays >= 5);
  assert.equal(result.paidDays, 1 + 0.5 + 1 + 0 + 1); // 3.5
  assert.equal(result.lopDays, result.workingDays - 3.5);
});
