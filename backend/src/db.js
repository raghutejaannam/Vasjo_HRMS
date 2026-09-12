// src/db.js — PostgreSQL data layer (via Prisma Client) for the Vasjo
// Technologies Timesheet Portal.
//
// Ported from the original src/db.js (Node's built-in node:sqlite +
// better-sqlite3-style synchronous API). The business logic, validation, and
// return shapes are unchanged; every function that used to be synchronous is
// now async (it awaits Prisma).
//
// Data access here goes through Prisma Client's parameterized
// $queryRawUnsafe/$executeRawUnsafe (wrapped by dbGet/dbAll/dbRun/dbInsert
// below) rather than the Prisma query-builder API. This is a deliberate
// choice for this migration: it lets the original SQL — already reviewed,
// tested, and battle-tested against real payroll/tax/leave rules — carry
// over with only dialect-level edits (SQLite -> PostgreSQL), which is by far
// the safest way to guarantee the new backend returns byte-identical JSON to
// the old one. Everything here is still fully parameterized (no string-built
// SQL ever includes a value directly), so this satisfies "parameterized
// database operations through Prisma".
//
// Payroll/tax *calculations* live in payroll.js, not here (per the file
// responsibility split in the migration brief). Report aggregation, CSV, and
// the payslip PDF builder live in reports.js. Auth/session/password logic
// lives in auth.js. This file is the data-access layer: CRUD + the small
// amount of query logic (joins, filters, pagination) needed to serve it.

require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const { nowStr, nowStrOffsetDays, proratedAnnualLeave, businessDaysBetween, computeRowHours, rowHasContent, validateEntriesBasic, validateEntriesForSubmit } = require('./utils');

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// RAW SQL HELPERS — translate '?' placeholders (as used throughout the
// original SQL) into PostgreSQL's positional '$1,$2,...' and run them through
// Prisma's parameterized raw-query API.
// ---------------------------------------------------------------------------

function toPgPlaceholders(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// SELECT ... -> array of rows
function normalizeDbValue(value) {
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.map(normalizeDbValue);
  if (value && typeof value === 'object') {
    // Prisma Decimal values expose toNumber(). Keep the API JSON-compatible
    // with the original SQLite backend, which returned plain JavaScript
    // numbers for REAL/aggregate values.
    if (typeof value.toNumber === 'function') return value.toNumber();
    const out = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeDbValue(item);
    return out;
  }
  return value;
}

async function dbAll(sqlText, params = [], client = prisma) {
  const rows = await client.$queryRawUnsafe(toPgPlaceholders(sqlText), ...params);
  return normalizeDbValue(rows);
}

// SELECT ... -> first row or undefined
async function dbGet(sqlText, params = [], client = prisma) {
  const rows = await dbAll(sqlText, params, client);
  return rows[0];
}

// INSERT/UPDATE/DELETE without needing the new id back -> { changes }
async function dbRun(sqlText, params = [], client = prisma) {
  const n = await client.$executeRawUnsafe(toPgPlaceholders(sqlText), ...params);
  return { changes: n };
}

// INSERT ... -> { lastInsertRowid } by appending RETURNING id. sqlText must
// be an INSERT statement with no trailing semicolon and no existing
// RETURNING clause.
async function dbInsert(sqlText, params = [], client = prisma) {
  const rows = await client.$queryRawUnsafe(toPgPlaceholders(sqlText) + ' RETURNING id', ...params);
  return { lastInsertRowid: rows[0] ? rows[0].id : undefined };
}

// Runs `fn(tx)` inside a PostgreSQL transaction, where `tx` is passed as the
// last argument to dbGet/dbAll/dbRun/dbInsert calls inside fn so every
// statement participates in the same transaction. Used for the multi-table
// financial/approval operations the migration brief calls out explicitly
// (leave approval + balance update, payroll run calculation, payslip
// generation, bulk approvals, salary revisions, tax declaration submission).
async function withTx(fn) {
  return prisma.$transaction(async (tx) => fn(tx));
}

async function healthCheck() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

// ---------------------------------------------------------------------------
// SETTINGS (with defaults)
// ---------------------------------------------------------------------------

const DEFAULT_SETTINGS = {
  standard_hours_per_day: '8',
  timesheet_lock_weeks: '8',
  financial_year_start_month: '1',
  company_name: 'Vasjo Technologies',
  submission_deadline_day: '2',
  escalation_days: '3',
};

// Cheap, idempotent — safe to call on every server startup. Does not create
// demo users/leave types/etc; that's prisma/seed.js's job (run explicitly via
// `npx prisma db seed`), matching the target file structure for this backend.
async function ensureRuntimeDefaults() {
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
    await dbRun('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}

async function getSettings() {
  const rows = await dbAll('SELECT * FROM settings');
  const out = {};
  rows.forEach(r => { out[r.key] = r.value; });
  return out;
}

async function updateSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    await dbRun(`
      INSERT INTO settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [k, String(v)]);
  }
  return getSettings();
}

// ---------------------------------------------------------------------------
// USER QUERIES
// ---------------------------------------------------------------------------

async function findUserByEmail(email) {
  return dbGet('SELECT * FROM users WHERE email = ?', [email]);
}
async function findUserById(id) {
  return dbGet('SELECT * FROM users WHERE id = ?', [id]);
}

const USER_SORT_COLUMNS = {
  name: 'u.name', email: 'u.email', dept: 'u.dept', joined_date: 'u.joined_date',
  annual_ctc: 'ess.annual_ctc', monthly_ctc: 'ess.monthly_ctc',
};

async function listUsers({ page = 1, pageSize = 50, search = '', department = '', status = '', sortBy = 'name', sortDir = 'asc' } = {}) {
  const offset = (page - 1) * pageSize;
  const where = [];
  const params = [];
  if (search) {
    where.push('(u.name ILIKE ? OR u.email ILIKE ? OR u.employee_code ILIKE ?)');
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (department) { where.push('u.dept = ?'); params.push(department); }
  if (status === 'active') where.push('u.active = 1');
  else if (status === 'inactive') where.push('u.active = 0');
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const orderCol = USER_SORT_COLUMNS[sortBy] || 'u.name';
  const orderDir = String(sortDir).toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const total = Number((await dbGet(`SELECT COUNT(*) AS n FROM users u ${whereSql}`, params)).n);
  const items = await dbAll(`
    SELECT u.id, u.name, u.email, u.role, u.title, u.dept, u.phone, u.joined_date, u.active, u.avatar_color,
           u.manager_id, u.delegate_id, u.employee_code, u.location, u.gender, u.uan, u.pf_number, u.pan, u.bank_account_no, u.bank_name, u.employee_group, u.emergency_contact_name, u.emergency_contact_phone,
           m.name AS manager_name, d.name AS delegate_name,
           ess.annual_ctc, ess.monthly_ctc, ess.basic_salary, ess.effective_from AS salary_effective_from, ess.status AS salary_status
    FROM users u
    LEFT JOIN users m ON m.id = u.manager_id
    LEFT JOIN users d ON d.id = u.delegate_id
    LEFT JOIN employee_salary_structures ess ON ess.user_id = u.id AND ess.status = 'active'
    ${whereSql}
    ORDER BY ${orderCol} ${orderDir}
    LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);
  return { items, total, page, pageSize };
}

async function listAllUsersFlat() {
  return dbAll('SELECT id, name, role, manager_id FROM users WHERE active = 1 ORDER BY name');
}

async function listDirectReports(managerId) {
  return dbAll(`
    SELECT id, name, email, role, title, dept, active, avatar_color, must_reset_password
    FROM users WHERE manager_id = ? ORDER BY name
  `, [managerId]);
}

async function ensureLeaveBalance(userId, leaveType, year, joinedDate) {
  const existing = await dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [userId, leaveType.id, year]);
  if (existing) return existing;
  const total = proratedAnnualLeave(joinedDate, leaveType.default_annual_days, year);
  await dbRun('INSERT INTO leave_balances (user_id, leave_type_id, year, total_days, used_days) VALUES (?, ?, ?, ?, 0)', [userId, leaveType.id, year, total]);
  return dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [userId, leaveType.id, year]);
}

function randomAvatarColor() {
  const palette = ['#2F6F5E', '#C08A2E', '#B4483F', '#3D6B6B', '#5B5FA6', '#8A5B3D'];
  return palette[Math.floor(Math.random() * palette.length)];
}

async function createUser({ name, email, password, role, title, dept, managerId, phone, joinedDate }) {
  const { hashPassword } = require('./auth');
  const pw = hashPassword(password || 'changeme123');
  const info = await dbInsert(`
    INSERT INTO users (name, email, password_hash, password_salt, role, title, dept, manager_id, phone, joined_date, must_reset_password, avatar_color)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
  `, [name, email, pw.hash, pw.salt, role, title || null, dept || null, managerId || null, phone || null, joinedDate || new Date().toISOString().slice(0, 10), randomAvatarColor()]);

  const year = new Date().getFullYear();
  const types = await dbAll('SELECT * FROM leave_types WHERE active = 1');
  const createdUser = await dbGet('SELECT joined_date FROM users WHERE id = ?', [info.lastInsertRowid]);
  for (const t of types) {
    await dbRun('INSERT INTO leave_balances (user_id, leave_type_id, year, total_days, used_days) VALUES (?, ?, ?, ?, 0) ON CONFLICT DO NOTHING',
      [info.lastInsertRowid, t.id, year, proratedAnnualLeave(createdUser.joined_date, t.default_annual_days, year)]);
  }

  return info.lastInsertRowid;
}

async function bulkImportUsersFromCsv(csvText) {
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) return { created: 0, skipped: 0, errors: [] };
  const header = lines[0].split(',').map(h => h.trim().toLowerCase());
  const nameIdx = header.indexOf('name');
  const emailIdx = header.indexOf('email');
  const roleIdx = header.indexOf('role');
  const deptIdx = header.indexOf('dept');
  const titleIdx = header.indexOf('title');
  if (nameIdx === -1 || emailIdx === -1) {
    throw new Error('CSV must have at least "name" and "email" columns');
  }
  let created = 0, skipped = 0;
  const errors = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',').map(c => c.trim());
    const name = cols[nameIdx];
    const email = cols[emailIdx];
    const role = roleIdx > -1 ? (cols[roleIdx] || 'employee') : 'employee';
    if (!name || !email) { skipped++; continue; }
    if (await findUserByEmail(email)) { skipped++; errors.push(`${email}: already exists`); continue; }
    try {
      await createUser({ name, email, role, title: titleIdx > -1 ? cols[titleIdx] : null, dept: deptIdx > -1 ? cols[deptIdx] : null });
      created++;
    } catch (e) {
      skipped++; errors.push(`${email}: ${e.message}`);
    }
  }
  return { created, skipped, errors };
}

async function updateUserAdmin(id, patch) {
  const existing = await findUserById(id);
  if (!existing) throw new Error('User not found');
  if (patch.email !== undefined) {
    const email = String(patch.email || '').trim().toLowerCase();
    if (!email) throw new Error('Email is required');
    const duplicate = await dbGet('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?', [email, id]);
    if (duplicate) throw new Error('A user with that email already exists');
    patch.email = email;
  }
  const fields = [];
  const values = [];
  for (const key of ['name', 'email', 'role', 'title', 'dept', 'phone', 'active', 'manager_id', 'delegate_id', 'joined_date', 'employee_code', 'location', 'gender', 'uan', 'pf_number', 'pan', 'bank_account_no', 'bank_name', 'employee_group', 'emergency_contact_name', 'emergency_contact_phone']) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
  }
  if (fields.length === 0) return;
  values.push(id);
  await dbRun(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
  if (patch.joined_date !== undefined) {
    const joinedUser = await dbGet('SELECT joined_date FROM users WHERE id = ?', [id]);
    const types = await dbAll('SELECT * FROM leave_types WHERE active = 1');
    const year = new Date().getFullYear();
    for (const t of types) {
      const existingBal = await dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [id, t.id, year]);
      const total = proratedAnnualLeave(joinedUser.joined_date, t.default_annual_days, year);
      if (existingBal) await dbRun('UPDATE leave_balances SET total_days = GREATEST(used_days, ?) WHERE id = ?', [total, existingBal.id]);
      else await dbRun('INSERT INTO leave_balances (user_id, leave_type_id, year, total_days, used_days) VALUES (?, ?, ?, ?, 0)', [id, t.id, year, total]);
    }
  }
  if (patch.active === 0) {
    const { deleteAllSessionsForUser } = require('./auth');
    await deleteAllSessionsForUser(id);
  }
}

async function updateProfile(userId, { name, email, dept, phone, avatarColor, emergencyContactName, emergencyContactPhone, employeeCode, location, gender, uan, pfNumber, pan, bankAccountNo, bankName, employeeGroup }) {
  const current = await findUserById(userId);
  if (!current) throw new Error('User not found');
  const nextEmail = email === undefined ? current.email : String(email || '').trim().toLowerCase();
  if (!nextEmail) throw new Error('Email is required');
  const duplicate = await dbGet('SELECT id FROM users WHERE lower(email) = lower(?) AND id != ?', [nextEmail, userId]);
  if (duplicate) throw new Error('A user with that email already exists');
  await dbRun(`
    UPDATE users SET name = ?, email = ?, dept = ?, phone = ?, avatar_color = ?,
      emergency_contact_name = ?, emergency_contact_phone = ?, employee_code = ?, location = ?, gender = ?,
      uan = ?, pf_number = ?, pan = ?, bank_account_no = ?, bank_name = ?, employee_group = ?
    WHERE id = ?
  `, [name || current.name, nextEmail, dept ?? current.dept, phone ?? current.phone, avatarColor || current.avatar_color,
    emergencyContactName ?? current.emergency_contact_name, emergencyContactPhone ?? current.emergency_contact_phone,
    employeeCode ?? current.employee_code, location ?? current.location, gender ?? current.gender, uan ?? current.uan,
    pfNumber ?? current.pf_number, pan ?? current.pan, bankAccountNo ?? current.bank_account_no,
    bankName ?? current.bank_name, employeeGroup ?? current.employee_group, userId]);
}

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------

async function notify(userId, type, message, entityType, entityId) {
  if (!userId) return;
  await dbRun(`
    INSERT INTO notifications (user_id, type, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)
  `, [userId, type, message, entityType || null, entityId || null]);
}

async function listNotifications(userId, unreadOnly) {
  if (unreadOnly) {
    return dbAll('SELECT * FROM notifications WHERE user_id = ? AND read = 0 ORDER BY created_at DESC LIMIT 30', [userId]);
  }
  return dbAll('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 30', [userId]);
}

async function unreadNotificationCount(userId) {
  return Number((await dbGet('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', [userId])).n);
}

async function markNotificationRead(id, userId) {
  await dbRun('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', [id, userId]);
}

async function markAllNotificationsRead(userId) {
  await dbRun('UPDATE notifications SET read = 1 WHERE user_id = ?', [userId]);
}

// ---------------------------------------------------------------------------
// TIMESHEET QUERIES
// ---------------------------------------------------------------------------

async function nextTimesheetId(client = prisma) {
  const rows = await dbAll("SELECT id FROM timesheets WHERE id LIKE 'TS-%'", [], client);
  let max = 1000;
  for (const r of rows) {
    const n = parseInt(String(r.id).split('-')[1], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return 'TS-' + (max + 1);
}

async function listTimesheetsForUser(userId, { page = 1, pageSize = 20 } = {}) {
  const offset = (page - 1) * pageSize;
  const total = Number((await dbGet('SELECT COUNT(*) AS n FROM timesheets WHERE user_id = ?', [userId])).n);
  const items = await dbAll('SELECT * FROM timesheets WHERE user_id = ? ORDER BY week_start DESC LIMIT ? OFFSET ?', [userId, pageSize, offset]);
  return { items, total, page, pageSize };
}

async function getTimesheetForWeek(userId, weekStart) {
  return dbGet('SELECT * FROM timesheets WHERE user_id = ? AND week_start = ?', [userId, weekStart]);
}

// scope: null = everyone (admin), array of manager IDs = restrict to reports of those managers
async function listAllTimesheets(status, managerScope, { page = 1, pageSize = 20, userId } = {}) {
  const offset = (page - 1) * pageSize;
  let where = [];
  let params = [];
  if (status) { where.push('t.status = ?'); params.push(status); }
  if (userId) { where.push('t.user_id = ?'); params.push(userId); }
  if (managerScope && managerScope.length) {
    where.push(`u.manager_id IN (${managerScope.map(() => '?').join(',')})`);
    params.push(...managerScope);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = Number((await dbGet(`SELECT COUNT(*) AS n FROM timesheets t JOIN users u ON u.id = t.user_id ${whereSql}`, params)).n);
  const items = await dbAll(`
    SELECT t.*, u.name AS user_name FROM timesheets t JOIN users u ON u.id = t.user_id
    ${whereSql} ORDER BY t.week_start DESC, t.submitted_at DESC LIMIT ? OFFSET ?
  `, [...params, pageSize, offset]);
  return { items, total, page, pageSize };
}

async function getTimesheetEntries(timesheetId) {
  return dbAll(`
    SELECT te.*, p.name AS project_name, t.name AS task_name
    FROM timesheet_entries te
    LEFT JOIN projects p ON p.id = te.project_id
    LEFT JOIN tasks t ON t.id = te.task_id
    WHERE te.timesheet_id = ? ORDER BY te.entry_date
  `, [timesheetId]);
}

async function findMissingDays(userId, entries) {
  const hoursByDate = {};
  for (const e of entries) {
    if (!rowHasContent(e)) continue;
    hoursByDate[e.date] = (hoursByDate[e.date] || 0) + computeRowHours(e.inTime, e.outTime);
  }
  const dates = [...new Set(entries.map(e => e.date))];
  const missing = [];
  for (const date of dates) {
    const h = hoursByDate[date] || 0;
    if (h > 0) continue;
    const day = new Date(date + 'T00:00:00').getDay();
    if (day === 0 || day === 6) continue; // weekend, not missing
    if (await isHoliday(date)) continue;
    const onLeave = await dbGet(`
      SELECT 1 FROM leave_applications WHERE user_id = ? AND status IN ('pending','approved')
      AND ? BETWEEN from_date AND to_date LIMIT 1
    `, [userId, date]);
    if (onLeave) continue;
    missing.push(date);
  }
  return missing;
}

function checkTimesheetLock(weekStart, lockWeeks) {
  const weekDate = new Date(weekStart + 'T00:00:00');
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - lockWeeks * 7);
  if (weekDate < cutoff) {
    const err = new Error(`This week is more than ${lockWeeks} weeks old and is locked for editing. Contact your manager.`);
    err.code = 'PERIOD_LOCKED';
    throw err;
  }
}

function computeOvertime(hoursByDate, standardHoursPerDay) {
  return Object.values(hoursByDate).reduce((s, h) => s + Math.max(0, h - standardHoursPerDay), 0);
}

async function saveTimesheet(userId, weekStart, entries, submit, standardHoursPerDay) {
  if (submit) validateEntriesForSubmit(entries);
  else validateEntriesBasic(entries);

  const rows = entries.filter(rowHasContent).map(e => ({
    date: e.date,
    inTime: e.inTime || null,
    outTime: e.outTime || null,
    note: e.note || null,
    hours: computeRowHours(e.inTime, e.outTime),
  }));

  const hoursByDate = {};
  for (const r of rows) hoursByDate[r.date] = (hoursByDate[r.date] || 0) + r.hours;
  const total = Math.round(Object.values(hoursByDate).reduce((s, h) => s + h, 0) * 100) / 100;
  const overtime = Math.round(computeOvertime(hoursByDate, standardHoursPerDay || 8) * 100) / 100;

  return withTx(async (tx) => {
    const existing = await dbGet('SELECT * FROM timesheets WHERE user_id = ? AND week_start = ?', [userId, weekStart], tx);

    if (existing && existing.status === 'approved') {
      const err = new Error('This timesheet is already approved and cannot be edited.');
      err.code = 'ALREADY_APPROVED';
      throw err;
    }

    const tsId = existing ? existing.id : await nextTimesheetId(tx);
    const status = submit ? 'pending' : 'draft';

    if (existing) {
      await dbRun(`
        UPDATE timesheets SET status = ?, total_hours = ?, overtime_hours = ?, submitted_at = CASE WHEN ? = 'pending' THEN ? ELSE submitted_at END,
        decided_at = NULL, decided_by = NULL, last_comment = NULL, escalated = 0 WHERE id = ?
      `, [status, total, overtime, status, nowStr(), tsId], tx);
      await dbRun('DELETE FROM timesheet_entries WHERE timesheet_id = ?', [tsId], tx);
    } else if (submit) {
      await dbRun(`
        INSERT INTO timesheets (id, user_id, week_start, status, total_hours, overtime_hours, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [tsId, userId, weekStart, status, total, overtime, nowStr()], tx);
    } else {
      await dbRun(`
        INSERT INTO timesheets (id, user_id, week_start, status, total_hours, overtime_hours, submitted_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `, [tsId, userId, weekStart, status, total, overtime], tx);
    }

    for (const r of rows) {
      await dbRun('INSERT INTO timesheet_entries (timesheet_id, entry_date, hours, note, in_time, out_time) VALUES (?, ?, ?, ?, ?, ?)',
        [tsId, r.date, r.hours, r.note, r.inTime, r.outTime], tx);
    }

    if (submit) {
      await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id) VALUES (?, ?, ?, ?)', ['timesheet', tsId, 'submitted', userId], tx);
      const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId], tx);
      if (user.manager_id) await dbRun('INSERT INTO notifications (user_id, type, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
        [user.manager_id, 'timesheet_submitted', `${user.name} submitted timesheet ${tsId} for review`, 'timesheet', tsId], tx);
    }
    return tsId;
  });
}

async function decideTimesheet(id, action, actorId, comment) {
  const status = action === 'approve' ? 'approved' : 'rejected';
  return withTx(async (tx) => {
    const ts = await dbGet('SELECT * FROM timesheets WHERE id = ?', [id], tx);
    if (!ts) throw new Error('Timesheet not found');
    await dbRun(`UPDATE timesheets SET status = ?, decided_at = ?, decided_by = ?, last_comment = ? WHERE id = ?`, [status, nowStr(), actorId, comment || null, id], tx);
    await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id, notes) VALUES (?, ?, ?, ?, ?)', ['timesheet', id, status, actorId, comment || null], tx);
    await dbRun('INSERT INTO notifications (user_id, type, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
      [ts.user_id, 'timesheet_' + status, `Your timesheet ${id} was ${status}${comment ? ': ' + comment : ''}`, 'timesheet', id], tx);
  });
}

// ---------------------------------------------------------------------------
// TIMESHEET CORRECTION REQUESTS
// ---------------------------------------------------------------------------

async function requestTimesheetCorrection(timesheetId, userId, reason) {
  const ts = await dbGet('SELECT * FROM timesheets WHERE id = ?', [timesheetId]);
  if (!ts) throw new Error('Timesheet not found');
  if (ts.user_id !== userId) throw new Error('You can only request corrections on your own timesheets');
  if (ts.status !== 'approved') throw new Error('Only approved timesheets can have a correction requested');
  if (ts.correction_status === 'requested') throw new Error('A correction request is already pending for this timesheet');
  if (!reason || !reason.trim()) throw new Error('Please explain what needs to be corrected');

  await dbRun(`UPDATE timesheets SET correction_status = 'requested', correction_reason = ?, correction_requested_at = ? WHERE id = ?`,
    [reason.trim(), nowStr(), timesheetId]);
  await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id, notes) VALUES (?, ?, ?, ?, ?)',
    ['timesheet', timesheetId, 'correction_requested', userId, reason.trim()]);

  const user = await findUserById(userId);
  if (user.manager_id) await notify(user.manager_id, 'correction_requested', `${user.name} requested a correction on ${timesheetId}`, 'timesheet', timesheetId);
}

async function listCorrectionRequests(managerScope) {
  let where = "WHERE t.correction_status = 'requested'";
  let params = [];
  if (managerScope && managerScope.length) {
    where += ` AND u.manager_id IN (${managerScope.map(() => '?').join(',')})`;
    params = managerScope;
  }
  return dbAll(`
    SELECT t.*, u.name AS user_name FROM timesheets t JOIN users u ON u.id = t.user_id ${where}
    ORDER BY t.correction_requested_at ASC
  `, params);
}

async function decideCorrection(timesheetId, action, actorId, comment) {
  const ts = await dbGet('SELECT * FROM timesheets WHERE id = ?', [timesheetId]);
  if (!ts) throw new Error('Timesheet not found');
  if (ts.correction_status !== 'requested') throw new Error('No correction request is pending for this timesheet');

  if (action === 'approve') {
    await dbRun(`
      UPDATE timesheets SET status = 'draft', correction_status = NULL, decided_at = NULL, decided_by = NULL, last_comment = ?
      WHERE id = ?
    `, [comment || null, timesheetId]);
    await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id, notes) VALUES (?, ?, ?, ?, ?)',
      ['timesheet', timesheetId, 'correction_approved', actorId, comment || null]);
    await notify(ts.user_id, 'correction_approved', `Your correction request on ${timesheetId} was approved — it's unlocked for editing`, 'timesheet', timesheetId);
  } else {
    await dbRun(`UPDATE timesheets SET correction_status = NULL WHERE id = ?`, [timesheetId]);
    await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id, notes) VALUES (?, ?, ?, ?, ?)',
      ['timesheet', timesheetId, 'correction_rejected', actorId, comment || null]);
    await notify(ts.user_id, 'correction_rejected', `Your correction request on ${timesheetId} was declined${comment ? ': ' + comment : ''}`, 'timesheet', timesheetId);
  }
}

async function bulkDecideTimesheets(ids, action, actorId, comment) {
  const results = [];
  for (const id of ids) {
    try { await decideTimesheet(id, action, actorId, comment); results.push({ id, ok: true }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return results;
}

// ---------------------------------------------------------------------------
// LEAVE QUERIES
// ---------------------------------------------------------------------------

async function listLeaveTypes(activeOnly) {
  if (activeOnly) return dbAll('SELECT * FROM leave_types WHERE active = 1 ORDER BY id');
  return dbAll('SELECT * FROM leave_types ORDER BY id');
}
async function getLeaveType(id, client = prisma) {
  return dbGet('SELECT * FROM leave_types WHERE id = ?', [id], client);
}
async function createLeaveType(name, defaultAnnualDays, maxCarryForwardDays) {
  return (await dbInsert('INSERT INTO leave_types (name, default_annual_days, max_carry_forward_days) VALUES (?, ?, ?)', [name, defaultAnnualDays || 0, maxCarryForwardDays || 0])).lastInsertRowid;
}
async function updateLeaveType(id, patch) {
  const fields = [];
  const values = [];
  for (const key of ['name', 'default_annual_days', 'max_carry_forward_days', 'active']) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return;
  values.push(id);
  await dbRun(`UPDATE leave_types SET ${fields.join(', ')} WHERE id = ?`, values);
}
async function deleteLeaveType(id) {
  await dbRun('UPDATE leave_types SET active = 0 WHERE id = ?', [id]);
}

async function getLeaveBalances(userId, year) {
  year = year || new Date().getFullYear();
  return dbAll(`
    SELECT lb.*, lt.name AS type_name,
      COALESCE((
        SELECT SUM(la.days) FROM leave_applications la
        WHERE la.user_id = lb.user_id AND la.leave_type_id = lb.leave_type_id
          AND la.status = 'pending' AND substr(la.from_date, 1, 4) = CAST(lb.year AS TEXT)
      ), 0) AS pending_days
    FROM leave_balances lb
    JOIN leave_types lt ON lt.id = lb.leave_type_id
    WHERE lb.user_id = ? AND lb.year = ?
    ORDER BY lt.id
  `, [userId, year]);
}

async function adjustLeaveBalance(userId, leaveTypeId, year, totalDays, usedDays) {
  const existing = await dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [userId, leaveTypeId, year]);
  if (existing) {
    await dbRun('UPDATE leave_balances SET total_days = ?, used_days = ? WHERE id = ?', [totalDays, usedDays, existing.id]);
  } else {
    await dbRun('INSERT INTO leave_balances (user_id, leave_type_id, year, total_days, used_days) VALUES (?, ?, ?, ?, ?)', [userId, leaveTypeId, year, totalDays, usedDays]);
  }
}

async function nextLeaveId(client = prisma) {
  const rows = await dbAll("SELECT id FROM leave_applications WHERE id LIKE 'LV-%'", [], client);
  let max = 200;
  for (const r of rows) {
    const n = parseInt(String(r.id).split('-')[1], 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return 'LV-' + (max + 1);
}

async function listLeaveForUser(userId) {
  return dbAll('SELECT * FROM leave_applications WHERE user_id = ? ORDER BY applied_at DESC', [userId]);
}

// scope: null = everyone, array of manager IDs = restrict to their reports
async function listAllLeave(status, managerScope) {
  let where = [];
  let params = [];
  if (status) { where.push('l.status = ?'); params.push(status); }
  if (managerScope && managerScope.length) {
    where.push(`u.manager_id IN (${managerScope.map(() => '?').join(',')})`);
    params.push(...managerScope);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return dbAll(`
    SELECT l.*, u.name AS user_name FROM leave_applications l JOIN users u ON u.id = l.user_id
    ${whereSql} ORDER BY l.applied_at DESC
  `, params);
}

async function listTeamLeave(managerScope) {
  let where = "WHERE l.status IN ('approved','pending')";
  let params = [];
  if (managerScope && managerScope.length) {
    where += ` AND u.manager_id IN (${managerScope.map(() => '?').join(',')})`;
    params.push(...managerScope);
  }
  return dbAll(`
    SELECT l.*, u.name AS user_name FROM leave_applications l JOIN users u ON u.id = l.user_id ${where}
  `, params);
}

async function checkOverlap(userId, from, to, excludeId) {
  return dbAll(`
    SELECT * FROM leave_applications WHERE user_id = ? AND status IN ('pending','approved')
    AND NOT (to_date < ? OR from_date > ?)
    ${excludeId ? 'AND id != ?' : ''}
  `, excludeId ? [userId, from, to, excludeId] : [userId, from, to]);
}

async function checkBlackout(from, to) {
  return dbAll(`SELECT * FROM company_holidays WHERE blackout = 1 AND holiday_date BETWEEN ? AND ?`, [from, to]);
}

async function applyForLeave(userId, { leaveTypeId, from, to, reason, halfDay }) {
  const overlaps = await checkOverlap(userId, from, to);
  if (overlaps.length) {
    const err = new Error(`You already have a leave request overlapping these dates (${overlaps[0].id})`);
    err.code = 'OVERLAP';
    throw err;
  }
  const blackouts = await checkBlackout(from, to);
  if (blackouts.length) {
    const err = new Error(`These dates include a company blackout period: ${blackouts.map(b => b.name).join(', ')}`);
    err.code = 'BLACKOUT';
    throw err;
  }
  const days = halfDay ? 0.5 : businessDaysBetween(from, to);
  if (days <= 0) {
    const err = new Error('Selected range has no business days');
    err.code = 'NO_BUSINESS_DAYS';
    throw err;
  }
  const year = new Date(from).getFullYear();
  const balance = await dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [userId, leaveTypeId, year]);
  if (balance && (balance.total_days - balance.used_days) < days) {
    const err = new Error('Insufficient leave balance for this request');
    err.code = 'INSUFFICIENT_BALANCE';
    throw err;
  }
  return withTx(async (tx) => {
    const id = await nextLeaveId(tx);
    await dbRun(`
      INSERT INTO leave_applications (id, user_id, leave_type_id, from_date, to_date, days, reason, status, applied_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `, [id, userId, leaveTypeId, from, to, days, reason || null, nowStr()], tx);

    await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id) VALUES (?, ?, ?, ?)', ['leave', id, 'submitted', userId], tx);
    const user = await dbGet('SELECT * FROM users WHERE id = ?', [userId], tx);
    if (user.manager_id) await dbRun('INSERT INTO notifications (user_id, type, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
      [user.manager_id, 'leave_submitted', `${user.name} requested leave (${id})`, 'leave', id], tx);
    return id;
  });
}

async function cancelLeave(id, userId) {
  return withTx(async (tx) => {
    const leave = await dbGet('SELECT * FROM leave_applications WHERE id = ?', [id], tx);
    if (!leave) throw new Error('Leave application not found');
    if (leave.user_id !== userId) throw new Error('You can only cancel your own leave requests');
    if (leave.status === 'cancelled') throw new Error('This request is already cancelled');
    if (leave.status === 'rejected') throw new Error('This request was already rejected');
    const wasApproved = leave.status === 'approved';
    await dbRun(`UPDATE leave_applications SET status = 'cancelled', decided_at = ? WHERE id = ?`, [nowStr(), id], tx);
    await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id) VALUES (?, ?, ?, ?)', ['leave', id, 'cancelled', userId], tx);
    if (wasApproved) {
      const year = new Date(leave.from_date).getFullYear();
      await dbRun(`UPDATE leave_balances SET used_days = GREATEST(0, used_days - ?) WHERE user_id = ? AND leave_type_id = ? AND year = ?`,
        [leave.days, leave.user_id, leave.leave_type_id, year], tx);
    }
  });
}

async function decideLeave(id, action, actorId, comment) {
  return withTx(async (tx) => {
    const leave = await dbGet('SELECT * FROM leave_applications WHERE id = ?', [id], tx);
    if (!leave) throw new Error('Leave application not found');
    const status = action === 'approve' ? 'approved' : 'rejected';
    await dbRun(`UPDATE leave_applications SET status = ?, decided_at = ?, decided_by = ?, last_comment = ? WHERE id = ?`, [status, nowStr(), actorId, comment || null, id], tx);
    await dbRun('INSERT INTO approvals_log (entity_type, entity_id, action, actor_id, notes) VALUES (?, ?, ?, ?, ?)', ['leave', id, status, actorId, comment || null], tx);

    if (status === 'approved') {
      const year = new Date(leave.from_date).getFullYear();
      await dbRun(`
        UPDATE leave_balances SET used_days = used_days + ?
        WHERE user_id = ? AND leave_type_id = ? AND year = ?
      `, [leave.days, leave.user_id, leave.leave_type_id, year], tx);
    }
    await dbRun('INSERT INTO notifications (user_id, type, message, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)',
      [leave.user_id, 'leave_' + status, `Your leave request ${id} was ${status}${comment ? ': ' + comment : ''}`, 'leave', id], tx);
  });
}

async function bulkDecideLeave(ids, action, actorId, comment) {
  const results = [];
  for (const id of ids) {
    try { await decideLeave(id, action, actorId, comment); results.push({ id, ok: true }); }
    catch (e) { results.push({ id, ok: false, error: e.message }); }
  }
  return results;
}

// ---------------------------------------------------------------------------
// COMPANY HOLIDAYS
// ---------------------------------------------------------------------------

async function listHolidays() {
  return dbAll('SELECT * FROM company_holidays ORDER BY holiday_date');
}
async function addHoliday(date, name, blackout) {
  return (await dbInsert('INSERT INTO company_holidays (holiday_date, name, blackout) VALUES (?, ?, ?)', [date, name, blackout ? 1 : 0])).lastInsertRowid;
}
async function deleteHoliday(id) {
  await dbRun('DELETE FROM company_holidays WHERE id = ?', [id]);
}
async function isHoliday(dateStr) {
  return (await dbGet('SELECT * FROM company_holidays WHERE holiday_date = ?', [dateStr])) || null;
}
async function getHolidaysInRange(from, to) {
  return dbAll('SELECT * FROM company_holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date', [from, to]);
}

// ---------------------------------------------------------------------------
// PROJECTS & TASKS
// ---------------------------------------------------------------------------

async function listProjects(activeOnly) {
  if (activeOnly) return dbAll('SELECT * FROM projects WHERE active = 1 ORDER BY name');
  return dbAll('SELECT * FROM projects ORDER BY name');
}
async function createProject(name, code) {
  return (await dbInsert('INSERT INTO projects (name, code) VALUES (?, ?)', [name, code || null])).lastInsertRowid;
}
async function updateProject(id, patch) {
  const fields = [];
  const values = [];
  for (const key of ['name', 'code', 'active']) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return;
  values.push(id);
  await dbRun(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`, values);
}

async function listTasks(projectId, activeOnly) {
  let sql = 'SELECT * FROM tasks WHERE project_id = ?';
  if (activeOnly) sql += ' AND active = 1';
  sql += ' ORDER BY name';
  return dbAll(sql, [projectId]);
}
async function listAllTasks(activeOnly) {
  let sql = `SELECT t.*, p.name AS project_name FROM tasks t JOIN projects p ON p.id = t.project_id`;
  if (activeOnly) sql += ' WHERE t.active = 1 AND p.active = 1';
  sql += ' ORDER BY p.name, t.name';
  return dbAll(sql);
}
async function createTask(projectId, name) {
  return (await dbInsert('INSERT INTO tasks (project_id, name) VALUES (?, ?)', [projectId, name])).lastInsertRowid;
}
async function updateTask(id, patch) {
  const fields = [];
  const values = [];
  for (const key of ['name', 'active']) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return;
  values.push(id);
  await dbRun(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`, values);
}

// ---------------------------------------------------------------------------
// EMPLOYEE-PROJECT MAPPING
// ---------------------------------------------------------------------------

async function listProjectsForUser(userId) {
  const assigned = await dbAll(`
    SELECT p.* FROM projects p
    JOIN employee_projects ep ON ep.project_id = p.id
    WHERE ep.user_id = ? AND p.active = 1
    ORDER BY p.name
  `, [userId]);
  if (assigned.length) return assigned;
  return listProjects(true);
}

async function listProjectAssignments(projectId) {
  return dbAll(`
    SELECT u.id, u.name, u.email FROM employee_projects ep
    JOIN users u ON u.id = ep.user_id
    WHERE ep.project_id = ? ORDER BY u.name
  `, [projectId]);
}

async function listUserProjectIds(userId) {
  return (await dbAll('SELECT project_id FROM employee_projects WHERE user_id = ?', [userId])).map(r => r.project_id);
}

async function setProjectAssignments(projectId, userIds) {
  return withTx(async (tx) => {
    await dbRun('DELETE FROM employee_projects WHERE project_id = ?', [projectId], tx);
    for (const uid of userIds) {
      await dbRun('INSERT INTO employee_projects (user_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [uid, projectId], tx);
    }
  });
}

// ---------------------------------------------------------------------------
// DEPARTMENTS
// ---------------------------------------------------------------------------

async function listDepartments(activeOnly) {
  if (activeOnly) return dbAll('SELECT * FROM departments WHERE active = 1 ORDER BY name');
  return dbAll('SELECT * FROM departments ORDER BY name');
}
async function createDepartment(name) {
  return (await dbInsert('INSERT INTO departments (name) VALUES (?)', [name])).lastInsertRowid;
}
async function updateDepartment(id, patch) {
  const fields = [];
  const values = [];
  for (const key of ['name', 'active']) {
    if (patch[key] !== undefined) { fields.push(`${key} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return;
  values.push(id);
  await dbRun(`UPDATE departments SET ${fields.join(', ')} WHERE id = ?`, values);
}

// ---------------------------------------------------------------------------
// AUDIT TRAIL
// ---------------------------------------------------------------------------

async function getAuditLog(entityType, entityId) {
  return dbAll(`
    SELECT al.*, u.name AS actor_name FROM approvals_log al
    JOIN users u ON u.id = al.actor_id
    WHERE al.entity_type = ? AND al.entity_id = ?
    ORDER BY al.acted_at ASC
  `, [entityType, entityId]);
}

// ---------------------------------------------------------------------------
// MANAGER SCOPE HELPER (for approvals + team calendar)
// ---------------------------------------------------------------------------

async function resolveManagerScope(user) {
  if (user.role === 'admin') return null;
  const delegatedFor = (await dbAll('SELECT id FROM users WHERE delegate_id = ?', [user.id])).map(r => r.id);
  return [user.id, ...delegatedFor];
}

async function canAccessEmployeePayroll(user, targetUserId) {
  if (user.id === targetUserId) return true;
  if (user.role === 'admin') return true;
  if (user.role !== 'manager') return false;
  const target = await findUserById(targetUserId);
  if (!target) return false;
  const scope = await resolveManagerScope(user);
  return scope.includes(target.manager_id);
}

// ---------------------------------------------------------------------------
// ANALYTICS
// ---------------------------------------------------------------------------

async function weeklyHoursTrend(userId, weeks) {
  const rows = await dbAll(`
    SELECT week_start, total_hours, status FROM timesheets WHERE user_id = ? ORDER BY week_start DESC LIMIT ?
  `, [userId, weeks]);
  return rows.reverse();
}

async function teamHoursSummary(managerScope) {
  let where = '';
  let params = [];
  if (managerScope && managerScope.length) {
    where = `WHERE u.manager_id IN (${managerScope.map(() => '?').join(',')})`;
    params = managerScope;
  }
  const cutoff = new Date(Date.now() - 56 * 86400000).toISOString().slice(0, 10);
  return dbAll(`
    SELECT u.name AS user_name, COALESCE(SUM(t.total_hours), 0) AS total_hours
    FROM users u LEFT JOIN timesheets t ON t.user_id = u.id AND t.status = 'approved'
      AND t.week_start >= ?
    ${where}
    GROUP BY u.id, u.name ORDER BY total_hours DESC
  `, where ? [cutoff, ...params] : [cutoff]);
}

// ---------------------------------------------------------------------------
// ESCALATION — anything left pending longer than settings.escalation_days
// gets flagged and admins are notified once.
// ---------------------------------------------------------------------------

async function runEscalationCheck(escalationDays) {
  const { nowStrOffsetDays } = require('./utils');
  const admins = await dbAll(`SELECT id FROM users WHERE role = 'admin' AND active = 1`);
  if (!admins.length) return { escalatedTimesheets: 0, escalatedLeave: 0 };

  const cutoff = nowStrOffsetDays(-escalationDays);

  const overdueTs = await dbAll(`
    SELECT t.*, u.name AS user_name FROM timesheets t JOIN users u ON u.id = t.user_id
    WHERE t.status = 'pending' AND t.escalated = 0
      AND t.submitted_at IS NOT NULL AND t.submitted_at <= ?
  `, [cutoff]);

  for (const t of overdueTs) {
    for (const a of admins) {
      await notify(a.id, 'escalation', `Timesheet ${t.id} (${t.user_name}) has been pending for over ${escalationDays} day(s)`, 'timesheet', t.id);
    }
    await dbRun('UPDATE timesheets SET escalated = 1 WHERE id = ?', [t.id]);
  }

  const overdueLv = await dbAll(`
    SELECT l.*, u.name AS user_name FROM leave_applications l JOIN users u ON u.id = l.user_id
    WHERE l.status = 'pending' AND l.escalated = 0
      AND l.applied_at <= ?
  `, [cutoff]);

  for (const l of overdueLv) {
    for (const a of admins) {
      await notify(a.id, 'escalation', `Leave request ${l.id} (${l.user_name}) has been pending for over ${escalationDays} day(s)`, 'leave', l.id);
    }
    await dbRun('UPDATE leave_applications SET escalated = 1 WHERE id = ?', [l.id]);
  }

  return { escalatedTimesheets: overdueTs.length, escalatedLeave: overdueLv.length };
}

// ---------------------------------------------------------------------------
// LEAVE POLICY: YEAR-END CARRY FORWARD
// ---------------------------------------------------------------------------

async function runYearEndCarryForward(fromYear, toYear) {
  const types = await dbAll('SELECT * FROM leave_types WHERE active = 1');
  const users = await dbAll('SELECT id FROM users WHERE active = 1');
  let processed = 0;
  let skipped = 0;

  for (const u of users) {
    for (const t of types) {
      const already = await dbGet('SELECT 1 FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [u.id, t.id, toYear]);
      if (already) { skipped++; continue; }
      const fromBalance = await dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [u.id, t.id, fromYear]);
      const remaining = fromBalance ? Math.max(0, fromBalance.total_days - fromBalance.used_days) : 0;
      const carried = Math.min(remaining, t.max_carry_forward_days || 0);
      const employee = await dbGet('SELECT joined_date FROM users WHERE id = ?', [u.id]);
      const annual = proratedAnnualLeave(employee.joined_date, t.default_annual_days || 0, toYear);
      await dbRun('INSERT INTO leave_balances (user_id, leave_type_id, year, total_days, used_days) VALUES (?, ?, ?, ?, 0)',
        [u.id, t.id, toYear, annual + carried]);
      processed++;
    }
  }
  return { processed, skipped, fromYear, toYear };
}

// ---------------------------------------------------------------------------
// FINANCIAL YEARS
// ---------------------------------------------------------------------------

async function listFinancialYears() {
  return dbAll('SELECT * FROM financial_years ORDER BY start_date DESC');
}
async function getFinancialYear(id) {
  return dbGet('SELECT * FROM financial_years WHERE id = ?', [id]);
}
async function getActiveFinancialYear() {
  return dbGet('SELECT * FROM financial_years WHERE is_active = 1 LIMIT 1');
}
async function createFinancialYear(name, startDate, endDate) {
  return (await dbInsert('INSERT INTO financial_years (name, start_date, end_date) VALUES (?, ?, ?)', [name, startDate, endDate])).lastInsertRowid;
}
async function setActiveFinancialYear(id) {
  return withTx(async (tx) => {
    await dbRun('UPDATE financial_years SET is_active = 0', [], tx);
    await dbRun('UPDATE financial_years SET is_active = 1 WHERE id = ?', [id], tx);
  });
}

// ---------------------------------------------------------------------------
// SALARY COMPONENTS (master list — earnings, deductions, reimbursements)
// ---------------------------------------------------------------------------

async function listSalaryComponents(activeOnly) {
  if (activeOnly) return dbAll('SELECT * FROM salary_components WHERE is_active = 1 ORDER BY display_order, name');
  return dbAll('SELECT * FROM salary_components ORDER BY display_order, name');
}
async function getSalaryComponent(id) {
  return dbGet('SELECT * FROM salary_components WHERE id = ?', [id]);
}
async function getSalaryComponentByCode(code) {
  return dbGet('SELECT * FROM salary_components WHERE code = ?', [code]);
}
async function createSalaryComponent(data) {
  return (await dbInsert(`
    INSERT INTO salary_components (code, name, type, category, is_taxable, is_fixed, calculation_type, calculation_value, display_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [data.code, data.name, data.type, data.category || null, data.isTaxable ? 1 : 0, data.isFixed ? 1 : 0,
      data.calculationType || null, data.calculationValue ?? null, data.displayOrder || 0, nowStr()])).lastInsertRowid;
}
async function updateSalaryComponent(id, patch) {
  const map = { name: 'name', category: 'category', isTaxable: 'is_taxable', isFixed: 'is_fixed', calculationType: 'calculation_type',
    calculationValue: 'calculation_value', displayOrder: 'display_order', isActive: 'is_active' };
  const fields = [];
  const values = [];
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) { fields.push(`${col} = ?`); values.push(patch[key]); }
  }
  if (!fields.length) return;
  fields.push('updated_at = ?'); values.push(nowStr());
  values.push(id);
  await dbRun(`UPDATE salary_components SET ${fields.join(', ')} WHERE id = ?`, values);
}

// ---------------------------------------------------------------------------
// EMPLOYEE SALARY STRUCTURES (CRUD; CTC calculation itself lives in payroll.js)
// ---------------------------------------------------------------------------

async function getActiveSalaryStructure(userId, financialYearId) {
  return dbGet(`
    SELECT * FROM employee_salary_structures WHERE user_id = ? AND financial_year_id = ? AND status = 'active'
    ORDER BY effective_from DESC LIMIT 1
  `, [userId, financialYearId]);
}
async function getSalaryStructureAsOf(userId, dateStr) {
  return dbGet(`
    SELECT * FROM employee_salary_structures
    WHERE user_id = ? AND status = 'active' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)
    ORDER BY effective_from DESC LIMIT 1
  `, [userId, dateStr, dateStr]);
}
async function listSalaryStructuresForEmployee(userId) {
  return dbAll('SELECT * FROM employee_salary_structures WHERE user_id = ? ORDER BY effective_from DESC', [userId]);
}
async function getSalaryStructureById(id) {
  return dbGet('SELECT * FROM employee_salary_structures WHERE id = ?', [id]);
}
async function getStructureComponents(structureId, client = prisma) {
  return dbAll(`
    SELECT ssc.*, sc.code, sc.name AS component_name, sc.type, sc.category, sc.is_taxable, sc.is_fixed
    FROM salary_structure_components ssc JOIN salary_components sc ON sc.id = ssc.component_id
    WHERE ssc.salary_structure_id = ? ORDER BY sc.display_order
  `, [structureId], client);
}
async function insertSalaryStructureRow(data, client = prisma) {
  return dbInsert(`
    INSERT INTO employee_salary_structures (user_id, financial_year_id, effective_from, effective_to, annual_ctc, monthly_ctc, basic_salary, status, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [data.userId, data.financialYearId, data.effectiveFrom, data.effectiveTo || null, data.annualCtc, data.monthlyCtc, data.basicSalary, data.status || 'draft', data.createdBy, nowStr()], client);
}
// Finds a salary component master row by (name, type), or creates one on
// the fly. Used when an admin types a brand-new component name directly
// into a salary structure's component table rather than picking from the
// pre-seeded master list.
async function findOrCreateSalaryComponentByName({ name, type, category, isTaxable }, client = prisma) {
  const existing = await dbGet('SELECT * FROM salary_components WHERE lower(name) = lower(?) AND type = ?', [name, type], client);
  if (existing) return existing;
  let code = name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'COMPONENT';
  let candidate = code;
  let suffix = 1;
  while (await dbGet('SELECT id FROM salary_components WHERE code = ?', [candidate], client)) {
    candidate = `${code}_${suffix++}`;
  }
  const maxOrder = await dbGet('SELECT COALESCE(MAX(display_order), 0) AS n FROM salary_components', [], client);
  const info = await dbInsert(`
    INSERT INTO salary_components (code, name, type, category, is_taxable, is_fixed, display_order, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [candidate, name, type, category || null, isTaxable ? 1 : 0, 0, Number(maxOrder.n) + 1, nowStr()], client);
  return dbGet('SELECT * FROM salary_components WHERE id = ?', [info.lastInsertRowid], client);
}

// Replaces the full set of components on a salary structure with the given
// rows (used by the "Salary Structure Builder" admin UI, which edits the
// component table as free-form name/type/category/amount rows rather than
// adjusting fixed amounts on pre-existing component ids).
async function replaceStructureComponents(structureId, rows, client = prisma) {
  await dbRun('DELETE FROM salary_structure_components WHERE salary_structure_id = ?', [structureId], client);
  for (const row of rows) {
    const component = await findOrCreateSalaryComponentByName(row, client);
    await insertStructureComponent(structureId, component.id, row.amount, true, client);
  }
}

async function insertStructureComponent(structureId, componentId, amount, isOverride, client = prisma) {
  await dbRun(`
    INSERT INTO salary_structure_components (salary_structure_id, component_id, amount, is_override) VALUES (?, ?, ?, ?)
    ON CONFLICT(salary_structure_id, component_id) DO UPDATE SET amount = excluded.amount, is_override = excluded.is_override
  `, [structureId, componentId, amount, isOverride ? 1 : 0], client);
}
async function supersedeActiveStructures(userId, financialYearId, beforeDate, client = prisma) {
  await dbRun(`
    UPDATE employee_salary_structures SET status = 'superseded', effective_to = ?
    WHERE user_id = ? AND financial_year_id = ? AND status = 'active' AND effective_from < ?
  `, [beforeDate, userId, financialYearId, beforeDate], client);
}
async function activateSalaryStructure(id, client = prisma) {
  await dbRun(`UPDATE employee_salary_structures SET status = 'active', updated_at = ? WHERE id = ?`, [nowStr(), id], client);
}
// Edits a draft structure's own basics (annual CTC / basic / effective date)
// before it's ever activated. Not allowed once active/superseded — use
// giveSalaryHike (a new structure + revision record) to change comp after
// that point instead.
async function updateSalaryStructureBasics(id, patch) {
  const structure = await getSalaryStructureById(id);
  if (!structure) { const e = new Error('Salary structure not found'); e.code = 'NOT_FOUND'; e.httpStatus = 404; throw e; }
  if (structure.status !== 'draft') {
    const e = new Error('Only draft salary structures can be edited directly');
    e.code = 'NOT_DRAFT';
    throw e;
  }
  const fields = [];
  const values = [];
  const annualCtc = patch.annualCtc !== undefined ? patch.annualCtc : structure.annual_ctc;
  const basicSalary = patch.basicSalary !== undefined ? patch.basicSalary : structure.basic_salary;
  if (patch.annualCtc !== undefined) { fields.push('annual_ctc = ?'); values.push(annualCtc); fields.push('monthly_ctc = ?'); values.push(annualCtc / 12); }
  if (patch.basicSalary !== undefined) { fields.push('basic_salary = ?'); values.push(basicSalary); }
  if (patch.effectiveFrom !== undefined) { fields.push('effective_from = ?'); values.push(patch.effectiveFrom); }
  if (!fields.length) return;
  fields.push('updated_at = ?'); values.push(nowStr());
  values.push(id);
  await dbRun(`UPDATE employee_salary_structures SET ${fields.join(', ')} WHERE id = ?`, values);
}
async function attachOfferLetter(structureId, path) {
  await dbRun('UPDATE employee_salary_structures SET offer_letter_path = ?, offer_letter_uploaded_at = ? WHERE id = ?', [path, nowStr(), structureId]);
}

// ---------------------------------------------------------------------------
// TAX REGIMES / SLABS / RULES
// ---------------------------------------------------------------------------

async function listTaxRegimes(financialYearId) {
  return dbAll('SELECT * FROM tax_regimes WHERE financial_year_id = ? AND is_active = 1 ORDER BY id', [financialYearId]);
}
async function getTaxRegime(id) {
  return dbGet('SELECT * FROM tax_regimes WHERE id = ?', [id]);
}
async function getDefaultTaxRegime(financialYearId) {
  return dbGet('SELECT * FROM tax_regimes WHERE financial_year_id = ? AND is_default = 1 LIMIT 1', [financialYearId]);
}
async function listTaxSlabs(taxRegimeId) {
  return dbAll('SELECT * FROM tax_slabs WHERE tax_regime_id = ? ORDER BY display_order, min_income', [taxRegimeId]);
}
async function listTaxRules(taxRegimeId) {
  return dbAll('SELECT * FROM tax_rules WHERE tax_regime_id = ?', [taxRegimeId]);
}
async function getTaxRule(taxRegimeId, ruleKey) {
  return dbGet('SELECT * FROM tax_rules WHERE tax_regime_id = ? AND rule_key = ?', [taxRegimeId, ruleKey]);
}
async function upsertTaxRule(taxRegimeId, ruleKey, ruleValue, ruleType, description, client = prisma) {
  await dbRun(`
    INSERT INTO tax_rules (tax_regime_id, rule_key, rule_value, rule_type, description) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tax_regime_id, rule_key) DO UPDATE SET rule_value = excluded.rule_value, rule_type = excluded.rule_type, description = excluded.description
  `, [taxRegimeId, ruleKey, ruleValue, ruleType, description || null], client);
}
async function insertTaxSlab(taxRegimeId, minIncome, maxIncome, rate, displayOrder, client = prisma) {
  await dbRun('INSERT INTO tax_slabs (tax_regime_id, min_income, max_income, rate, display_order) VALUES (?, ?, ?, ?, ?)',
    [taxRegimeId, minIncome, maxIncome, rate, displayOrder || 0], client);
}
async function insertTaxRegime(financialYearId, code, name, isDefault, client = prisma) {
  return dbInsert('INSERT INTO tax_regimes (financial_year_id, code, name, is_default) VALUES (?, ?, ?, ?)',
    [financialYearId, code, name, isDefault ? 1 : 0], client);
}

// ---------------------------------------------------------------------------
// DEDUCTION LIMITS (statutory limits for Section 80C etc.)
// ---------------------------------------------------------------------------

async function listDeductionLimits(financialYearId) {
  return dbAll('SELECT * FROM deduction_limits WHERE financial_year_id = ? AND is_active = 1', [financialYearId]);
}
async function getDeductionLimit(financialYearId, sectionCode) {
  return dbGet('SELECT * FROM deduction_limits WHERE financial_year_id = ? AND section_code = ?', [financialYearId, sectionCode]);
}
async function upsertDeductionLimit(financialYearId, sectionCode, sectionName, limitAmount, client = prisma) {
  await dbRun(`
    INSERT INTO deduction_limits (financial_year_id, section_code, section_name, limit_amount) VALUES (?, ?, ?, ?)
    ON CONFLICT(financial_year_id, section_code) DO UPDATE SET limit_amount = excluded.limit_amount, section_name = excluded.section_name
  `, [financialYearId, sectionCode, sectionName, limitAmount], client);
}

// ---------------------------------------------------------------------------
// EMPLOYEE TAX REGIME SELECTION
// ---------------------------------------------------------------------------

async function getEmployeeTaxRegime(userId, financialYearId) {
  return dbGet(`
    SELECT etr.*, tr.name AS regime_name
    FROM employee_tax_regime etr
    JOIN tax_regimes tr ON tr.id = etr.tax_regime_id
    WHERE etr.user_id = ? AND etr.financial_year_id = ?
  `, [userId, financialYearId]);
}
async function setEmployeeTaxRegime(userId, financialYearId, taxRegimeId, selectedBy) {
  await dbRun(`
    INSERT INTO employee_tax_regime (user_id, financial_year_id, tax_regime_id, selected_by) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, financial_year_id) DO UPDATE SET tax_regime_id = excluded.tax_regime_id, selected_by = excluded.selected_by, selected_at = excluded.selected_at
  `, [userId, financialYearId, taxRegimeId, selectedBy]);
}

// ---------------------------------------------------------------------------
// TAX DECLARATION SECTIONS (master list, e.g. 80C, 80D, HRA...)
// ---------------------------------------------------------------------------

async function listTaxDeclarationSections(financialYearId, regime) {
  if (regime) return dbAll(`
    SELECT * FROM tax_declaration_sections WHERE financial_year_id = ? AND is_active = 1
    AND applicable_regime IN (?, 'both') ORDER BY display_order
  `, [financialYearId, regime]);
  return dbAll('SELECT * FROM tax_declaration_sections WHERE financial_year_id = ? AND is_active = 1 ORDER BY display_order', [financialYearId]);
}
async function insertTaxDeclarationSection(data, client = prisma) {
  return dbInsert(`
    INSERT INTO tax_declaration_sections (financial_year_id, section_code, section_name, description, max_limit, display_order, applicable_regime)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [data.financialYearId, data.sectionCode, data.sectionName, data.description || null, data.maxLimit ?? null, data.displayOrder || 0, data.applicableRegime || 'old'], client);
}

// ---------------------------------------------------------------------------
// TAX DECLARATIONS (per-employee, per-section, per-FY)
// ---------------------------------------------------------------------------

async function getDeclarationById(id) {
  return dbGet('SELECT * FROM tax_declarations WHERE id = ?', [id]);
}
async function getOrCreateDeclaration(userId, financialYearId, sectionId, client = prisma) {
  const existing = await dbGet('SELECT * FROM tax_declarations WHERE user_id = ? AND financial_year_id = ? AND section_id = ?', [userId, financialYearId, sectionId], client);
  if (existing) return existing;
  const info = await dbInsert(`
    INSERT INTO tax_declarations (user_id, financial_year_id, section_id, updated_at) VALUES (?, ?, ?, ?)
  `, [userId, financialYearId, sectionId, nowStr()], client);
  return dbGet('SELECT * FROM tax_declarations WHERE id = ?', [info.lastInsertRowid], client);
}
async function listDeclarationsForUser(userId, financialYearId) {
  return dbAll(`
    SELECT td.*, s.section_code, s.section_name, s.max_limit, s.applicable_regime
    FROM tax_declarations td JOIN tax_declaration_sections s ON s.id = td.section_id
    WHERE td.user_id = ? AND td.financial_year_id = ? ORDER BY s.display_order
  `, [userId, financialYearId]);
}
async function listDeclarationEntries(declarationId) {
  return dbAll('SELECT * FROM tax_declaration_entries WHERE tax_declaration_id = ? ORDER BY created_at', [declarationId]);
}
async function addDeclarationEntry(declarationId, data) {
  return (await dbInsert(`
    INSERT INTO tax_declaration_entries (tax_declaration_id, investment_type, provider_name, amount, investment_date, financial_year, supporting_doc_path, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [declarationId, data.investmentType || null, data.providerName || null, data.amount, data.investmentDate || null, data.financialYear || null, data.supportingDocPath || null, nowStr()])).lastInsertRowid;
}
async function updateDeclarationEntryStatus(entryId, status, patch = {}) {
  const fields = ['status = ?', 'updated_at = ?'];
  const values = [status, nowStr()];
  for (const [key, col] of [['approvedAmount', 'approved_amount'], ['approvedBy', 'approved_by'], ['rejectionReason', 'rejection_reason']]) {
    if (patch[key] !== undefined) { fields.push(`${col} = ?`); values.push(patch[key]); }
  }
  if (status === 'approved' || status === 'rejected') { fields.push('approved_at = ?'); values.push(nowStr()); }
  values.push(entryId);
  await dbRun(`UPDATE tax_declaration_entries SET ${fields.join(', ')} WHERE id = ?`, values);
}
async function deleteDeclarationEntry(entryId) {
  const entry = await dbGet('SELECT * FROM tax_declaration_entries WHERE id = ?', [entryId]);
  if (!entry) { const e = new Error('Declaration entry not found'); e.code = 'NOT_FOUND'; e.httpStatus = 404; throw e; }
  await dbRun('DELETE FROM tax_declaration_entries WHERE id = ?', [entryId]);
  await recomputeDeclaredAmount(entry.tax_declaration_id);
  return entry.tax_declaration_id;
}
async function recomputeDeclaredAmount(declarationId, client = prisma) {
  const sum = await dbGet(`
    SELECT COALESCE(SUM(amount), 0) AS total FROM tax_declaration_entries
    WHERE tax_declaration_id = ? AND status != 'rejected'
  `, [declarationId], client);
  await dbRun('UPDATE tax_declarations SET declared_amount = ?, updated_at = ? WHERE id = ?', [sum.total, nowStr(), declarationId], client);
}
async function submitTaxDeclarations(userId, financialYearId) {
  return withTx(async (tx) => {
    await dbRun(`
      UPDATE tax_declarations SET status = 'submitted', submitted_at = ?, updated_at = ?
      WHERE user_id = ? AND financial_year_id = ? AND status = 'draft'
    `, [nowStr(), nowStr(), userId, financialYearId], tx);
  });
}
async function verifyTaxDeclaration(declarationId, verifiedBy, eligibleAmount) {
  await dbRun(`
    UPDATE tax_declarations SET status = 'verified', verified_by = ?, verified_at = ?, eligible_amount = ?, updated_at = ?
    WHERE id = ?
  `, [verifiedBy, nowStr(), eligibleAmount, nowStr(), declarationId]);
}
async function rejectTaxDeclaration(declarationId, verifiedBy, reason) {
  await dbRun(`
    UPDATE tax_declarations SET status = 'rejected', verified_by = ?, verified_at = ?, rejection_reason = ?, updated_at = ?
    WHERE id = ?
  `, [verifiedBy, nowStr(), reason || null, nowStr(), declarationId]);
}

async function getApprovedDeclarationsTotal(userId, financialYearId) {
  const row = await dbGet(`
    SELECT COALESCE(SUM(eligible_amount), 0) AS total FROM tax_declarations
    WHERE user_id = ? AND financial_year_id = ? AND status = 'verified'
  `, [userId, financialYearId]);
  return Number(row.total);
}

// ---------------------------------------------------------------------------
// FIXED / VARIABLE DEDUCTIONS
// ---------------------------------------------------------------------------

async function listFixedDeductions(userId, financialYearId) {
  return dbAll(`
    SELECT fd.*, sc.code, sc.name FROM fixed_deductions fd JOIN salary_components sc ON sc.id = fd.component_id
    WHERE fd.user_id = ? AND fd.financial_year_id = ? AND fd.is_active = 1
  `, [userId, financialYearId]);
}
async function addFixedDeduction(data) {
  return (await dbInsert(`
    INSERT INTO fixed_deductions (user_id, financial_year_id, component_id, amount, effective_from, effective_to) VALUES (?, ?, ?, ?, ?, ?)
  `, [data.userId, data.financialYearId, data.componentId, data.amount, data.effectiveFrom, data.effectiveTo || null])).lastInsertRowid;
}
async function deactivateFixedDeduction(id) {
  await dbRun('UPDATE fixed_deductions SET is_active = 0 WHERE id = ?', [id]);
}

async function listVariableDeductions(userId, payrollMonth) {
  return dbAll(`
    SELECT vd.*, sc.code, sc.name FROM variable_deductions vd JOIN salary_components sc ON sc.id = vd.component_id
    WHERE vd.user_id = ? AND vd.payroll_month = ?
  `, [userId, payrollMonth]);
}
async function addVariableDeduction(data, client = prisma) {
  return dbRun(`
    INSERT INTO variable_deductions (user_id, payroll_month, component_id, amount, reason, created_by) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, payroll_month, component_id) DO UPDATE SET amount = excluded.amount, reason = excluded.reason, created_by = excluded.created_by
  `, [data.userId, data.payrollMonth, data.componentId, data.amount, data.reason || null, data.createdBy], client);
}
async function removeVariableDeduction(id) {
  await dbRun('DELETE FROM variable_deductions WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// PREVIOUS EMPLOYER INCOME (for accurate TDS when joining mid-year)
// ---------------------------------------------------------------------------

async function getPreviousEmployerIncome(userId, financialYearId) {
  return dbGet('SELECT * FROM previous_employer_income WHERE user_id = ? AND financial_year_id = ?', [userId, financialYearId]);
}
async function upsertPreviousEmployerIncome(data) {
  await dbRun(`
    INSERT INTO previous_employer_income (user_id, financial_year_id, previous_employer_name, gross_income, tds_deducted, professional_tax_paid, joining_date_current_org, document_path)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, financial_year_id) DO UPDATE SET previous_employer_name = excluded.previous_employer_name,
      gross_income = excluded.gross_income, tds_deducted = excluded.tds_deducted, professional_tax_paid = excluded.professional_tax_paid,
      joining_date_current_org = excluded.joining_date_current_org, document_path = excluded.document_path
  `, [data.userId, data.financialYearId, data.previousEmployerName || null, data.grossIncome || 0, data.tdsDeducted || 0,
      data.professionalTaxPaid || 0, data.joiningDateCurrentOrg || null, data.documentPath || null]);
}

// ---------------------------------------------------------------------------
// PAYROLL RUNS
// ---------------------------------------------------------------------------

async function getPayrollRun(id, client = prisma) {
  return dbGet('SELECT * FROM payroll_runs WHERE id = ?', [id], client);
}
async function getPayrollRunByMonth(financialYearId, payrollMonth) {
  return dbGet('SELECT * FROM payroll_runs WHERE financial_year_id = ? AND payroll_month = ?', [financialYearId, payrollMonth]);
}
async function listPayrollRuns(financialYearId) {
  if (financialYearId) return dbAll('SELECT * FROM payroll_runs WHERE financial_year_id = ? ORDER BY payroll_month DESC', [financialYearId]);
  return dbAll('SELECT * FROM payroll_runs ORDER BY payroll_month DESC');
}
async function getOrCreatePayrollRun(financialYearId, payrollMonth, client = prisma) {
  const existing = await dbGet('SELECT * FROM payroll_runs WHERE financial_year_id = ? AND payroll_month = ?', [financialYearId, payrollMonth], client);
  if (existing) return existing;
  const info = await dbInsert('INSERT INTO payroll_runs (financial_year_id, payroll_month) VALUES (?, ?)', [financialYearId, payrollMonth], client);
  return dbGet('SELECT * FROM payroll_runs WHERE id = ?', [info.lastInsertRowid], client);
}
async function updatePayrollRunTotals(id, totals, client = prisma) {
  await dbRun(`
    UPDATE payroll_runs SET total_employees = ?, total_gross = ?, total_deductions = ?, total_tds = ?, total_net = ? WHERE id = ?
  `, [totals.totalEmployees, totals.totalGross, totals.totalDeductions, totals.totalTds, totals.totalNet, id], client);
}
async function setPayrollRunStatus(id, status, actorId, client = prisma) {
  const columnByStatus = { calculated: ['calculated_by', 'calculated_at'], reviewed: ['reviewed_by', 'reviewed_at'], approved: ['approved_by', 'approved_at'], locked: ['locked_by', 'locked_at'] };
  const cols = columnByStatus[status];
  if (cols) {
    await dbRun(`UPDATE payroll_runs SET status = ?, ${cols[0]} = ?, ${cols[1]} = ? WHERE id = ?`, [status, actorId, nowStr(), id], client);
  } else {
    await dbRun('UPDATE payroll_runs SET status = ? WHERE id = ?', [status, id], client);
  }
}
async function clearPayrollDetailsForRun(payrollRunId, client = prisma) {
  await dbRun('DELETE FROM payroll_details WHERE payroll_run_id = ?', [payrollRunId], client);
  await dbRun('DELETE FROM payroll_exceptions WHERE payroll_run_id = ?', [payrollRunId], client);
}

// Deletes a payroll run outright (only safe for runs that aren't locked/
// disbursed yet). payroll_details, payroll_exceptions (ON DELETE CASCADE from
// payroll_run_id) and payslips (ON DELETE CASCADE from payroll_detail_id) are
// removed automatically by the DB.
async function deletePayrollRun(id) {
  const run = await dbGet('SELECT * FROM payroll_runs WHERE id = ?', [id]);
  if (!run) { const e = new Error('Payroll run not found'); e.code = 'NOT_FOUND'; e.httpStatus = 404; throw e; }
  if (['locked', 'disbursed'].includes(run.status)) {
    const e = new Error(`Payroll run for ${run.payroll_month} is ${run.status} and cannot be deleted`);
    e.code = 'PERIOD_LOCKED';
    throw e;
  }
  await dbRun('DELETE FROM payroll_runs WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------
// PAYROLL DETAILS
// ---------------------------------------------------------------------------

async function insertPayrollDetail(row, client = prisma) {
  return dbInsert(`
    INSERT INTO payroll_details (
      payroll_run_id, user_id, salary_structure_id,
      basic_earning, hra_earning, allowances_earning, variable_earning, overtime_earning, bonus_earning, reimbursement_earning, other_earning, gross_earning,
      pf_employee_deduction, professional_tax_deduction, insurance_deduction, other_fixed_deduction, variable_deductions_total, tds_deduction, total_deductions,
      loan_deduction, advance_recovery_deduction, arrears_earning, leave_encashment_earning,
      taxable_income, annual_taxable_income, annual_tax, monthly_tds, tds_already_deducted, remaining_tax_liability,
      net_salary, working_days, paid_days, lop_days, status, exception_flags, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    row.payrollRunId, row.userId, row.salaryStructureId || null,
    row.basicEarning, row.hraEarning, row.allowancesEarning, row.variableEarning, row.overtimeEarning, row.bonusEarning, row.reimbursementEarning, row.otherEarning, row.grossEarning,
    row.pfEmployeeDeduction, row.professionalTaxDeduction, row.insuranceDeduction, row.otherFixedDeduction, row.variableDeductionsTotal, row.tdsDeduction, row.totalDeductions,
    row.loanDeduction || 0, row.advanceRecoveryDeduction || 0, row.arrearsEarning || 0, row.leaveEncashmentEarning || 0,
    row.taxableIncome, row.annualTaxableIncome, row.annualTax, row.monthlyTds, row.tdsAlreadyDeducted, row.remainingTaxLiability,
    row.netSalary, row.workingDays, row.paidDays, row.lopDays, row.status || 'calculated', row.exceptionFlags || null, nowStr(),
  ], client);
}
async function listPayrollDetails(payrollRunId) {
  return dbAll(`
    SELECT pd.*, u.name AS user_name, u.employee_code FROM payroll_details pd JOIN users u ON u.id = pd.user_id
    WHERE pd.payroll_run_id = ? ORDER BY u.name
  `, [payrollRunId]);
}
async function getPayrollDetail(id) {
  return dbGet(`
    SELECT pd.*, u.name AS user_name, u.employee_code FROM payroll_details pd JOIN users u ON u.id = pd.user_id WHERE pd.id = ?
  `, [id]);
}
async function getPayrollDetailForUser(payrollRunId, userId) {
  return dbGet('SELECT * FROM payroll_details WHERE payroll_run_id = ? AND user_id = ?', [payrollRunId, userId]);
}
async function listPayrollHistoryForUser(userId) {
  return dbAll(`
    SELECT pd.*, pr.payroll_month, pr.status AS run_status FROM payroll_details pd
    JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    WHERE pd.user_id = ? ORDER BY pr.payroll_month DESC
  `, [userId]);
}
async function updatePayrollDetailStatus(id, status, actorId, client = prisma) {
  const cols = status === 'reviewed' ? ['reviewed_by', 'reviewed_at'] : status === 'approved' ? ['approved_by', 'approved_at'] : null;
  if (cols) {
    await dbRun(`UPDATE payroll_details SET status = ?, ${cols[0]} = ?, ${cols[1]} = ?, updated_at = ? WHERE id = ?`, [status, actorId, nowStr(), nowStr(), id], client);
  } else {
    await dbRun('UPDATE payroll_details SET status = ?, updated_at = ? WHERE id = ?', [status, nowStr(), id], client);
  }
}
async function applyPayrollAdjustmentToDetail(detailId, field, delta, client = prisma) {
  await dbRun(`UPDATE payroll_details SET ${field} = ${field} + ?, net_salary = net_salary + ?, status = 'adjusted', updated_at = ? WHERE id = ?`,
    [delta, field.includes('deduction') || field === 'tds_deduction' ? -delta : delta, nowStr(), detailId], client);
}

// ---------------------------------------------------------------------------
// PAYSLIPS
// ---------------------------------------------------------------------------

async function createPayslip(payrollDetailId, userId, payrollMonth, pdfPath, generatedBy, client = prisma) {
  await dbRun(`
    INSERT INTO payslips (payroll_detail_id, user_id, payroll_month, pdf_path, generated_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(payroll_detail_id) DO UPDATE SET pdf_path = excluded.pdf_path, generated_by = excluded.generated_by, generated_at = excluded.generated_at
  `, [payrollDetailId, userId, payrollMonth, pdfPath || null, generatedBy], client);
  return dbGet('SELECT * FROM payslips WHERE payroll_detail_id = ?', [payrollDetailId], client);
}
async function getPayslip(id) {
  return dbGet('SELECT * FROM payslips WHERE id = ?', [id]);
}
async function getPayslipForDetail(payrollDetailId) {
  return dbGet('SELECT * FROM payslips WHERE payroll_detail_id = ?', [payrollDetailId]);
}
async function listPayslipsForEmployee(userId) {
  return dbAll('SELECT * FROM payslips WHERE user_id = ? ORDER BY payroll_month DESC', [userId]);
}
async function markPayslipDownloaded(id, userId) {
  await dbRun('UPDATE payslips SET downloaded_at = ?, downloaded_by = ? WHERE id = ?', [nowStr(), userId, id]);
}

// ---------------------------------------------------------------------------
// PAYROLL EXCEPTIONS
// ---------------------------------------------------------------------------

async function addPayrollException(payrollRunId, userId, code, message, severity, client = prisma) {
  return dbInsert('INSERT INTO payroll_exceptions (payroll_run_id, user_id, exception_code, exception_message, severity) VALUES (?, ?, ?, ?, ?)',
    [payrollRunId, userId, code, message, severity], client);
}
async function listPayrollExceptions(payrollRunId, unresolvedOnly) {
  let sql = `
    SELECT pe.*, u.name AS user_name FROM payroll_exceptions pe JOIN users u ON u.id = pe.user_id WHERE pe.payroll_run_id = ?
  `;
  const params = [payrollRunId];
  if (unresolvedOnly) sql += ' AND pe.is_resolved = 0';
  sql += ' ORDER BY pe.severity, pe.created_at';
  return dbAll(sql, params);
}
async function resolveException(id, resolvedBy, notes) {
  await dbRun('UPDATE payroll_exceptions SET is_resolved = 1, resolved_by = ?, resolved_at = ?, resolution_notes = ? WHERE id = ?',
    [resolvedBy, nowStr(), notes || null, id]);
}

// ---------------------------------------------------------------------------
// PAYROLL ADJUSTMENTS (post-calculation manual corrections, require approval)
// ---------------------------------------------------------------------------

async function createPayrollAdjustment(data) {
  return (await dbInsert(`
    INSERT INTO payroll_adjustments (payroll_detail_id, adjustment_type, component_id, amount, reason, requested_by) VALUES (?, ?, ?, ?, ?, ?)
  `, [data.payrollDetailId, data.adjustmentType, data.componentId || null, data.amount, data.reason, data.requestedBy])).lastInsertRowid;
}
async function listPayrollAdjustments(payrollDetailId) {
  return dbAll('SELECT * FROM payroll_adjustments WHERE payroll_detail_id = ? ORDER BY created_at', [payrollDetailId]);
}
async function decidePayrollAdjustment(id, status, approvedBy, client = prisma) {
  await dbRun('UPDATE payroll_adjustments SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?', [status, approvedBy, nowStr(), id], client);
  return dbGet('SELECT * FROM payroll_adjustments WHERE id = ?', [id], client);
}

// ---------------------------------------------------------------------------
// PAYROLL AUDIT LOG
// ---------------------------------------------------------------------------

async function logPayrollAudit(entityType, entityId, action, actorId, oldValues, newValues, client = prisma) {
  await dbRun(`
    INSERT INTO payroll_audit_log (entity_type, entity_id, action, actor_id, old_values, new_values) VALUES (?, ?, ?, ?, ?, ?)
  `, [entityType, String(entityId), action, actorId,
      oldValues !== undefined ? JSON.stringify(oldValues) : null,
      newValues !== undefined ? JSON.stringify(newValues) : null], client);
}
async function getPayrollAuditLog(entityType, entityId) {
  return dbAll(`
    SELECT pal.*, u.name AS actor_name FROM payroll_audit_log pal JOIN users u ON u.id = pal.actor_id
    WHERE pal.entity_type = ? AND pal.entity_id = ? ORDER BY pal.acted_at ASC
  `, [entityType, String(entityId)]);
}

// ---------------------------------------------------------------------------
// SALARY REVISIONS
// ---------------------------------------------------------------------------

async function insertSalaryRevision(data, client = prisma) {
  return dbInsert(`
    INSERT INTO salary_revisions (
      user_id, salary_structure_id, previous_annual_ctc, new_annual_ctc, previous_monthly_ctc, new_monthly_ctc,
      previous_basic_salary, new_basic_salary, hike_percentage, hike_amount, effective_date, revision_type, reason, notes, is_retroactive, approved_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [data.userId, data.salaryStructureId || null, data.previousAnnualCtc ?? null, data.newAnnualCtc, data.previousMonthlyCtc ?? null, data.newMonthlyCtc,
      data.previousBasicSalary ?? null, data.newBasicSalary ?? null, data.hikePercentage ?? null, data.hikeAmount ?? null,
      data.effectiveDate, data.revisionType, data.reason || null, data.notes || null, data.isRetroactive ? 1 : 0, data.approvedBy, nowStr()], client);
}
async function listSalaryRevisionsForUser(userId) {
  return dbAll('SELECT * FROM salary_revisions WHERE user_id = ? ORDER BY effective_date DESC', [userId]);
}
async function listRecentSalaryRevisions(limit) {
  return dbAll(`
    SELECT sr.*, u.name AS user_name FROM salary_revisions sr JOIN users u ON u.id = sr.user_id
    ORDER BY sr.created_at DESC LIMIT ?
  `, [limit || 50]);
}

// ---------------------------------------------------------------------------
// ADMIN: EMPLOYEE PAYROLL DIRECTORY
// ---------------------------------------------------------------------------

async function listEmployeesWithPayrollStatus(financialYearId) {
  return dbAll(`
    SELECT u.id, u.name, u.email, u.dept, u.employee_code,
      ess.id AS structure_id, ess.annual_ctc, ess.monthly_ctc, ess.status AS structure_status,
      etr.tax_regime_id
    FROM users u
    LEFT JOIN employee_salary_structures ess ON ess.user_id = u.id AND ess.financial_year_id = ? AND ess.status = 'active'
    LEFT JOIN employee_tax_regime etr ON etr.user_id = u.id AND etr.financial_year_id = ?
    WHERE u.active = 1
    ORDER BY u.name
  `, [financialYearId, financialYearId]);
}

// Aggregated admin payroll dashboard for a financial year: employee/salary
// setup coverage, cumulative run totals, open exceptions, pending tax proof
// review queue, and the run for the current calendar month (if any).
async function getPayrollDashboardData(financialYearId) {
  const totalEmployees = Number((await dbGet("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND role != 'admin'")).n);
  const employeesMissingSalary = Number((await dbGet(`
    SELECT COUNT(*) AS n FROM users u
    WHERE u.active = 1 AND u.role != 'admin'
      AND NOT EXISTS (SELECT 1 FROM employee_salary_structures ess WHERE ess.user_id = u.id AND ess.financial_year_id = ? AND ess.status = 'active')
  `, [financialYearId])).n);
  const pendingTaxProofs = Number((await dbGet(`
    SELECT COUNT(*) AS n FROM tax_declaration_entries e
    JOIN tax_declarations d ON d.id = e.tax_declaration_id
    WHERE d.financial_year_id = ? AND e.status IN ('declared', 'proof_uploaded')
  `, [financialYearId])).n);

  const runs = await listPayrollRuns(financialYearId);
  const processed = runs.filter((r) => ['approved', 'locked', 'disbursed'].includes(r.status)).length;
  const pending = runs.length - processed;
  const totals = runs.reduce((acc, r) => ({
    totalGross: acc.totalGross + Number(r.total_gross || 0),
    totalDeductions: acc.totalDeductions + Number(r.total_deductions || 0),
    totalTds: acc.totalTds + Number(r.total_tds || 0),
    totalNetPayroll: acc.totalNetPayroll + Number(r.total_net || 0),
  }), { totalGross: 0, totalDeductions: 0, totalTds: 0, totalNetPayroll: 0 });

  const payrollExceptions = Number((await dbGet(`
    SELECT COUNT(*) AS n FROM payroll_exceptions pe
    JOIN payroll_runs pr ON pr.id = pe.payroll_run_id
    WHERE pr.financial_year_id = ? AND pe.is_resolved = 0
  `, [financialYearId])).n);

  const currentMonth = nowStr().slice(0, 7);
  const currentRun = await getPayrollRunByMonth(financialYearId, currentMonth);

  return {
    totalEmployees, employeesMissingSalary, pendingTaxProofs,
    processed, pending, payrollExceptions,
    ...totals,
    currentMonth, currentRun: currentRun || null,
  };
}

// ---------------------------------------------------------------------------
// LOANS
// ---------------------------------------------------------------------------

async function createLoan(data) {
  return (await dbInsert(`
    INSERT INTO loans (user_id, principal_amount, interest_rate_annual, tenure_months, purpose, requested_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [data.userId, data.principalAmount, data.interestRateAnnual || 0, data.tenureMonths, data.purpose || null, nowStr()])).lastInsertRowid;
}
async function getLoan(id, client = prisma) {
  return dbGet('SELECT * FROM loans WHERE id = ?', [id], client);
}
async function listLoansForUser(userId) {
  return dbAll('SELECT * FROM loans WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}
async function listLoans(status) {
  if (status) return dbAll('SELECT l.*, u.name AS user_name FROM loans l JOIN users u ON u.id = l.user_id WHERE l.status = ? ORDER BY l.created_at DESC', [status]);
  return dbAll('SELECT l.*, u.name AS user_name FROM loans l JOIN users u ON u.id = l.user_id ORDER BY l.created_at DESC');
}
async function decideLoan(id, status, actorId) {
  await dbRun(`UPDATE loans SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?`, [status, actorId, nowStr(), id]);
}
async function disburseLoan(id, emiAmount, client = prisma) {
  const loan = await getLoan(id, client);
  await dbRun(`UPDATE loans SET status = 'active', emi_amount = ?, outstanding_balance = ?, disbursed_at = ? WHERE id = ?`,
    [emiAmount, loan.principal_amount, nowStr(), id], client);
}
async function listActiveLoansForUser(userId, client = prisma) {
  return dbAll(`SELECT * FROM loans WHERE user_id = ? AND status = 'active' ORDER BY created_at ASC`, [userId], client);
}
async function applyLoanRepayment(loanId, { amount, principalComponent, interestComponent, balanceAfter, payrollMonth, payrollDetailId }, client = prisma) {
  await dbRun(`
    INSERT INTO loan_repayments (loan_id, payroll_detail_id, payroll_month, amount, principal_component, interest_component, balance_after)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [loanId, payrollDetailId, payrollMonth, amount, principalComponent, interestComponent, balanceAfter], client);
  if (balanceAfter <= 0.01) {
    await dbRun(`UPDATE loans SET status = 'closed', outstanding_balance = 0, closed_at = ? WHERE id = ?`, [nowStr(), loanId], client);
  } else {
    await dbRun(`UPDATE loans SET outstanding_balance = ? WHERE id = ?`, [balanceAfter, loanId], client);
  }
}
async function listLoanRepayments(loanId) {
  return dbAll('SELECT * FROM loan_repayments WHERE loan_id = ? ORDER BY created_at ASC', [loanId]);
}
async function cancelLoan(id, actorId) {
  await dbRun(`UPDATE loans SET status = 'cancelled', approved_by = ?, approved_at = ? WHERE id = ? AND status = 'pending'`, [actorId, nowStr(), id]);
}

// ---------------------------------------------------------------------------
// SALARY ADVANCES
// ---------------------------------------------------------------------------

async function createSalaryAdvance(data) {
  return (await dbInsert(`
    INSERT INTO salary_advances (user_id, amount, reason, recovery_months, requested_at)
    VALUES (?, ?, ?, ?, ?)
  `, [data.userId, data.amount, data.reason || null, data.recoveryMonths || 1, nowStr()])).lastInsertRowid;
}
async function getSalaryAdvance(id, client = prisma) {
  return dbGet('SELECT * FROM salary_advances WHERE id = ?', [id], client);
}
async function listSalaryAdvancesForUser(userId) {
  return dbAll('SELECT * FROM salary_advances WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}
async function listSalaryAdvances(status) {
  if (status) return dbAll('SELECT a.*, u.name AS user_name FROM salary_advances a JOIN users u ON u.id = a.user_id WHERE a.status = ? ORDER BY a.created_at DESC', [status]);
  return dbAll('SELECT a.*, u.name AS user_name FROM salary_advances a JOIN users u ON u.id = a.user_id ORDER BY a.created_at DESC');
}
async function decideSalaryAdvance(id, status, actorId, recoveryMonths, monthlyRecoveryAmount) {
  const advance = await getSalaryAdvance(id);
  if (status === 'approved') {
    const months = recoveryMonths || advance.recovery_months || 1;
    const monthly = monthlyRecoveryAmount || Math.round((advance.amount / months) * 100) / 100;
    await dbRun(`
      UPDATE salary_advances SET status = 'recovering', approved_by = ?, approved_at = ?, recovery_months = ?, monthly_recovery_amount = ?, outstanding_balance = ?
      WHERE id = ?
    `, [actorId, nowStr(), months, monthly, advance.amount, id]);
  } else {
    await dbRun(`UPDATE salary_advances SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?`, [status, actorId, nowStr(), id]);
  }
}
async function listRecoveringAdvancesForUser(userId, client = prisma) {
  return dbAll(`SELECT * FROM salary_advances WHERE user_id = ? AND status = 'recovering' ORDER BY created_at ASC`, [userId], client);
}
async function applyAdvanceRecovery(advanceId, { amount, balanceAfter, payrollMonth, payrollDetailId }, client = prisma) {
  await dbRun(`
    INSERT INTO advance_recoveries (advance_id, payroll_detail_id, payroll_month, amount, balance_after) VALUES (?, ?, ?, ?, ?)
  `, [advanceId, payrollDetailId, payrollMonth, amount, balanceAfter], client);
  if (balanceAfter <= 0.01) {
    await dbRun(`UPDATE salary_advances SET status = 'closed', outstanding_balance = 0 WHERE id = ?`, [advanceId], client);
  } else {
    await dbRun(`UPDATE salary_advances SET outstanding_balance = ? WHERE id = ?`, [balanceAfter, advanceId], client);
  }
}
async function listAdvanceRecoveries(advanceId) {
  return dbAll('SELECT * FROM advance_recoveries WHERE advance_id = ? ORDER BY created_at ASC', [advanceId]);
}

// ---------------------------------------------------------------------------
// LEAVE ENCASHMENT
// ---------------------------------------------------------------------------

async function createLeaveEncashmentRequest(data) {
  return (await dbInsert(`
    INSERT INTO leave_encashments (user_id, leave_type_id, financial_year_id, days, per_day_amount, amount, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [data.userId, data.leaveTypeId, data.financialYearId, data.days, data.perDayAmount, data.amount, nowStr()])).lastInsertRowid;
}
async function getLeaveEncashment(id, client = prisma) {
  return dbGet('SELECT * FROM leave_encashments WHERE id = ?', [id], client);
}
async function listLeaveEncashmentsForUser(userId) {
  return dbAll(`
    SELECT le.*, lt.name AS leave_type_name FROM leave_encashments le JOIN leave_types lt ON lt.id = le.leave_type_id
    WHERE le.user_id = ? ORDER BY le.created_at DESC
  `, [userId]);
}
async function listLeaveEncashments(status) {
  const base = `
    SELECT le.*, lt.name AS leave_type_name, u.name AS user_name
    FROM leave_encashments le JOIN leave_types lt ON lt.id = le.leave_type_id JOIN users u ON u.id = le.user_id
  `;
  if (status) return dbAll(base + ' WHERE le.status = ? ORDER BY le.created_at DESC', [status]);
  return dbAll(base + ' ORDER BY le.created_at DESC');
}
async function decideLeaveEncashment(id, status, actorId, client = prisma) {
  await dbRun(`UPDATE leave_encashments SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?`, [status, actorId, nowStr(), id], client);
}
async function listApprovedUnpaidEncashmentsForUser(userId, client = prisma) {
  return dbAll(`SELECT * FROM leave_encashments WHERE user_id = ? AND status = 'approved' ORDER BY created_at ASC`, [userId], client);
}
async function markLeaveEncashmentPaid(id, payrollDetailId, client = prisma) {
  await dbRun(`UPDATE leave_encashments SET status = 'paid', payroll_detail_id = ? WHERE id = ?`, [payrollDetailId, id], client);
}

// ---------------------------------------------------------------------------
// ARREARS (generated from retroactive salary revisions)
// ---------------------------------------------------------------------------

async function createArrearsPayment(data, client = prisma) {
  return dbInsert(`
    INSERT INTO arrears_payments (user_id, salary_revision_id, for_payroll_month, amount, reason)
    VALUES (?, ?, ?, ?, ?)
  `, [data.userId, data.salaryRevisionId || null, data.forPayrollMonth, data.amount, data.reason || null], client);
}
async function listArrearsForUser(userId) {
  return dbAll('SELECT * FROM arrears_payments WHERE user_id = ? ORDER BY for_payroll_month DESC', [userId]);
}
async function listPendingArrearsForUser(userId, client = prisma) {
  return dbAll(`SELECT * FROM arrears_payments WHERE user_id = ? AND status = 'pending' ORDER BY for_payroll_month ASC`, [userId], client);
}
async function markArrearsPaid(id, payrollDetailId, client = prisma) {
  await dbRun(`UPDATE arrears_payments SET status = 'paid', payroll_detail_id = ? WHERE id = ?`, [payrollDetailId, id], client);
}

// ---------------------------------------------------------------------------
// PAYROLL COMPARISON / VARIANCE — raw data fetch (aggregation happens in
// reports.js so this stays a thin, reusable query).
// ---------------------------------------------------------------------------

async function getPayrollDetailsByMonth(financialYearId, payrollMonth) {
  return dbAll(`
    SELECT pd.*, u.name AS user_name, u.employee_code, u.dept
    FROM payroll_details pd
    JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    JOIN users u ON u.id = pd.user_id
    WHERE pr.financial_year_id = ? AND pr.payroll_month = ?
    ORDER BY u.name
  `, [financialYearId, payrollMonth]);
}

// Already-settled (approved/locked/disbursed) months for one employee within
// an FY, in [fromMonth, toMonthExclusive) — used to compute arrears when a
// salary revision is backdated over months that were already paid out.
async function listSettledPayrollMonthsForUser(userId, financialYearId, fromMonth, toMonthExclusive, client = prisma) {
  return dbAll(`
    SELECT pr.payroll_month, pd.paid_days, pd.working_days
    FROM payroll_details pd JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    WHERE pd.user_id = ? AND pr.financial_year_id = ? AND pr.status IN ('approved','locked','disbursed')
      AND pr.payroll_month >= ? AND pr.payroll_month < ?
    ORDER BY pr.payroll_month ASC
  `, [userId, financialYearId, fromMonth, toMonthExclusive], client);
}

// Undoes loan/advance/arrears/encashment side-effects previously applied
// against a payroll run's details, so recalculating a not-yet-locked run
// (which wipes and re-derives payroll_details from scratch) doesn't
// double-deduct EMIs/advance recoveries or double-pay arrears/encashments.
async function reversePayrollSideEffectsForRun(runId, client = prisma) {
  const detailIds = (await dbAll('SELECT id FROM payroll_details WHERE payroll_run_id = ?', [runId], client)).map(r => r.id);
  if (!detailIds.length) return;
  const placeholders = detailIds.map(() => '?').join(',');

  const repayments = await dbAll(`SELECT * FROM loan_repayments WHERE payroll_detail_id IN (${placeholders})`, detailIds, client);
  for (const r of repayments) {
    await dbRun(`UPDATE loans SET outstanding_balance = outstanding_balance + ?, status = 'active', closed_at = NULL WHERE id = ?`, [r.principal_component, r.loan_id], client);
  }
  if (repayments.length) await dbRun(`DELETE FROM loan_repayments WHERE payroll_detail_id IN (${placeholders})`, detailIds, client);

  const recoveries = await dbAll(`SELECT * FROM advance_recoveries WHERE payroll_detail_id IN (${placeholders})`, detailIds, client);
  for (const r of recoveries) {
    await dbRun(`UPDATE salary_advances SET outstanding_balance = outstanding_balance + ?, status = 'recovering' WHERE id = ?`, [r.amount, r.advance_id], client);
  }
  if (recoveries.length) await dbRun(`DELETE FROM advance_recoveries WHERE payroll_detail_id IN (${placeholders})`, detailIds, client);

  await dbRun(`UPDATE arrears_payments SET status = 'pending', payroll_detail_id = NULL WHERE payroll_detail_id IN (${placeholders})`, detailIds, client);
  await dbRun(`UPDATE leave_encashments SET status = 'approved', payroll_detail_id = NULL WHERE payroll_detail_id IN (${placeholders})`, detailIds, client);
}

// ---------------------------------------------------------------------------
// ATTENDANCE — BLOCK 2
// ---------------------------------------------------------------------------

// -- Shifts -------------------------------------------------------------

async function createShift(data) {
  return (await dbInsert(`
    INSERT INTO shifts (code, name, start_time, end_time, grace_period_minutes, break_minutes, full_day_min_minutes, half_day_min_minutes, is_night_shift)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [data.code, data.name, data.startTime, data.endTime, data.gracePeriodMinutes ?? 10, data.breakMinutes ?? 60,
      data.fullDayMinMinutes ?? 480, data.halfDayMinMinutes ?? 240, data.isNightShift ? 1 : 0])).lastInsertRowid;
}
async function listShifts(activeOnly = true) {
  return activeOnly ? dbAll('SELECT * FROM shifts WHERE active = 1 ORDER BY name') : dbAll('SELECT * FROM shifts ORDER BY name');
}
async function getShift(id, client = prisma) {
  return dbGet('SELECT * FROM shifts WHERE id = ?', [id], client);
}
async function updateShift(id, patch) {
  const fields = { code: 'code', name: 'name', startTime: 'start_time', endTime: 'end_time', gracePeriodMinutes: 'grace_period_minutes',
    breakMinutes: 'break_minutes', fullDayMinMinutes: 'full_day_min_minutes', halfDayMinMinutes: 'half_day_min_minutes', isNightShift: 'is_night_shift', active: 'active' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(fields)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); params.push(k === 'isNightShift' || k === 'active' ? (patch[k] ? 1 : 0) : patch[k]); }
  }
  if (!sets.length) return getShift(id);
  params.push(id);
  await dbRun(`UPDATE shifts SET ${sets.join(', ')} WHERE id = ?`, params);
  return getShift(id);
}

// -- Shift assignments ----------------------------------------------------

async function assignShift(userId, shiftId, effectiveFrom, createdBy) {
  return withTx(async (tx) => {
    // Close any currently-open assignment for this employee the day before the new one starts.
    const dayBefore = dateOnlyMinusOneDay(effectiveFrom);
    await dbRun(`UPDATE shift_assignments SET effective_to = ? WHERE user_id = ? AND effective_to IS NULL AND effective_from < ?`,
      [dayBefore, userId, effectiveFrom], tx);
    const info = await dbInsert(`INSERT INTO shift_assignments (user_id, shift_id, effective_from, created_by) VALUES (?, ?, ?, ?)`,
      [userId, shiftId, effectiveFrom, createdBy], tx);
    return info.lastInsertRowid;
  });
}
function dateOnlyMinusOneDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
async function getShiftForUserOnDate(userId, date, client = prisma) {
  return dbGet(`
    SELECT s.* FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
    WHERE sa.user_id = ? AND sa.effective_from <= ? AND (sa.effective_to IS NULL OR sa.effective_to >= ?)
    ORDER BY sa.effective_from DESC LIMIT 1
  `, [userId, date, date], client);
}
async function listShiftAssignmentsForUser(userId) {
  return dbAll(`
    SELECT sa.*, s.name AS shift_name, s.code AS shift_code FROM shift_assignments sa JOIN shifts s ON s.id = sa.shift_id
    WHERE sa.user_id = ? ORDER BY sa.effective_from DESC
  `, [userId]);
}

// -- Weekly-off configuration (stored in the existing settings table) -----

async function getWeeklyOffDays() {
  const settings = await getSettings();
  if (!settings.weekly_off_days) return [0, 6]; // Sunday, Saturday
  try { return JSON.parse(settings.weekly_off_days); } catch { return [0, 6]; }
}
async function setWeeklyOffDays(days) {
  return updateSettings({ weekly_off_days: JSON.stringify(days) });
}

// -- Daily attendance records ----------------------------------------------

async function getAttendanceRecord(userId, date, client = prisma) {
  return dbGet('SELECT * FROM attendance_records WHERE user_id = ? AND date = ?', [userId, date], client);
}
async function upsertAttendanceRecord(data, client = prisma) {
  return dbInsert(`
    INSERT INTO attendance_records (user_id, date, shift_id, check_in_at, check_out_at, status, worked_minutes, late_minutes, early_leave_minutes, source, notes, marked_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id, date) DO UPDATE SET
      shift_id = COALESCE(excluded.shift_id, attendance_records.shift_id),
      check_in_at = COALESCE(excluded.check_in_at, attendance_records.check_in_at),
      check_out_at = COALESCE(excluded.check_out_at, attendance_records.check_out_at),
      status = excluded.status,
      worked_minutes = excluded.worked_minutes,
      late_minutes = excluded.late_minutes,
      early_leave_minutes = excluded.early_leave_minutes,
      source = excluded.source,
      notes = COALESCE(excluded.notes, attendance_records.notes),
      marked_by = COALESCE(excluded.marked_by, attendance_records.marked_by),
      updated_at = excluded.updated_at
  `, [data.userId, data.date, data.shiftId || null, data.checkInAt || null, data.checkOutAt || null, data.status,
      data.workedMinutes || 0, data.lateMinutes || 0, data.earlyLeaveMinutes || 0, data.source || 'manual', data.notes || null, data.markedBy || null, nowStr()], client);
}
async function listAttendanceRecordsForUserInRange(userId, from, to, client = prisma) {
  return dbAll('SELECT * FROM attendance_records WHERE user_id = ? AND date BETWEEN ? AND ? ORDER BY date', [userId, from, to], client);
}
async function listAttendanceRecordsForDate(date) {
  return dbAll(`
    SELECT ar.*, u.name AS user_name, u.employee_code, u.dept FROM attendance_records ar JOIN users u ON u.id = ar.user_id
    WHERE ar.date = ? ORDER BY u.name
  `, [date]);
}
async function listAttendanceRecordsForUsersInRange(userIds, from, to) {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  return dbAll(`
    SELECT ar.*, u.name AS user_name FROM attendance_records ar JOIN users u ON u.id = ar.user_id
    WHERE ar.user_id IN (${placeholders}) AND ar.date BETWEEN ? AND ? ORDER BY ar.date, u.name
  `, [...userIds, from, to]);
}

// -- Attendance correction / regularization requests -----------------------

async function createAttendanceCorrectionRequest(data) {
  return (await dbInsert(`
    INSERT INTO attendance_correction_requests (user_id, date, attendance_record_id, requested_check_in_at, requested_check_out_at, requested_status, reason)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [data.userId, data.date, data.attendanceRecordId || null, data.requestedCheckInAt || null, data.requestedCheckOutAt || null, data.requestedStatus || null, data.reason || null])).lastInsertRowid;
}
async function getAttendanceCorrectionRequest(id, client = prisma) {
  return dbGet('SELECT * FROM attendance_correction_requests WHERE id = ?', [id], client);
}
async function listAttendanceCorrectionRequestsForUser(userId) {
  return dbAll('SELECT * FROM attendance_correction_requests WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}
async function listAttendanceCorrectionRequests(status) {
  const base = `SELECT r.*, u.name AS user_name FROM attendance_correction_requests r JOIN users u ON u.id = r.user_id`;
  if (status) return dbAll(base + ' WHERE r.status = ? ORDER BY r.created_at DESC', [status]);
  return dbAll(base + ' ORDER BY r.created_at DESC');
}
async function decideAttendanceCorrectionRequest(id, status, actorId, client = prisma) {
  await dbRun(`UPDATE attendance_correction_requests SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?`, [status, actorId, nowStr(), id], client);
}

// ---------------------------------------------------------------------------
// TAX & COMPLIANCE — BLOCK 5 (reporting layer; almost everything else this
// block needs — declarations, proof upload/verify/reject, previous-employer
// income, regime comparison — already existed before this section)
// ---------------------------------------------------------------------------

// Payroll details for one employee across an entire financial year, richest
// available join (adds statutory identifiers) — used for the annual tax
// statement and Form 16 data preparation.
async function getPayrollDetailsForUserInFinancialYear(userId, financialYearId) {
  return dbAll(`
    SELECT pd.*, pr.payroll_month, u.name AS user_name, u.employee_code, u.pan, u.uan, u.pf_number, u.esi_number, u.dept, u.title, u.location
    FROM payroll_details pd
    JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    JOIN users u ON u.id = pd.user_id
    WHERE pd.user_id = ? AND pr.financial_year_id = ? AND pr.status IN ('approved','locked','disbursed')
    ORDER BY pr.payroll_month
  `, [userId, financialYearId]);
}

// Payroll details for every employee across a set of months (a quarter, for
// Form 24Q) — one query instead of one-per-month.
async function getPayrollDetailsForMonths(financialYearId, payrollMonths) {
  if (!payrollMonths.length) return [];
  const placeholders = payrollMonths.map(() => '?').join(',');
  return dbAll(`
    SELECT pd.*, pr.payroll_month, u.name AS user_name, u.employee_code, u.pan, u.uan, u.pf_number, u.esi_number, u.dept, u.title, u.location
    FROM payroll_details pd
    JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    JOIN users u ON u.id = pd.user_id
    WHERE pr.financial_year_id = ? AND pr.payroll_month IN (${placeholders}) AND pr.status IN ('approved','locked','disbursed')
    ORDER BY pr.payroll_month, u.name
  `, [financialYearId, ...payrollMonths]);
}

// ---------------------------------------------------------------------------
// FULL & FINAL SETTLEMENT — BLOCK 6
// ---------------------------------------------------------------------------

async function createSeparation(data) {
  return (await dbInsert(`
    INSERT INTO employee_separations (user_id, resignation_date, last_working_date, notice_period_required_days, reason, initiated_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [data.userId, data.resignationDate, data.lastWorkingDate, data.noticePeriodRequiredDays, data.reason || null, data.initiatedBy])).lastInsertRowid;
}
async function getSeparation(id, client = prisma) {
  return dbGet('SELECT * FROM employee_separations WHERE id = ?', [id], client);
}
async function getActiveSeparationForUser(userId, client = prisma) {
  return dbGet(`SELECT * FROM employee_separations WHERE user_id = ? AND status IN ('pending','approved') ORDER BY created_at DESC LIMIT 1`, [userId], client);
}
async function listSeparations(status) {
  const base = `SELECT s.*, u.name AS user_name, u.employee_code FROM employee_separations s JOIN users u ON u.id = s.user_id`;
  if (status) return dbAll(base + ' WHERE s.status = ? ORDER BY s.created_at DESC', [status]);
  return dbAll(base + ' ORDER BY s.created_at DESC');
}
async function decideSeparation(id, status, actorId) {
  await dbRun(`UPDATE employee_separations SET status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`,
    [status, actorId, nowStr(), nowStr(), id]);
}
async function markSeparationExited(id, client = prisma) {
  await dbRun(`UPDATE employee_separations SET status = 'exited', updated_at = ? WHERE id = ?`, [nowStr(), id], client);
}

async function createFnfSettlement(data, client = prisma) {
  return dbInsert(`
    INSERT INTO fnf_settlements (
      user_id, employee_separation_id, unpaid_salary_days, unpaid_salary_amount, notice_recovery_days, notice_recovery_amount,
      leave_encashment_days, leave_encashment_amount, bonus_amount, gratuity_amount, reimbursements_amount,
      loan_recovery_amount, advance_recovery_amount, asset_recovery_amount, other_deductions_amount, other_deductions_notes,
      total_earnings, total_deductions, final_payable, prepared_by, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [data.userId, data.employeeSeparationId, data.unpaidSalaryDays, data.unpaidSalaryAmount, data.noticeRecoveryDays, data.noticeRecoveryAmount,
      data.leaveEncashmentDays, data.leaveEncashmentAmount, data.bonusAmount, data.gratuityAmount, data.reimbursementsAmount,
      data.loanRecoveryAmount, data.advanceRecoveryAmount, data.assetRecoveryAmount, data.otherDeductionsAmount, data.otherDeductionsNotes || null,
      data.totalEarnings, data.totalDeductions, data.finalPayable, data.preparedBy, nowStr()], client);
}
async function getFnfSettlement(id, client = prisma) {
  return dbGet('SELECT * FROM fnf_settlements WHERE id = ?', [id], client);
}
async function getFnfSettlementBySeparation(employeeSeparationId, client = prisma) {
  return dbGet('SELECT * FROM fnf_settlements WHERE employee_separation_id = ?', [employeeSeparationId], client);
}
async function listFnfSettlements(status) {
  const base = `SELECT f.*, u.name AS user_name, u.employee_code, s.last_working_date FROM fnf_settlements f JOIN users u ON u.id = f.user_id JOIN employee_separations s ON s.id = f.employee_separation_id`;
  if (status) return dbAll(base + ' WHERE f.status = ? ORDER BY f.created_at DESC', [status]);
  return dbAll(base + ' ORDER BY f.created_at DESC');
}
async function updateFnfSettlementLineItems(id, data, client = prisma) {
  await dbRun(`
    UPDATE fnf_settlements SET
      unpaid_salary_days = ?, unpaid_salary_amount = ?, notice_recovery_days = ?, notice_recovery_amount = ?,
      leave_encashment_days = ?, leave_encashment_amount = ?, bonus_amount = ?, gratuity_amount = ?, reimbursements_amount = ?,
      loan_recovery_amount = ?, advance_recovery_amount = ?, asset_recovery_amount = ?, other_deductions_amount = ?, other_deductions_notes = ?,
      total_earnings = ?, total_deductions = ?, final_payable = ?, updated_at = ?
    WHERE id = ?
  `, [data.unpaidSalaryDays, data.unpaidSalaryAmount, data.noticeRecoveryDays, data.noticeRecoveryAmount,
      data.leaveEncashmentDays, data.leaveEncashmentAmount, data.bonusAmount, data.gratuityAmount, data.reimbursementsAmount,
      data.loanRecoveryAmount, data.advanceRecoveryAmount, data.assetRecoveryAmount, data.otherDeductionsAmount, data.otherDeductionsNotes || null,
      data.totalEarnings, data.totalDeductions, data.finalPayable, nowStr(), id], client);
}
async function decideFnfSettlement(id, status, actorId, client = prisma) {
  if (status === 'approved') {
    await dbRun(`UPDATE fnf_settlements SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`, [actorId, nowStr(), nowStr(), id], client);
  } else {
    await dbRun(`UPDATE fnf_settlements SET status = ?, updated_at = ? WHERE id = ?`, [status, nowStr(), id], client);
  }
}
async function markFnfSettlementPaid(id, client = prisma) {
  await dbRun(`UPDATE fnf_settlements SET status = 'paid', paid_at = ?, updated_at = ? WHERE id = ?`, [nowStr(), nowStr(), id], client);
}
async function submitFnfSettlementForApproval(id, client = prisma) {
  await dbRun(`UPDATE fnf_settlements SET status = 'pending_approval', updated_at = ? WHERE id = ?`, [nowStr(), id], client);
}
async function deactivateUser(userId, client = prisma) {
  await dbRun(`UPDATE users SET active = 0 WHERE id = ?`, [userId], client);
}

// ---------------------------------------------------------------------------
// ADVANCED LEAVE MANAGEMENT — BLOCK 3
// ---------------------------------------------------------------------------

// -- Leave policies (employee/department overrides of a leave type) --------

async function createLeavePolicy(data) {
  return (await dbInsert(`
    INSERT INTO leave_policies (
      leave_type_id, department_name, user_id, annual_days, accrual_method, monthly_accrual_days,
      carry_forward_enabled, max_carry_forward_days, carry_forward_expiry_months,
      min_service_days_before_eligible, allow_negative_balance, max_negative_days, is_sandwich_leave, unit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [data.leaveTypeId, data.departmentName || null, data.userId || null, data.annualDays, data.accrualMethod || 'annual', data.monthlyAccrualDays ?? null,
      data.carryForwardEnabled ? 1 : 0, data.maxCarryForwardDays || 0, data.carryForwardExpiryMonths ?? 3,
      data.minServiceDaysBeforeEligible || 0, data.allowNegativeBalance ? 1 : 0, data.maxNegativeDays || 0,
      data.isSandwichLeave ? 1 : 0, data.unit || 'day'])).lastInsertRowid;
}
async function listLeavePoliciesForType(leaveTypeId) {
  return dbAll('SELECT * FROM leave_policies WHERE leave_type_id = ? ORDER BY user_id NULLS LAST, department_name NULLS LAST', [leaveTypeId]);
}
async function getLeavePolicyById(id) {
  return dbGet('SELECT * FROM leave_policies WHERE id = ?', [id]);
}
async function updateLeavePolicy(id, patch) {
  const fields = { annualDays: 'annual_days', accrualMethod: 'accrual_method', monthlyAccrualDays: 'monthly_accrual_days',
    carryForwardEnabled: 'carry_forward_enabled', maxCarryForwardDays: 'max_carry_forward_days', carryForwardExpiryMonths: 'carry_forward_expiry_months',
    minServiceDaysBeforeEligible: 'min_service_days_before_eligible', allowNegativeBalance: 'allow_negative_balance', maxNegativeDays: 'max_negative_days',
    isSandwichLeave: 'is_sandwich_leave', unit: 'unit' };
  const boolFields = new Set(['carryForwardEnabled', 'allowNegativeBalance', 'isSandwichLeave']);
  const sets = [], params = [];
  for (const [k, col] of Object.entries(fields)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); params.push(boolFields.has(k) ? (patch[k] ? 1 : 0) : patch[k]); }
  }
  if (!sets.length) return getLeavePolicyById(id);
  sets.push('updated_at = ?'); params.push(nowStr());
  params.push(id);
  await dbRun(`UPDATE leave_policies SET ${sets.join(', ')} WHERE id = ?`, params);
  return getLeavePolicyById(id);
}
async function deleteLeavePolicy(id) {
  await dbRun('DELETE FROM leave_policies WHERE id = ?', [id]);
}
// Resolution order: employee-specific row > department-specific row > null
// (caller falls back to the leave type's own defaults when this is null).
async function resolveLeavePolicy(userId, leaveTypeId, client = prisma) {
  const employeeSpecific = await dbGet('SELECT * FROM leave_policies WHERE leave_type_id = ? AND user_id = ?', [leaveTypeId, userId], client);
  if (employeeSpecific) return employeeSpecific;
  const user = await dbGet('SELECT dept FROM users WHERE id = ?', [userId], client);
  if (user && user.dept) {
    const deptSpecific = await dbGet('SELECT * FROM leave_policies WHERE leave_type_id = ? AND department_name = ?', [leaveTypeId, user.dept], client);
    if (deptSpecific) return deptSpecific;
  }
  return null;
}

// -- Comp-off ----------------------------------------------------------

async function createCompOffRequest(data) {
  return (await dbInsert(`
    INSERT INTO comp_offs (user_id, worked_date, earned_days, reason) VALUES (?, ?, ?, ?)
  `, [data.userId, data.workedDate, data.earnedDays || 1, data.reason || null])).lastInsertRowid;
}
async function getCompOff(id, client = prisma) {
  return dbGet('SELECT * FROM comp_offs WHERE id = ?', [id], client);
}
async function listCompOffsForUser(userId) {
  return dbAll('SELECT * FROM comp_offs WHERE user_id = ? ORDER BY created_at DESC', [userId]);
}
async function listCompOffs(status) {
  const base = `SELECT c.*, u.name AS user_name FROM comp_offs c JOIN users u ON u.id = c.user_id`;
  if (status) return dbAll(base + ' WHERE c.status = ? ORDER BY c.created_at DESC', [status]);
  return dbAll(base + ' ORDER BY c.created_at DESC');
}
async function decideCompOff(id, status, actorId, expiryMonths) {
  if (status === 'approved') {
    const expiresOn = nowStrOffsetDays(30 * (expiryMonths ?? 3));
    await dbRun(`UPDATE comp_offs SET status = 'approved', approved_by = ?, approved_at = ?, expires_on = ? WHERE id = ?`, [actorId, nowStr(), expiresOn, id]);
  } else {
    await dbRun(`UPDATE comp_offs SET status = ?, approved_by = ?, approved_at = ? WHERE id = ?`, [status, actorId, nowStr(), id]);
  }
}
async function markCompOffUsed(id, applicationId, client = prisma) {
  await dbRun(`UPDATE comp_offs SET status = 'used', used_in_application_id = ? WHERE id = ?`, [applicationId, id], client);
}
async function listApprovedUnexpiredCompOffsForUser(userId, client = prisma) {
  const today = nowStrOffsetDays(0).slice(0, 10);
  return dbAll(`SELECT * FROM comp_offs WHERE user_id = ? AND status = 'approved' AND (expires_on IS NULL OR expires_on >= ?) ORDER BY worked_date`, [userId, today], client);
}
async function expireStaleCompOffs() {
  const today = nowStrOffsetDays(0).slice(0, 10);
  const rows = await dbAll(`SELECT id FROM comp_offs WHERE status = 'approved' AND expires_on IS NOT NULL AND expires_on < ?`, [today]);
  if (rows.length) await dbRun(`UPDATE comp_offs SET status = 'expired' WHERE status = 'approved' AND expires_on IS NOT NULL AND expires_on < ?`, [today]);
  return rows.length;
}

// -- Multi-level approval audit trail ---------------------------------

async function createLeaveApproval(data, client = prisma) {
  await dbRun(`INSERT INTO leave_approvals (leave_application_id, level, approver_id, decision, comment) VALUES (?, ?, ?, ?, ?)`,
    [data.leaveApplicationId, data.level, data.approverId, data.decision, data.comment || null], client);
}
async function listLeaveApprovalsForApplication(applicationId) {
  return dbAll('SELECT * FROM leave_approvals WHERE leave_application_id = ? ORDER BY level, decided_at', [applicationId]);
}
async function advanceLeaveApprovalLevel(applicationId, client = prisma) {
  await dbRun(`UPDATE leave_applications SET current_approval_level = current_approval_level + 1 WHERE id = ?`, [applicationId], client);
}
async function setLeaveApplicationRequiredLevels(applicationId, levels, client = prisma) {
  await dbRun(`UPDATE leave_applications SET required_approval_levels = ? WHERE id = ?`, [levels, applicationId], client);
}
async function getLeaveApplicationRow(id, client = prisma) {
  return dbGet('SELECT * FROM leave_applications WHERE id = ?', [id], client);
}

// -- Balances: carry-forward + monthly accrual --------------------------

async function listLeaveBalancesForUser(userId, year) {
  return dbAll(`
    SELECT lb.*, lt.name AS leave_type_name FROM leave_balances lb JOIN leave_types lt ON lt.id = lb.leave_type_id
    WHERE lb.user_id = ? AND lb.year = ? ORDER BY lt.name
  `, [userId, year]);
}
async function getLeaveBalanceRow(userId, leaveTypeId, year, client = prisma) {
  return dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [userId, leaveTypeId, year], client);
}
async function upsertLeaveBalance(userId, leaveTypeId, year, data, client = prisma) {
  const existing = await getLeaveBalanceRow(userId, leaveTypeId, year, client);
  if (existing) {
    const sets = [], params = [];
    for (const [col, val] of Object.entries(data)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(existing.id);
    await dbRun(`UPDATE leave_balances SET ${sets.join(', ')} WHERE id = ?`, params, client);
  } else {
    const cols = ['user_id', 'leave_type_id', 'year', ...Object.keys(data)];
    const placeholders = cols.map(() => '?').join(',');
    await dbRun(`INSERT INTO leave_balances (${cols.join(',')}) VALUES (${placeholders})`, [userId, leaveTypeId, year, ...Object.values(data)], client);
  }
}
async function listActiveUsersWithLeaveType() {
  return dbAll(`SELECT u.id AS user_id, u.dept, u.joined_date, lt.id AS leave_type_id, lt.default_annual_days FROM users u CROSS JOIN leave_types lt WHERE u.active = 1 AND lt.active = 1`);
}

// -- Leave calendar / conflict detection ---------------------------------

async function getLeaveCalendarRange(userIds, from, to) {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  return dbAll(`
    SELECT la.*, u.name AS user_name, lt.name AS leave_type_name
    FROM leave_applications la JOIN users u ON u.id = la.user_id JOIN leave_types lt ON lt.id = la.leave_type_id
    WHERE la.user_id IN (${placeholders}) AND la.status IN ('approved','pending')
      AND la.from_date <= ? AND la.to_date >= ?
    ORDER BY la.from_date
  `, [...userIds, to, from]);
}
async function countOverlappingApprovedLeave(userIds, from, to, excludeApplicationId) {
  if (!userIds.length) return [];
  const placeholders = userIds.map(() => '?').join(',');
  let sql = `
    SELECT la.user_id, u.name AS user_name, la.from_date, la.to_date
    FROM leave_applications la JOIN users u ON u.id = la.user_id
    WHERE la.user_id IN (${placeholders}) AND la.status = 'approved' AND la.from_date <= ? AND la.to_date >= ?
  `;
  const params = [...userIds, to, from];
  if (excludeApplicationId) { sql += ' AND la.id != ?'; params.push(excludeApplicationId); }
  return dbAll(sql, params);
}

// ---------------------------------------------------------------------------
// ADVANCED EMPLOYEE LIFECYCLE — BLOCK 1
// ---------------------------------------------------------------------------

async function createLifecycleEvent(data, client = prisma) {
  await dbRun(`
    INSERT INTO employee_lifecycle_events (user_id, event_type, previous_value, new_value, effective_date, notes, recorded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `, [data.userId, data.eventType, data.previousValue ?? null, data.newValue ?? null, data.effectiveDate, data.notes || null, data.recordedBy], client);
}
async function listLifecycleEventsForUser(userId) {
  return dbAll('SELECT * FROM employee_lifecycle_events WHERE user_id = ? ORDER BY effective_date DESC, created_at DESC', [userId]);
}
async function updateLifecycleStatus(userId, status, client = prisma) {
  await dbRun('UPDATE users SET lifecycle_status = ? WHERE id = ?', [status, userId], client);
}

// -- Probation -----------------------------------------------------------

async function createProbationRecord(data) {
  return (await dbInsert(`
    INSERT INTO probation_records (user_id, start_date, expected_end_date, notes) VALUES (?, ?, ?, ?)
  `, [data.userId, data.startDate, data.expectedEndDate, data.notes || null])).lastInsertRowid;
}
async function getActiveProbationForUser(userId) {
  return dbGet(`SELECT * FROM probation_records WHERE user_id = ? AND status IN ('on_probation','extended') ORDER BY created_at DESC LIMIT 1`, [userId]);
}
async function getProbationRecord(id) {
  return dbGet('SELECT * FROM probation_records WHERE id = ?', [id]);
}
async function confirmProbationRecord(id, actorId) {
  await dbRun(`UPDATE probation_records SET status = 'confirmed', actual_confirmation_date = ?, confirmed_by = ?, updated_at = ? WHERE id = ?`,
    [nowStr().slice(0, 10), actorId, nowStr(), id]);
}
async function extendProbationRecord(id, newEndDate, notes) {
  await dbRun(`UPDATE probation_records SET status = 'extended', extended_to_date = ?, notes = ?, updated_at = ? WHERE id = ?`,
    [newEndDate, notes || null, nowStr(), id]);
}

// -- Documents -------------------------------------------------------------

async function createEmployeeDocument(data) {
  return (await dbInsert(`
    INSERT INTO employee_documents (user_id, doc_type, file_path, issue_date, expiry_date, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)
  `, [data.userId, data.docType, data.filePath || null, data.issueDate || null, data.expiryDate || null, data.uploadedBy])).lastInsertRowid;
}
async function listDocumentsForUser(userId) {
  return dbAll('SELECT * FROM employee_documents WHERE user_id = ? ORDER BY uploaded_at DESC', [userId]);
}
async function listExpiringDocuments(daysAhead) {
  const cutoff = nowStrOffsetDays(daysAhead || 30).slice(0, 10);
  const today = nowStrOffsetDays(0).slice(0, 10);
  return dbAll(`
    SELECT d.*, u.name AS user_name FROM employee_documents d JOIN users u ON u.id = d.user_id
    WHERE d.expiry_date IS NOT NULL AND d.expiry_date >= ? AND d.expiry_date <= ? ORDER BY d.expiry_date
  `, [today, cutoff]);
}

// -- Checklists (onboarding / offboarding) ---------------------------------

async function listChecklistTemplateItems(type) {
  return dbAll('SELECT * FROM checklist_template_items WHERE type = ? AND active = 1 ORDER BY display_order', [type]);
}
async function listAllChecklistTemplateItems() {
  return dbAll('SELECT * FROM checklist_template_items ORDER BY type, display_order');
}
async function createChecklistTemplateItem(data) {
  return (await dbInsert(`
    INSERT INTO checklist_template_items (type, label, description, display_order) VALUES (?, ?, ?, ?)
  `, [data.type, data.label, data.description || null, data.displayOrder || 0])).lastInsertRowid;
}
async function updateChecklistTemplateItem(id, patch) {
  const fields = { label: 'label', description: 'description', displayOrder: 'display_order', active: 'active' };
  const sets = [], params = [];
  for (const [k, col] of Object.entries(fields)) {
    if (patch[k] !== undefined) { sets.push(`${col} = ?`); params.push(k === 'active' ? (patch[k] ? 1 : 0) : patch[k]); }
  }
  if (!sets.length) return;
  params.push(id);
  await dbRun(`UPDATE checklist_template_items SET ${sets.join(', ')} WHERE id = ?`, params);
}
async function createChecklistTask(data, client = prisma) {
  await dbRun(`
    INSERT INTO employee_checklist_tasks (user_id, employee_separation_id, template_item_id, type, label)
    VALUES (?, ?, ?, ?, ?)
  `, [data.userId, data.employeeSeparationId || null, data.templateItemId || null, data.type, data.label], client);
}
async function listChecklistTasksForUser(userId, type) {
  if (type) return dbAll('SELECT * FROM employee_checklist_tasks WHERE user_id = ? AND type = ? ORDER BY id', [userId, type]);
  return dbAll('SELECT * FROM employee_checklist_tasks WHERE user_id = ? ORDER BY type, id', [userId]);
}
async function listChecklistTasksForSeparation(separationId) {
  return dbAll('SELECT * FROM employee_checklist_tasks WHERE employee_separation_id = ? ORDER BY id', [separationId]);
}
async function completeChecklistTask(id, actorId, notes) {
  await dbRun(`UPDATE employee_checklist_tasks SET status = 'completed', completed_by = ?, completed_at = ?, notes = ? WHERE id = ?`,
    [actorId, nowStr(), notes || null, id]);
}

// -- Exit interview ---------------------------------------------------------

async function createExitInterview(data) {
  return (await dbInsert(`
    INSERT INTO exit_interviews (employee_separation_id, conducted_by, reason_for_leaving, feedback, would_rehire, rating)
    VALUES (?, ?, ?, ?, ?, ?)
  `, [data.employeeSeparationId, data.conductedBy, data.reasonForLeaving || null, data.feedback || null,
      data.wouldRehire === undefined ? null : (data.wouldRehire ? 1 : 0), data.rating ?? null])).lastInsertRowid;
}
async function getExitInterview(separationId) {
  return dbGet('SELECT * FROM exit_interviews WHERE employee_separation_id = ?', [separationId]);
}

module.exports = {
  prisma,
  dbGet,
  dbAll,
  dbRun,
  dbInsert,
  withTx,
  healthCheck,
  ensureRuntimeDefaults,
  getSettings,
  updateSettings,
  findUserByEmail,
  findUserById,
  listUsers,
  listAllUsersFlat,
  listDirectReports,
  ensureLeaveBalance,
  createUser,
  bulkImportUsersFromCsv,
  updateUserAdmin,
  updateProfile,
  notify,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  nextTimesheetId,
  listTimesheetsForUser,
  getTimesheetForWeek,
  listAllTimesheets,
  getTimesheetEntries,
  findMissingDays,
  checkTimesheetLock,
  computeOvertime,
  saveTimesheet,
  decideTimesheet,
  requestTimesheetCorrection,
  listCorrectionRequests,
  decideCorrection,
  bulkDecideTimesheets,
  listLeaveTypes,
  getLeaveType,
  createLeaveType,
  updateLeaveType,
  deleteLeaveType,
  getLeaveBalances,
  adjustLeaveBalance,
  nextLeaveId,
  listLeaveForUser,
  listAllLeave,
  listTeamLeave,
  checkOverlap,
  checkBlackout,
  applyForLeave,
  cancelLeave,
  decideLeave,
  bulkDecideLeave,
  listHolidays,
  addHoliday,
  deleteHoliday,
  isHoliday,
  getHolidaysInRange,
  listProjects,
  createProject,
  updateProject,
  listTasks,
  listAllTasks,
  createTask,
  updateTask,
  listProjectsForUser,
  listProjectAssignments,
  listUserProjectIds,
  setProjectAssignments,
  listDepartments,
  createDepartment,
  updateDepartment,
  getAuditLog,
  resolveManagerScope,
  canAccessEmployeePayroll,
  weeklyHoursTrend,
  teamHoursSummary,
  runEscalationCheck,
  runYearEndCarryForward,
  listFinancialYears,
  getFinancialYear,
  getActiveFinancialYear,
  createFinancialYear,
  setActiveFinancialYear,
  listSalaryComponents,
  getSalaryComponent,
  getSalaryComponentByCode,
  createSalaryComponent,
  updateSalaryComponent,
  getActiveSalaryStructure,
  getSalaryStructureAsOf,
  listSalaryStructuresForEmployee,
  getSalaryStructureById,
  getStructureComponents,
  insertSalaryStructureRow,
  insertStructureComponent,
  findOrCreateSalaryComponentByName,
  replaceStructureComponents,
  supersedeActiveStructures,
  activateSalaryStructure,
  updateSalaryStructureBasics,
  attachOfferLetter,
  listTaxRegimes,
  getTaxRegime,
  getDefaultTaxRegime,
  listTaxSlabs,
  listTaxRules,
  getTaxRule,
  upsertTaxRule,
  insertTaxSlab,
  insertTaxRegime,
  listDeductionLimits,
  getDeductionLimit,
  upsertDeductionLimit,
  getEmployeeTaxRegime,
  setEmployeeTaxRegime,
  listTaxDeclarationSections,
  insertTaxDeclarationSection,
  getOrCreateDeclaration,
  getDeclarationById,
  listDeclarationsForUser,
  listDeclarationEntries,
  addDeclarationEntry,
  deleteDeclarationEntry,
  updateDeclarationEntryStatus,
  recomputeDeclaredAmount,
  submitTaxDeclarations,
  verifyTaxDeclaration,
  rejectTaxDeclaration,
  getApprovedDeclarationsTotal,
  listFixedDeductions,
  addFixedDeduction,
  deactivateFixedDeduction,
  listVariableDeductions,
  addVariableDeduction,
  removeVariableDeduction,
  getPreviousEmployerIncome,
  upsertPreviousEmployerIncome,
  getPayrollRun,
  getPayrollRunByMonth,
  listPayrollRuns,
  getOrCreatePayrollRun,
  updatePayrollRunTotals,
  setPayrollRunStatus,
  clearPayrollDetailsForRun,
  deletePayrollRun,
  getPayrollDashboardData,
  insertPayrollDetail,
  listPayrollDetails,
  getPayrollDetail,
  getPayrollDetailForUser,
  listPayrollHistoryForUser,
  updatePayrollDetailStatus,
  applyPayrollAdjustmentToDetail,
  createPayslip,
  getPayslip,
  getPayslipForDetail,
  listPayslipsForEmployee,
  markPayslipDownloaded,
  addPayrollException,
  listPayrollExceptions,
  resolveException,
  createPayrollAdjustment,
  listPayrollAdjustments,
  decidePayrollAdjustment,
  logPayrollAudit,
  getPayrollAuditLog,
  insertSalaryRevision,
  listSalaryRevisionsForUser,
  listRecentSalaryRevisions,
  listEmployeesWithPayrollStatus,
  // loans
  createLoan,
  getLoan,
  listLoansForUser,
  listLoans,
  decideLoan,
  disburseLoan,
  listActiveLoansForUser,
  applyLoanRepayment,
  listLoanRepayments,
  cancelLoan,
  // salary advances
  createSalaryAdvance,
  getSalaryAdvance,
  listSalaryAdvancesForUser,
  listSalaryAdvances,
  decideSalaryAdvance,
  listRecoveringAdvancesForUser,
  applyAdvanceRecovery,
  listAdvanceRecoveries,
  // leave encashment
  createLeaveEncashmentRequest,
  getLeaveEncashment,
  listLeaveEncashmentsForUser,
  listLeaveEncashments,
  decideLeaveEncashment,
  listApprovedUnpaidEncashmentsForUser,
  markLeaveEncashmentPaid,
  // arrears
  createArrearsPayment,
  listArrearsForUser,
  listPendingArrearsForUser,
  markArrearsPaid,
  // comparison/variance
  getPayrollDetailsByMonth,
  reversePayrollSideEffectsForRun,
  listSettledPayrollMonthsForUser,
  // attendance
  createShift,
  listShifts,
  getShift,
  updateShift,
  assignShift,
  getShiftForUserOnDate,
  listShiftAssignmentsForUser,
  getWeeklyOffDays,
  setWeeklyOffDays,
  getAttendanceRecord,
  upsertAttendanceRecord,
  listAttendanceRecordsForUserInRange,
  listAttendanceRecordsForDate,
  listAttendanceRecordsForUsersInRange,
  createAttendanceCorrectionRequest,
  getAttendanceCorrectionRequest,
  listAttendanceCorrectionRequestsForUser,
  listAttendanceCorrectionRequests,
  decideAttendanceCorrectionRequest,
  // compliance (Block 5)
  getPayrollDetailsForUserInFinancialYear,
  getPayrollDetailsForMonths,
  // full & final settlement (Block 6)
  createSeparation,
  getSeparation,
  getActiveSeparationForUser,
  listSeparations,
  decideSeparation,
  markSeparationExited,
  createFnfSettlement,
  getFnfSettlement,
  getFnfSettlementBySeparation,
  listFnfSettlements,
  updateFnfSettlementLineItems,
  decideFnfSettlement,
  markFnfSettlementPaid,
  submitFnfSettlementForApproval,
  deactivateUser,
  // advanced leave management (Block 3)
  createLeavePolicy,
  listLeavePoliciesForType,
  getLeavePolicyById,
  updateLeavePolicy,
  deleteLeavePolicy,
  resolveLeavePolicy,
  createCompOffRequest,
  getCompOff,
  listCompOffsForUser,
  listCompOffs,
  decideCompOff,
  markCompOffUsed,
  listApprovedUnexpiredCompOffsForUser,
  expireStaleCompOffs,
  createLeaveApproval,
  listLeaveApprovalsForApplication,
  advanceLeaveApprovalLevel,
  setLeaveApplicationRequiredLevels,
  getLeaveApplicationRow,
  listLeaveBalancesForUser,
  getLeaveBalanceRow,
  upsertLeaveBalance,
  listActiveUsersWithLeaveType,
  getLeaveCalendarRange,
  countOverlappingApprovedLeave,
  // advanced employee lifecycle (Block 1)
  createLifecycleEvent,
  listLifecycleEventsForUser,
  updateLifecycleStatus,
  createProbationRecord,
  getActiveProbationForUser,
  getProbationRecord,
  confirmProbationRecord,
  extendProbationRecord,
  createEmployeeDocument,
  listDocumentsForUser,
  listExpiringDocuments,
  listChecklistTemplateItems,
  listAllChecklistTemplateItems,
  createChecklistTemplateItem,
  updateChecklistTemplateItem,
  createChecklistTask,
  listChecklistTasksForUser,
  listChecklistTasksForSeparation,
  completeChecklistTask,
  createExitInterview,
  getExitInterview,
};
