// src/server.js — Express HTTP layer for the Vasjo Technologies Timesheet
// Portal backend. Ported from the original hand-rolled http.createServer
// router (src/server.js, SQLite version) — same routes, same request/response
// shapes, same status codes and error messages, now expressed as Express
// routes calling into the async db/auth/payroll/reports modules.
//
// Static file serving for a bundled frontend build was part of the original
// server; this migration is backend-only (per the migration brief the
// frontend is out of scope), so that section is omitted here. If you need
// it, add `express.static(path.join(__dirname, '..', 'public'))` back in.

require('dotenv').config();
const express = require('express');
const crypto = require('node:crypto');

const db = require('./db');
const auth = require('./auth');
const payroll = require('./payroll');
const attendance = require('./attendance');
const compliance = require('./compliance');
const fnf = require('./fnf');
const leave = require('./leave');
const lifecycle = require('./lifecycle');
const reports = require('./reports');
const { numSetting, nowStr } = require('./utils');

const PORT = parseInt(process.env.PORT || '3001', 10);
const IS_PROD = process.env.NODE_ENV === 'production';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));

// asyncHandler: Express 4 doesn't auto-catch rejected promises from async
// route handlers, so every route below is wrapped with this. Turns thrown
// Errors with a `.code` (the original code's convention for
// business-rule violations, e.g. OVERLAP, INSUFFICIENT_BALANCE,
// PERIOD_LOCKED) into 400s with the same `{ error, code }` shape the
// frontend already expects; anything else is a 500.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch((err) => {
    if (err.code && err.httpStatus !== 500) {
      return res.status(err.httpStatus || 400).json({ error: err.message, code: err.code });
    }
    console.error(err);
    res.status(500).json({ error: IS_PROD ? 'Internal server error' : err.message });
  });
}

app.use(auth.attachSession);
app.use(auth.csrfProtection);

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

app.post('/api/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  const lock = auth.checkLoginLock(email);
  if (lock.locked) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${Math.ceil(lock.retryAfterMs / 60000)} minute(s).` });
  }

  const user = await db.findUserByEmail(String(email).trim().toLowerCase());
  if (!user || !user.active || !auth.verifyPassword(password, user.password_hash, user.password_salt)) {
    auth.recordLoginFailure(email);
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  auth.clearLoginFailures(email);

  const { token, csrfToken } = await auth.createSession(user.id);
  res.cookie('session', token, {
    httpOnly: true, sameSite: 'lax', secure: IS_PROD, maxAge: 1000 * 60 * 60 * 12, path: '/',
  });
  const mustReset = !!user.must_reset_password;
  delete user.password_hash; delete user.password_salt;
  res.json({ user, csrfToken, mustReset });
}));

app.post('/api/logout', asyncHandler(async (req, res) => {
  if (req.session.token) await auth.deleteSession(req.session.token);
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
}));

app.get('/api/me', asyncHandler(async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: 'Not signed in' });
  res.json({ user: req.session.user, csrfToken: req.session.user._csrfToken });
}));

app.post('/api/change-password', auth.requireAuth, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
  await auth.changePassword(req.session.user.id, currentPassword, newPassword);
  res.json({ ok: true });
}));

app.post('/api/users/:id/reset-password', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const user = await db.findUserById(id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const tempPassword = await auth.adminResetPassword(id);
  res.json({ tempPassword, userName: user.name, userEmail: user.email });
}));

// ---------------------------------------------------------------------------
// USERS / PROFILE / ADMIN DIRECTORY
// ---------------------------------------------------------------------------

app.patch('/api/me', auth.requireAuth, asyncHandler(async (req, res) => {
  await db.updateProfile(req.session.user.id, req.body || {});
  const updated = await db.findUserById(req.session.user.id);
  delete updated.password_hash; delete updated.password_salt;
  res.json({ user: updated });
}));

app.get('/api/users/flat', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ users: await db.listAllUsersFlat() });
}));

app.get('/api/team-members', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  res.json({ members: await db.listDirectReports(req.session.user.id) });
}));

app.get('/api/users/:id', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const user = await db.findUserById(parseInt(req.params.id, 10));
  if (!user) return res.status(404).json({ error: 'User not found' });
  delete user.password_hash; delete user.password_salt;
  res.json(user);
}));

// Generic listing (used e.g. to populate the "assign employees" picklist on
// the admin Projects page). Kept admin-only since it surfaces CTC/salary
// columns alongside each user row.
app.get('/api/users', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page, 10) || 1;
  const pageSize = parseInt(req.query.pageSize, 10) || 50;
  res.json(await db.listUsers({ page, pageSize }));
}));

app.get('/api/admin/employees', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { page, pageSize, search, department, status, sortBy, sortDir } = req.query;
  res.json(await db.listUsers({
    page: parseInt(page, 10) || 1,
    pageSize: parseInt(pageSize, 10) || 50,
    search: search || '', department: department || '', status: status || '',
    sortBy: sortBy || 'name', sortDir: sortDir || 'asc',
  }));
}));

app.get('/api/admin/departments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  // Admin directory filters expect department names, not department objects.
  // Keep the generic /api/departments endpoint unchanged for other callers.
  const departments = await db.listDepartments(false);
  res.json({ departments: departments.map((d) => d.name) });
}));

app.post('/api/users', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = await db.createUser(req.body || {});
  try { await lifecycle.initializeLifecycle(id, req.session.user.id); }
  catch (e) { /* lifecycle bootstrap failing shouldn't block user creation itself */ }
  res.status(201).json({ id });
}));

app.patch('/api/users/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateUserAdmin(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

app.post('/api/users/import-csv', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { csv } = req.body || {};
  if (!csv) return res.status(400).json({ error: 'csv text is required' });
  res.json(await db.bulkImportUsersFromCsv(csv));
}));

// ---------------------------------------------------------------------------
// ADVANCED EMPLOYEE LIFECYCLE — BLOCK 1
// ---------------------------------------------------------------------------

app.get('/api/lifecycle/employees/:userId/profile', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertAttendanceAccess(req, userId);
  res.json(await lifecycle.getEmployeeLifecycleProfile(userId));
}));

app.post('/api/lifecycle/employees/:userId/transfer-department', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.transferDepartment({ userId: parseInt(req.params.userId, 10), ...req.body, actorId: req.session.user.id }));
}));
app.post('/api/lifecycle/employees/:userId/change-designation', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.changeDesignation({ userId: parseInt(req.params.userId, 10), ...req.body, actorId: req.session.user.id }));
}));
app.post('/api/lifecycle/employees/:userId/change-manager', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.changeManager({ userId: parseInt(req.params.userId, 10), ...req.body, actorId: req.session.user.id }));
}));
app.post('/api/lifecycle/employees/:userId/change-location', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.changeLocation({ userId: parseInt(req.params.userId, 10), ...req.body, actorId: req.session.user.id }));
}));
app.post('/api/lifecycle/employees/:userId/promote', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.promoteEmployee({ userId: parseInt(req.params.userId, 10), ...req.body, actorId: req.session.user.id }));
}));

app.post('/api/lifecycle/employees/:userId/probation/start', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.status(201).json(await lifecycle.startProbation({ userId: parseInt(req.params.userId, 10), ...req.body, actorId: req.session.user.id }));
}));
app.post('/api/lifecycle/probation/:id/confirm', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.confirmProbation(parseInt(req.params.id, 10), req.session.user.id, req.body ? req.body.notes : undefined));
}));
app.post('/api/lifecycle/probation/:id/extend', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { newEndDate, notes } = req.body || {};
  if (!newEndDate) return res.status(400).json({ error: 'newEndDate is required' });
  res.json(await lifecycle.extendProbation(parseInt(req.params.id, 10), newEndDate, req.session.user.id, notes));
}));

app.get('/api/lifecycle/employees/:userId/documents', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertAttendanceAccess(req, userId);
  res.json(await db.listDocumentsForUser(userId));
}));
app.post('/api/lifecycle/employees/:userId/documents', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = await lifecycle.uploadDocument({ userId: parseInt(req.params.userId, 10), ...req.body, uploadedBy: req.session.user.id });
  res.status(201).json({ id });
}));
app.get('/api/lifecycle/documents/expiring', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await lifecycle.getExpiringDocuments(req.query.daysAhead ? parseInt(req.query.daysAhead, 10) : undefined));
}));

app.get('/api/lifecycle/checklist/templates', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(req.query.type ? await db.listChecklistTemplateItems(req.query.type) : await db.listAllChecklistTemplateItems());
}));
app.post('/api/lifecycle/checklist/templates', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = await db.createChecklistTemplateItem(req.body || {});
  res.status(201).json({ id });
}));
app.put('/api/lifecycle/checklist/templates/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateChecklistTemplateItem(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));
app.get('/api/lifecycle/employees/:userId/checklist', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertAttendanceAccess(req, userId);
  res.json(await db.listChecklistTasksForUser(userId, req.query.type));
}));
app.post('/api/lifecycle/checklist/tasks/:id/complete', auth.requireAuth, asyncHandler(async (req, res) => {
  await lifecycle.completeChecklistTask(parseInt(req.params.id, 10), req.session.user.id, req.body ? req.body.notes : undefined);
  res.json({ ok: true });
}));

app.post('/api/fnf/separations/:id/exit-interview', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const interview = await lifecycle.recordExitInterview({ employeeSeparationId: parseInt(req.params.id, 10), ...req.body, conductedBy: req.session.user.id });
  res.status(201).json(interview);
}));
app.get('/api/fnf/separations/:id/exit-interview', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.getExitInterview(parseInt(req.params.id, 10)));
}));
app.get('/api/fnf/separations/:id/checklist', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listChecklistTasksForSeparation(parseInt(req.params.id, 10)));
}));

// ---------------------------------------------------------------------------
// NOTIFICATIONS
// ---------------------------------------------------------------------------

app.get('/api/notifications', auth.requireAuth, asyncHandler(async (req, res) => {
  const [items, unreadCount] = await Promise.all([
    db.listNotifications(req.session.user.id, req.query.unread === '1'),
    db.unreadNotificationCount(req.session.user.id),
  ]);
  res.json({ items, unreadCount });
}));

app.get('/api/notifications/unread-count', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ count: await db.unreadNotificationCount(req.session.user.id) });
}));

app.patch('/api/notifications/:id/read', auth.requireAuth, asyncHandler(async (req, res) => {
  await db.markNotificationRead(parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
}));

app.patch('/api/notifications/read-all', auth.requireAuth, asyncHandler(async (req, res) => {
  await db.markAllNotificationsRead(req.session.user.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// TIMESHEETS
// ---------------------------------------------------------------------------

app.get('/api/timesheets', auth.requireAuth, asyncHandler(async (req, res) => {
  const { weekStart, all, page, pageSize, status, employeeId } = req.query;

  // Mode 1: a specific week for the current user (used by the weekly entry
  // screen) — identified by ?weekStart=YYYY-MM-DD.
  if (weekStart) {
    const ts = await db.getTimesheetForWeek(req.session.user.id, weekStart);
    const entries = ts ? await db.getTimesheetEntries(ts.id) : [];
    return res.json({ timesheet: ts || null, entries });
  }

  // Mode 2: manager/admin "all timesheets" queue — ?all=1[&status=][&employeeId=].
  if (all === '1') {
    if (!['manager', 'admin'].includes(req.session.user.role)) {
      const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e;
    }
    const scope = await db.resolveManagerScope(req.session.user);
    const result = await db.listAllTimesheets(status || null, scope, {
      page: parseInt(page, 10) || 1,
      pageSize: parseInt(pageSize, 10) || 20,
      userId: employeeId ? parseInt(employeeId, 10) : undefined,
    });
    return res.json({ timesheets: result.items, total: result.total });
  }

  // Mode 3: the current user's own timesheets, optionally paginated.
  const result = await db.listTimesheetsForUser(req.session.user.id, {
    page: parseInt(page, 10) || 1,
    pageSize: parseInt(pageSize, 10) || 20,
  });
  res.json({ timesheets: result.items, total: result.total });
}));

app.get('/api/timesheets/:id/entries', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.getTimesheetEntries(req.params.id));
}));

app.post('/api/timesheets', auth.requireAuth, asyncHandler(async (req, res) => {
  const { weekStart, entries, submit } = req.body || {};
  if (!weekStart || !Array.isArray(entries)) return res.status(400).json({ error: 'weekStart and entries[] are required' });
  const settings = await db.getSettings();
  const lockWeeks = numSetting(settings.timesheet_lock_weeks, 8);
  db.checkTimesheetLock(weekStart, lockWeeks);
  const id = await db.saveTimesheet(req.session.user.id, weekStart, entries, !!submit, numSetting(settings.standard_hours_per_day, 8));
  res.json({ id });
}));

app.patch('/api/timesheets/:id', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { action, comment } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  await db.decideTimesheet(req.params.id, action, req.session.user.id, comment);
  res.json({ ok: true });
}));

app.post('/api/timesheets/bulk-decide', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { ids, action, comment } = req.body || {};
  if (!Array.isArray(ids) || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'ids[] and action are required' });
  res.json(await db.bulkDecideTimesheets(ids, action, req.session.user.id, comment));
}));

app.post('/api/timesheets/:id/request-correction', auth.requireAuth, asyncHandler(async (req, res) => {
  await db.requestTimesheetCorrection(req.params.id, req.session.user.id, (req.body || {}).reason);
  res.json({ ok: true });
}));

app.get('/api/correction-requests', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const scope = await db.resolveManagerScope(req.session.user);
  res.json({ requests: await db.listCorrectionRequests(scope) });
}));

app.patch('/api/timesheets/:id/decide-correction', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { action, comment } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  await db.decideCorrection(req.params.id, action, req.session.user.id, comment);
  res.json({ ok: true });
}));

app.get('/api/analytics/my-trend', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ trend: await db.weeklyHoursTrend(req.session.user.id, parseInt(req.query.weeks, 10) || 12) });
}));

app.get('/api/analytics/team-summary', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const scope = await db.resolveManagerScope(req.session.user);
  res.json({ summary: await db.teamHoursSummary(scope) });
}));

// ---------------------------------------------------------------------------
// LEAVE
// ---------------------------------------------------------------------------

app.get('/api/leave-types', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.listLeaveTypes(false));
}));
app.post('/api/leave-types', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { name, defaultAnnualDays, maxCarryForwardDays } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = await db.createLeaveType(name, defaultAnnualDays, maxCarryForwardDays);
  res.status(201).json({ id });
}));
app.patch('/api/leave-types/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateLeaveType(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));
app.delete('/api/leave-types/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.deleteLeaveType(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

app.get('/api/leave-balances', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ balances: await db.getLeaveBalances(req.session.user.id, req.query.year ? parseInt(req.query.year, 10) : undefined) });
}));
app.put('/api/admin/leave/balances', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { userId, leaveTypeId, year, totalDays, usedDays } = req.body || {};
  await db.adjustLeaveBalance(userId, leaveTypeId, year, totalDays, usedDays);
  res.json({ ok: true });
}));

app.get('/api/leave-applications', auth.requireAuth, asyncHandler(async (req, res) => {
  const { all, status, team } = req.query;

  if (all === '1') {
    if (!['manager', 'admin'].includes(req.session.user.role)) {
      const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e;
    }
    const scope = await db.resolveManagerScope(req.session.user);
    return res.json({ leave: await db.listAllLeave(status || null, scope) });
  }

  if (team === '1') {
    if (!['manager', 'admin'].includes(req.session.user.role)) {
      const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e;
    }
    const scope = await db.resolveManagerScope(req.session.user);
    return res.json({ leave: await db.listTeamLeave(scope) });
  }

  res.json({ leave: await db.listLeaveForUser(req.session.user.id) });
}));

app.post('/api/leave-applications', auth.requireAuth, asyncHandler(async (req, res) => {
  const { leaveTypeId, from, to, reason, halfDay } = req.body || {};
  if (!leaveTypeId || !from || !to) return res.status(400).json({ error: 'leaveTypeId, from and to are required' });
  const id = await db.applyForLeave(req.session.user.id, { leaveTypeId, from, to, reason, halfDay });
  res.status(201).json({ id });
}));

app.patch('/api/leave-applications/:id/cancel', auth.requireAuth, asyncHandler(async (req, res) => {
  await db.cancelLeave(req.params.id, req.session.user.id);
  res.json({ ok: true });
}));

app.patch('/api/leave-applications/:id', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { action, comment } = req.body || {};
  if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'action must be approve or reject' });
  await db.decideLeave(req.params.id, action, req.session.user.id, comment);
  res.json({ ok: true });
}));

app.post('/api/leave-applications/bulk-decide', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { ids, action, comment } = req.body || {};
  if (!Array.isArray(ids) || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'ids[] and action are required' });
  res.json(await db.bulkDecideLeave(ids, action, req.session.user.id, comment));
}));

app.post('/api/admin/leave/carry-forward', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { fromYear, toYear } = req.body || {};
  if (!fromYear || !toYear) return res.status(400).json({ error: 'fromYear and toYear are required' });
  // Superseded by leave.js's policy-aware version (Block 3): respects
  // per-employee/department carry-forward policy overrides and records an
  // expiry date on the carried-forward days, instead of a single flat
  // per-leave-type cap with no expiry. db.runYearEndCarryForward still
  // exists but nothing calls it anymore.
  res.json(await leave.runYearEndCarryForward(fromYear, toYear));
}));

// ---------------------------------------------------------------------------
// ADVANCED LEAVE MANAGEMENT — BLOCK 3
// ---------------------------------------------------------------------------

app.get('/api/leave/policies', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  if (!req.query.leaveTypeId) return res.status(400).json({ error: 'leaveTypeId query param is required' });
  res.json(await db.listLeavePoliciesForType(parseInt(req.query.leaveTypeId, 10)));
}));
app.post('/api/leave/policies', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = await db.createLeavePolicy(req.body || {});
  res.status(201).json({ id });
}));
app.put('/api/leave/policies/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.updateLeavePolicy(parseInt(req.params.id, 10), req.body || {}));
}));
app.delete('/api/leave/policies/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.deleteLeavePolicy(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));
app.get('/api/leave/effective-policy', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  const leaveTypeId = parseInt(req.query.leaveTypeId, 10);
  if (!userId || !leaveTypeId) return res.status(400).json({ error: 'userId and leaveTypeId query params are required' });
  await assertAttendanceAccess(req, userId); // same self/manager/admin scope check; reused across advanced modules
  res.json(await leave.getEffectiveLeavePolicy(userId, leaveTypeId));
}));

app.post('/api/leave/applications-advanced', auth.requireAuth, asyncHandler(async (req, res) => {
  const result = await leave.applyForLeaveAdvanced({ userId: req.session.user.id, ...req.body });
  res.status(201).json(result);
}));
app.post('/api/leave/applications/:id/decide-advanced', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { decision, comment } = req.body || {};
  res.json(await leave.decideLeaveApplicationMultiLevel(req.params.id, decision, req.session.user.id, comment));
}));
app.get('/api/leave/applications/:id/approvals', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  res.json(await db.listLeaveApprovalsForApplication(req.params.id));
}));

app.post('/api/leave/comp-offs', auth.requireAuth, asyncHandler(async (req, res) => {
  const id = await leave.requestCompOff({ userId: req.session.user.id, ...req.body });
  res.status(201).json({ id });
}));
app.get('/api/leave/comp-offs', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.listCompOffsForUser(req.session.user.id));
}));
app.get('/api/leave/comp-offs/all', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listCompOffs(req.query.status));
}));
app.post('/api/leave/comp-offs/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { decision, expiryMonths } = req.body || {};
  res.json(await leave.decideCompOffRequest(parseInt(req.params.id, 10), decision, req.session.user.id, expiryMonths));
}));
app.post('/api/leave/comp-offs/:id/redeem', auth.requireAuth, asyncHandler(async (req, res) => {
  const result = await leave.redeemCompOff({ userId: req.session.user.id, compOffId: parseInt(req.params.id, 10), date: req.body.date });
  res.status(201).json(result);
}));

app.post('/api/leave/accrual/run', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { year, month } = req.body || {};
  if (!year || !month) return res.status(400).json({ error: 'year and month are required' });
  res.json(await leave.runMonthlyAccrual(year, month));
}));
app.post('/api/leave/carry-forward-expiry/run', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await leave.expireCarriedForwardLeave(req.body ? req.body.asOfDate : undefined));
}));

app.get('/api/leave/calendar', auth.requireAuth, asyncHandler(async (req, res) => {
  const { from, to, scope } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });
  let userIds;
  if (scope === 'team' && ['manager', 'admin'].includes(req.session.user.role)) {
    const mgrScope = await db.resolveManagerScope(req.session.user);
    userIds = (await db.dbAll(`SELECT id FROM users WHERE active = 1 AND manager_id IN (${mgrScope.map(() => '?').join(',') || 'NULL'})`, mgrScope)).map(u => u.id);
  } else {
    userIds = [req.session.user.id];
  }
  res.json(await leave.getTeamLeaveCalendar(userIds, from, to));
}));
app.get('/api/leave/conflicts', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { from, to, excludeApplicationId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });
  const scope = await db.resolveManagerScope(req.session.user);
  const userIds = req.session.user.role === 'admin'
    ? (await db.dbAll('SELECT id FROM users WHERE active = 1')).map(u => u.id)
    : (await db.dbAll(`SELECT id FROM users WHERE active = 1 AND manager_id IN (${scope.map(() => '?').join(',') || 'NULL'})`, scope)).map(u => u.id);
  res.json(await leave.getLeaveConflicts(userIds, from, to, excludeApplicationId));
}));

// ---------------------------------------------------------------------------
// COMPANY HOLIDAYS
// ---------------------------------------------------------------------------

app.get('/api/holidays', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ holidays: await db.listHolidays() });
}));
app.post('/api/holidays', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { date, name, blackout } = req.body || {};
  if (!date || !name) return res.status(400).json({ error: 'date and name are required' });
  const id = await db.addHoliday(date, name, blackout);
  res.status(201).json({ id });
}));
app.delete('/api/holidays/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.deleteHoliday(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PROJECTS / TASKS / DEPARTMENTS
// ---------------------------------------------------------------------------

app.get('/api/projects', auth.requireAuth, asyncHandler(async (req, res) => {
  if (req.query.all === '1') {
    if (req.session.user.role !== 'admin') { const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e; }
    return res.json({ projects: await db.listProjects(false) });
  }
  res.json({ projects: await db.listProjectsForUser(req.session.user.id) });
}));
app.post('/api/projects', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { name, code } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = await db.createProject(name, code);
  res.status(201).json({ id });
}));
app.patch('/api/projects/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateProject(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));
app.get('/api/projects/:projectId/assignments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json({ members: await db.listProjectAssignments(parseInt(req.params.projectId, 10)) });
}));
app.put('/api/projects/:projectId/assignments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { userIds } = req.body || {};
  if (!Array.isArray(userIds)) return res.status(400).json({ error: 'userIds[] is required' });
  await db.setProjectAssignments(parseInt(req.params.projectId, 10), userIds);
  res.json({ ok: true });
}));

app.get('/api/tasks', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ tasks: await db.listAllTasks(req.query.all !== '1') });
}));
app.get('/api/projects/:id/tasks', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.listTasks(parseInt(req.params.id, 10), true));
}));
app.post('/api/tasks', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { projectId, name } = req.body || {};
  if (!projectId || !name) return res.status(400).json({ error: 'projectId and name are required' });
  const id = await db.createTask(parseInt(projectId, 10), name);
  res.status(201).json({ id });
}));
app.put('/api/admin/tasks/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateTask(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

app.get('/api/departments', auth.requireAuth, asyncHandler(async (req, res) => {
  if (req.query.all === '1') {
    if (req.session.user.role !== 'admin') { const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e; }
    return res.json({ departments: await db.listDepartments(false) });
  }
  res.json({ departments: await db.listDepartments(true) });
}));
app.post('/api/departments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  const id = await db.createDepartment(name);
  res.status(201).json({ id });
}));
app.patch('/api/departments/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateDepartment(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------

app.get('/api/settings', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.getSettings());
}));
app.patch('/api/settings', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.updateSettings(req.body || {}));
}));

// ---------------------------------------------------------------------------
// AUDIT TRAIL
// ---------------------------------------------------------------------------

app.get('/api/audit-log', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { entityType, entityId } = req.query;
  if (!entityType || !entityId) return res.status(400).json({ error: 'entityType and entityId query params are required' });
  res.json({ log: await db.getAuditLog(entityType, entityId) });
}));

// ---------------------------------------------------------------------------
// REPORTS
// ---------------------------------------------------------------------------

function sendReportResult(res, rows, filename, format) {
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(reports.reportRowsToCsv(rows));
  }
  return res.json({ rows });
}

app.get('/api/reports/project-hours', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });
  const rows = await reports.reportProjectHours(from, to);
  sendReportResult(res, rows, 'project-hours.csv', req.query.format);
}));

app.get('/api/reports/utilization', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });
  const scope = await db.resolveManagerScope(req.session.user);
  const rows = await reports.reportEmployeeUtilization(from, to, scope);
  sendReportResult(res, rows, 'utilization.csv', req.query.format);
}));

app.get('/api/reports/leave-usage', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const scope = await db.resolveManagerScope(req.session.user);
  const rows = await reports.reportLeaveUsage(parseInt(req.query.year, 10) || new Date().getFullYear(), scope);
  sendReportResult(res, rows, 'leave-usage.csv', req.query.format);
}));

app.get('/api/reports/compliance', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { weekStart, from, to } = req.query;
  const rangeFrom = from || weekStart;
  const rangeTo = to || weekStart;
  if (!rangeFrom || !rangeTo) return res.status(400).json({ error: 'weekStart (or from/to) query param is required' });
  const scope = await db.resolveManagerScope(req.session.user);
  const rows = await reports.reportTimesheetCompliance(rangeFrom, rangeTo, scope);
  sendReportResult(res, rows, 'compliance.csv', req.query.format);
}));

app.get('/api/reports/pending-approvals', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const scope = await db.resolveManagerScope(req.session.user);
  res.json(await reports.reportPendingApprovals(scope));
}));

app.get('/api/reports/timesheets.csv', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const scope = await db.resolveManagerScope(req.session.user);
  const { items } = await db.listAllTimesheets(req.query.status || null, scope, { page: 1, pageSize: 100000 });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="timesheets.csv"');
  res.send(reports.timesheetsToCsv(items));
}));

app.get('/api/reports/leave.csv', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const scope = await db.resolveManagerScope(req.session.user);
  const rows = await db.listAllLeave(req.query.status || null, scope);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leave.csv"');
  res.send(reports.leaveToCsv(rows));
}));

// ---------------------------------------------------------------------------
// ATTENDANCE — BLOCK 2
// ---------------------------------------------------------------------------

async function assertAttendanceAccess(req, targetUserId) {
  const ok = await db.canAccessEmployeePayroll(req.session.user, targetUserId); // same self/manager/admin scope rules apply here
  if (!ok) { const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e; }
}

// -- Shifts ------------------------------------------------------------

app.get('/api/attendance/shifts', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json(await db.listShifts(req.query.all !== 'true'));
}));
app.post('/api/attendance/shifts', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = await attendance.createShift(req.body || {});
  res.status(201).json({ id });
}));
app.put('/api/attendance/shifts/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.updateShift(parseInt(req.params.id, 10), req.body || {}));
}));
app.post('/api/attendance/employees/:userId/shift', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const { shiftId, effectiveFrom } = req.body || {};
  if (!shiftId) return res.status(400).json({ error: 'shiftId is required' });
  const id = await attendance.assignShift({ userId, shiftId, effectiveFrom, createdBy: req.session.user.id });
  res.status(201).json({ id });
}));
app.get('/api/attendance/employees/:userId/shift-history', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertAttendanceAccess(req, userId);
  res.json(await db.listShiftAssignmentsForUser(userId));
}));

// -- Weekly-off configuration -------------------------------------------

app.get('/api/attendance/weekly-off', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ days: await db.getWeeklyOffDays() });
}));
app.put('/api/attendance/weekly-off', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { days } = req.body || {};
  if (!Array.isArray(days)) return res.status(400).json({ error: 'days must be an array of 0-6 (Sunday-Saturday)' });
  await db.setWeeklyOffDays(days);
  res.json({ ok: true });
}));

// -- Check-in / check-out -------------------------------------------------

app.post('/api/attendance/check-in', auth.requireAuth, asyncHandler(async (req, res) => {
  const result = await attendance.checkIn(req.session.user.id, req.body ? req.body.timestamp : undefined);
  res.status(201).json(result);
}));
app.post('/api/attendance/check-out', auth.requireAuth, asyncHandler(async (req, res) => {
  const result = await attendance.checkOut(req.session.user.id, req.body ? req.body.timestamp : undefined);
  res.json(result);
}));
app.get('/api/attendance/today', auth.requireAuth, asyncHandler(async (req, res) => {
  const today = require('./utils').todayStr();
  res.json(await db.getAttendanceRecord(req.session.user.id, today) || { status: 'pending' });
}));

// -- Manual marking (admin) ------------------------------------------------

app.post('/api/attendance/employees/:userId/mark', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const { date, status, notes } = req.body || {};
  if (!date || !status) return res.status(400).json({ error: 'date and status are required' });
  const record = await attendance.markAttendance({ userId, date, status, actorId: req.session.user.id, notes });
  res.json(record);
}));

// -- Records / calendar -----------------------------------------------------

app.get('/api/attendance/employees/:userId/calendar', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertAttendanceAccess(req, userId);
  const year = parseInt(req.query.year, 10), month = parseInt(req.query.month, 10);
  if (!year || !month) return res.status(400).json({ error: 'year and month query params are required' });
  res.json(await attendance.getMonthlyCalendar(userId, year, month));
}));
app.get('/api/attendance/day/:date', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listAttendanceRecordsForDate(req.params.date));
}));
app.get('/api/attendance/team', auth.requireAuth, auth.requireRoleMw(['manager', 'admin']), asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from and to query params are required' });
  let userIds;
  if (req.session.user.role === 'admin') {
    userIds = (await db.dbAll("SELECT id FROM users WHERE active = 1")).map(u => u.id);
  } else {
    const scope = await db.resolveManagerScope(req.session.user);
    userIds = (await db.dbAll(`SELECT id FROM users WHERE active = 1 AND manager_id IN (${scope.map(() => '?').join(',') || 'NULL'})`, scope)).map(u => u.id);
  }
  res.json(await db.listAttendanceRecordsForUsersInRange(userIds, from, to));
}));

// -- Correction / regularization requests ------------------------------

app.post('/api/attendance/employees/:userId/correction', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (userId !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const id = await attendance.requestCorrection({ userId, ...req.body });
  res.status(201).json({ id });
}));
app.get('/api/attendance/employees/:userId/corrections', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertAttendanceAccess(req, userId);
  res.json(await db.listAttendanceCorrectionRequestsForUser(userId));
}));
app.get('/api/attendance/corrections', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listAttendanceCorrectionRequests(req.query.status));
}));
app.post('/api/attendance/corrections/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const request = await attendance.decideCorrection(parseInt(req.params.id, 10), req.body.decision, req.session.user.id);
  res.json(request);
}));

// ---------------------------------------------------------------------------
// TAX & COMPLIANCE — BLOCK 5
// ---------------------------------------------------------------------------

app.get('/api/compliance/employer-info', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await compliance.getEmployerStatutoryInfo());
}));
app.put('/api/compliance/employer-info', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await compliance.updateEmployerStatutoryInfo(req.body || {}));
}));

app.get('/api/compliance/employees/:userId/annual-tax-statement', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await compliance.getAnnualTaxStatement(userId, fyId));
}));
app.get('/api/compliance/employees/:userId/form16', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await compliance.getForm16Data(userId, fyId));
}));

app.get('/api/compliance/form24q', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, quarter } = req.query;
  if (!financialYearId || !quarter) return res.status(400).json({ error: 'financialYearId and quarter are required' });
  res.json(await compliance.getForm24QData(parseInt(financialYearId, 10), quarter));
}));
app.get('/api/compliance/pf-report', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, payrollMonth } = req.query;
  if (!financialYearId || !payrollMonth) return res.status(400).json({ error: 'financialYearId and payrollMonth are required' });
  res.json(await compliance.getPfComplianceReport(parseInt(financialYearId, 10), payrollMonth));
}));
app.get('/api/compliance/esi-report', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, payrollMonth } = req.query;
  if (!financialYearId || !payrollMonth) return res.status(400).json({ error: 'financialYearId and payrollMonth are required' });
  res.json(await compliance.getEsiComplianceReport(parseInt(financialYearId, 10), payrollMonth));
}));
app.get('/api/compliance/pt-report', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, payrollMonth } = req.query;
  if (!financialYearId || !payrollMonth) return res.status(400).json({ error: 'financialYearId and payrollMonth are required' });
  res.json(await compliance.getPtComplianceReport(parseInt(financialYearId, 10), payrollMonth));
}));
app.get('/api/compliance/wage-register', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, payrollMonth } = req.query;
  if (!financialYearId || !payrollMonth) return res.status(400).json({ error: 'financialYearId and payrollMonth are required' });
  res.json(await compliance.getStatutoryWageRegister(parseInt(financialYearId, 10), payrollMonth));
}));

// ---------------------------------------------------------------------------
// FULL & FINAL SETTLEMENT — BLOCK 6
// ---------------------------------------------------------------------------

app.post('/api/fnf/separations', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const separation = await fnf.initiateSeparation({ ...req.body, initiatedBy: req.session.user.id });
  res.status(201).json(separation);
}));
app.get('/api/fnf/separations', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listSeparations(req.query.status));
}));
app.get('/api/fnf/separations/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const separation = await db.getSeparation(parseInt(req.params.id, 10));
  if (!separation) return res.status(404).json({ error: 'Separation not found' });
  res.json(separation);
}));
app.post('/api/fnf/separations/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const separation = await fnf.decideSeparationRequest(parseInt(req.params.id, 10), req.body.decision, req.session.user.id);
  res.json(separation);
}));

app.post('/api/fnf/separations/:id/settlement', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const settlement = await fnf.generateSettlement(parseInt(req.params.id, 10), req.session.user.id, req.body || {});
  res.status(201).json(settlement);
}));
app.get('/api/fnf/settlements', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listFnfSettlements(req.query.status));
}));
app.get('/api/fnf/settlements/:id', auth.requireAuth, asyncHandler(async (req, res) => {
  const settlement = await db.getFnfSettlement(parseInt(req.params.id, 10));
  if (!settlement) return res.status(404).json({ error: 'Settlement not found' });
  await assertPayrollAccess(req, settlement.user_id);
  res.json(settlement);
}));
app.get('/api/fnf/settlements/:id/statement', auth.requireAuth, asyncHandler(async (req, res) => {
  const statement = await fnf.getSettlementStatement(parseInt(req.params.id, 10));
  await assertPayrollAccess(req, statement.settlement.user_id);
  res.json(statement);
}));
app.post('/api/fnf/settlements/:id/submit', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await fnf.submitSettlementForApproval(parseInt(req.params.id, 10)));
}));
app.post('/api/fnf/settlements/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await fnf.decideSettlement(parseInt(req.params.id, 10), req.body.decision, req.session.user.id));
}));
app.post('/api/fnf/settlements/:id/mark-paid', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await fnf.markSettlementPaid(parseInt(req.params.id, 10), req.session.user.id));
}));

// ---------------------------------------------------------------------------
// PAYROLL — FINANCIAL YEARS / SALARY COMPONENTS
// ---------------------------------------------------------------------------

app.get('/api/payroll/financial-years', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ financialYears: await db.listFinancialYears() });
}));
app.post('/api/payroll/financial-years', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { name, startDate, endDate } = req.body || {};
  if (!name || !startDate || !endDate) return res.status(400).json({ error: 'name, startDate and endDate are required' });
  const id = await db.createFinancialYear(name, startDate, endDate);
  await payroll.ensureStatutoryTaxRules(id);
  res.status(201).json({ id });
}));
app.post('/api/payroll/financial-years/:id/activate', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.setActiveFinancialYear(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

app.get('/api/payroll/components', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listSalaryComponents(false));
}));
app.post('/api/payroll/components', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const id = await db.createSalaryComponent(req.body || {});
  res.status(201).json({ id });
}));
app.put('/api/payroll/components/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateSalaryComponent(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PAYROLL — EMPLOYEE SALARY STRUCTURE & REVISIONS
// ---------------------------------------------------------------------------

async function assertPayrollAccess(req, targetUserId) {
  const ok = await db.canAccessEmployeePayroll(req.session.user, targetUserId);
  if (!ok) { const e = new Error('Forbidden'); e.code = 'FORBIDDEN'; e.httpStatus = 403; throw e; }
}

app.get('/api/payroll/salary-structures', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: 'userId query param is required' });
  await assertPayrollAccess(req, userId);
  res.json({ structures: await db.listSalaryStructuresForEmployee(userId) });
}));

app.get('/api/payroll/salary-structures/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const structure = await db.getSalaryStructureById(parseInt(req.params.id, 10));
  if (!structure) return res.status(404).json({ error: 'Salary structure not found' });
  const components = await db.getStructureComponents(structure.id);
  res.json({ ...structure, components });
}));

app.post('/api/payroll/salary-structures', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { userId, financialYearId, effectiveFrom, annualCtc, basicSalary, componentOverrides } = req.body || {};
  if (!userId || !effectiveFrom || !annualCtc) return res.status(400).json({ error: 'userId, effectiveFrom and annualCtc are required' });
  const fyId = financialYearId || (await db.getActiveFinancialYear()).id;
  const id = await payroll.createSalaryStructure({ userId, financialYearId: fyId, effectiveFrom, annualCtc, basicSalary, createdBy: req.session.user.id, componentOverrides });
  res.status(201).json({ id });
}));

app.patch('/api/payroll/salary-structures/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.updateSalaryStructureBasics(parseInt(req.params.id, 10), req.body || {});
  res.json({ ok: true });
}));

app.put('/api/payroll/salary-structures/:id/components', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const structureId = parseInt(req.params.id, 10);
  const { componentAmounts, components } = req.body || {};
  if (Array.isArray(components)) {
    // Admin "Salary Structure Builder" shape: full replace with free-form
    // {componentName, type, category, amount, isTaxable} rows.
    await db.replaceStructureComponents(structureId, components.map((c) => ({
      name: c.componentName, type: c.type, category: c.category, amount: payroll.roundMoney(c.amount), isTaxable: !!c.isTaxable,
    })));
    const monthlyCtc = (await db.getStructureComponents(structureId))
      .filter((c) => c.type === 'earning').reduce((sum, c) => sum + Number(c.amount || 0), 0);
    return res.json({ monthlyCtc });
  }
  if (componentAmounts) {
    const monthlyCtc = await payroll.setSalaryStructureComponents(structureId, componentAmounts, req.session.user.id);
    return res.json({ monthlyCtc });
  }
  return res.status(400).json({ error: 'components[] or componentAmounts is required' });
}));

app.post('/api/payroll/salary-structures/:id/activate', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await payroll.activateSalaryStructureFull(parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
}));

app.get('/api/admin/employees/:userId/compensation', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const user = await db.findUserById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  delete user.password_hash; delete user.password_salt;
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  const activeStructure = await db.getActiveSalaryStructure(userId, fyId);
  const components = activeStructure ? await db.getStructureComponents(activeStructure.id) : [];
  res.json({ user, activeStructure, components });
}));

app.post('/api/admin/employees/:userId/hike', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const body = req.body || {};
  if (!body.effectiveDate || (!body.newAnnualCtc && !body.hikePercentage && !body.hikeAmount)) {
    return res.status(400).json({ error: 'effectiveDate and one of newAnnualCtc/hikePercentage/hikeAmount are required' });
  }
  const financialYearId = body.financialYearId || (await db.getActiveFinancialYear()).id;
  const result = await payroll.giveSalaryHike({ userId, approvedBy: req.session.user.id, ...body, financialYearId });
  res.status(201).json(result);
}));

app.get('/api/admin/employees/:userId/salary-revisions', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  res.json({ revisions: await db.listSalaryRevisionsForUser(userId) });
}));

app.get('/api/payroll/revisions/recent', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listRecentSalaryRevisions(parseInt(req.query.limit, 10) || 50));
}));

app.post('/api/payroll/employees/:userId/offer-letter', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { structureId, path } = req.body || {};
  if (!structureId || !path) return res.status(400).json({ error: 'structureId and path are required' });
  await db.attachOfferLetter(structureId, path);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PAYROLL — EMPLOYEE LOANS
// ---------------------------------------------------------------------------

app.get('/api/payroll/employees/:userId/loans', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  res.json(await db.listLoansForUser(userId));
}));
app.post('/api/payroll/employees/:userId/loans', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (userId !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const id = await payroll.requestLoan({ userId, ...req.body });
  res.status(201).json({ id });
}));
app.get('/api/payroll/loans', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listLoans(req.query.status));
}));
app.post('/api/payroll/loans/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const loan = await payroll.decideLoanRequest(parseInt(req.params.id, 10), req.body.decision, req.session.user.id);
  res.json(loan);
}));
app.post('/api/payroll/loans/:id/disburse', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const loan = await payroll.disburseLoanFull(parseInt(req.params.id, 10), req.session.user.id);
  res.json(loan);
}));
app.get('/api/payroll/loans/:id/repayments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listLoanRepayments(parseInt(req.params.id, 10)));
}));

// ---------------------------------------------------------------------------
// PAYROLL — SALARY ADVANCES
// ---------------------------------------------------------------------------

app.get('/api/payroll/employees/:userId/advances', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  res.json(await db.listSalaryAdvancesForUser(userId));
}));
app.post('/api/payroll/employees/:userId/advances', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (userId !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const id = await payroll.requestSalaryAdvance({ userId, ...req.body });
  res.status(201).json({ id });
}));
app.get('/api/payroll/advances', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listSalaryAdvances(req.query.status));
}));
app.post('/api/payroll/advances/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { decision, recoveryMonths, monthlyRecoveryAmount } = req.body || {};
  const advance = await payroll.decideSalaryAdvanceRequest(parseInt(req.params.id, 10), decision, req.session.user.id, recoveryMonths, monthlyRecoveryAmount);
  res.json(advance);
}));
app.get('/api/payroll/advances/:id/recoveries', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listAdvanceRecoveries(parseInt(req.params.id, 10)));
}));

// ---------------------------------------------------------------------------
// PAYROLL — LEAVE ENCASHMENT
// ---------------------------------------------------------------------------

app.get('/api/payroll/employees/:userId/leave-encashment', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  res.json(await db.listLeaveEncashmentsForUser(userId));
}));
app.post('/api/payroll/employees/:userId/leave-encashment', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (userId !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const financialYearId = req.body.financialYearId || (await db.getActiveFinancialYear()).id;
  const result = await payroll.requestLeaveEncashment({ userId, financialYearId, ...req.body });
  res.status(201).json(result);
}));
app.get('/api/payroll/leave-encashment', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listLeaveEncashments(req.query.status));
}));
app.post('/api/payroll/leave-encashment/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const enc = await payroll.decideLeaveEncashmentRequest(parseInt(req.params.id, 10), req.body.decision, req.session.user.id);
  res.json(enc);
}));

// ---------------------------------------------------------------------------
// PAYROLL — GRATUITY & ARREARS
// ---------------------------------------------------------------------------

app.get('/api/payroll/employees/:userId/gratuity', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : undefined;
  res.json(await payroll.calculateGratuity(userId, fyId, req.query.asOfDate));
}));
app.get('/api/payroll/employees/:userId/arrears', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  res.json(await db.listArrearsForUser(userId));
}));

// ---------------------------------------------------------------------------
// PAYROLL — REPORTS: MONTH-TO-MONTH COMPARISON & VARIANCE
// ---------------------------------------------------------------------------

app.get('/api/payroll/reports/comparison', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, monthA, monthB } = req.query;
  if (!financialYearId || !monthA || !monthB) return res.status(400).json({ error: 'financialYearId, monthA and monthB are required' });
  res.json(await payroll.comparePayrollMonths(parseInt(financialYearId, 10), monthA, monthB));
}));
app.get('/api/payroll/reports/variance', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, monthA, monthB, threshold } = req.query;
  if (!financialYearId || !monthA || !monthB) return res.status(400).json({ error: 'financialYearId, monthA and monthB are required' });
  res.json(await payroll.payrollVarianceReport(parseInt(financialYearId, 10), monthA, monthB, threshold));
}));

// ---------------------------------------------------------------------------
// PAYROLL — TAX REGIME / DECLARATIONS
// ---------------------------------------------------------------------------

app.get('/api/payroll/tax-regimes', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json({ regimes: await db.listTaxRegimes(fyId) });
}));

app.get('/api/payroll/my-tax-regime', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json({ regime: (await db.getEmployeeTaxRegime(req.session.user.id, fyId)) || null });
}));

app.post('/api/payroll/my-tax-regime', auth.requireAuth, asyncHandler(async (req, res) => {
  const { financialYearId, taxRegimeId } = req.body || {};
  if (!financialYearId || !taxRegimeId) return res.status(400).json({ error: 'financialYearId and taxRegimeId are required' });
  await db.setEmployeeTaxRegime(req.session.user.id, financialYearId, taxRegimeId, req.session.user.id);
  res.json({ ok: true });
}));

app.get('/api/payroll/my-tax-regime/compare', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json({ comparison: await payroll.compareTaxRegimesForEmployee(req.session.user.id, fyId) });
}));

app.get('/api/payroll/my-tax-summary', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await payroll.getEmployeeTaxSummary(req.session.user.id, fyId));
}));

app.get('/api/payroll/tax-declaration-sections', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json({ sections: await db.listTaxDeclarationSections(fyId, req.query.regime) });
}));

app.get('/api/payroll/my-tax-declarations', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  const declarations = await db.listDeclarationsForUser(req.session.user.id, fyId);
  for (const d of declarations) d.entries = await db.listDeclarationEntries(d.id);
  res.json({ declarations });
}));

app.post('/api/payroll/my-tax-declarations', auth.requireAuth, asyncHandler(async (req, res) => {
  const { financialYearId, sectionId } = req.body || {};
  if (!sectionId) return res.status(400).json({ error: 'sectionId is required' });
  const fyId = financialYearId || (await db.getActiveFinancialYear()).id;
  const declaration = await db.getOrCreateDeclaration(req.session.user.id, fyId, sectionId);
  res.status(201).json({ id: declaration.id });
}));

app.post('/api/payroll/tax-declarations/:declarationId/entries', auth.requireAuth, asyncHandler(async (req, res) => {
  const declarationId = parseInt(req.params.declarationId, 10);
  const declaration = await db.getDeclarationById(declarationId);
  if (!declaration) return res.status(404).json({ error: 'Declaration not found' });
  if (declaration.user_id !== req.session.user.id && req.session.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden' });
  }
  const entryId = await db.addDeclarationEntry(declarationId, req.body || {});
  await db.recomputeDeclaredAmount(declarationId);
  res.status(201).json({ entryId, declarationId });
}));

app.delete('/api/payroll/tax-entries/:entryId', auth.requireAuth, asyncHandler(async (req, res) => {
  const entryId = parseInt(req.params.entryId, 10);
  const entry = await db.dbGet('SELECT tde.*, td.user_id FROM tax_declaration_entries tde JOIN tax_declarations td ON td.id = tde.tax_declaration_id WHERE tde.id = ?', [entryId]);
  if (!entry) return res.status(404).json({ error: 'Entry not found' });
  if (entry.user_id !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  await db.deleteDeclarationEntry(entryId);
  res.json({ ok: true });
}));

app.post('/api/payroll/tax-declaration-entries/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { status, approvedAmount, rejectionReason } = req.body || {};
  if (!['approved', 'rejected', 'proof_uploaded', 'correction_requested'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
  await db.updateDeclarationEntryStatus(parseInt(req.params.id, 10), status, { approvedAmount, approvedBy: req.session.user.id, rejectionReason });
  res.json({ ok: true });
}));

app.post('/api/payroll/my-tax-declarations/submit-all', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = (req.body || {}).financialYearId || (await db.getActiveFinancialYear()).id;
  await db.submitTaxDeclarations(req.session.user.id, fyId);
  res.json({ ok: true });
}));

app.post('/api/payroll/tax-declarations/:id/verify', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { eligibleAmount } = req.body || {};
  await db.verifyTaxDeclaration(parseInt(req.params.id, 10), req.session.user.id, eligibleAmount);
  res.json({ ok: true });
}));
app.post('/api/payroll/tax-declarations/:id/reject', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.rejectTaxDeclaration(parseInt(req.params.id, 10), req.session.user.id, (req.body || {}).reason);
  res.json({ ok: true });
}));

app.get('/api/payroll/deduction-limits', auth.requireAuth, asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await db.listDeductionLimits(fyId));
}));

// ---------------------------------------------------------------------------
// PAYROLL — FIXED / VARIABLE DEDUCTIONS & PREVIOUS EMPLOYER INCOME
// ---------------------------------------------------------------------------

app.get('/api/payroll/employees/:userId/fixed-deductions', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await db.listFixedDeductions(userId, fyId));
}));
app.post('/api/payroll/employees/:userId/fixed-deductions', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  const id = await db.addFixedDeduction({ userId, ...req.body });
  res.status(201).json({ id });
}));
app.delete('/api/payroll/fixed-deductions/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.deactivateFixedDeduction(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

app.get('/api/payroll/employees/:userId/variable-deductions', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  if (!req.query.payrollMonth) return res.status(400).json({ error: 'payrollMonth query param is required' });
  res.json(await db.listVariableDeductions(userId, req.query.payrollMonth));
}));
app.post('/api/payroll/employees/:userId/variable-deductions', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await db.addVariableDeduction({ userId, createdBy: req.session.user.id, ...req.body });
  res.status(201).json({ ok: true });
}));
app.delete('/api/payroll/variable-deductions/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.removeVariableDeduction(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

app.get('/api/payroll/employees/:userId/previous-employer-income', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await db.getPreviousEmployerIncome(userId, fyId));
}));
app.post('/api/payroll/employees/:userId/previous-employer-income', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  if (userId !== req.session.user.id && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
  const fyId = (req.body || {}).financialYearId || (await db.getActiveFinancialYear()).id;
  await db.upsertPreviousEmployerIncome({ userId, financialYearId: fyId, ...req.body });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PAYROLL — RUNS
// ---------------------------------------------------------------------------

app.get('/api/payroll/runs', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json({ runs: await db.listPayrollRuns(req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : undefined) });
}));

app.get('/api/payroll/dashboard', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await db.getPayrollDashboardData(fyId));
}));

// Create a new draft run for a month (no calculation yet — the admin UI
// calculates it separately, by id, once created).
app.post('/api/payroll/runs', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, payrollMonth } = req.body || {};
  if (!financialYearId || !payrollMonth) return res.status(400).json({ error: 'financialYearId and payrollMonth are required' });
  const run = await db.getOrCreatePayrollRun(financialYearId, payrollMonth, req.session.user.id);
  res.status(201).json({ id: run.id });
}));

app.delete('/api/payroll/runs/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.deletePayrollRun(parseInt(req.params.id, 10));
  res.json({ ok: true });
}));

// Legacy one-shot "find-or-create + calculate by month" endpoint (kept for
// any external/API caller that already targets it directly).
app.post('/api/payroll/runs/calculate', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { financialYearId, payrollMonth } = req.body || {};
  if (!financialYearId || !payrollMonth) return res.status(400).json({ error: 'financialYearId and payrollMonth are required' });
  const run = await payroll.calculatePayrollRun(financialYearId, payrollMonth, req.session.user.id);
  res.json({ ...run, totalEmployees: run.total_employees });
}));

// Calculate (or recalculate) an existing run by id — this is what the admin
// "Calculate" button on a specific run actually hits.
app.post('/api/payroll/runs/:id/calculate', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const existing = await db.getPayrollRun(parseInt(req.params.id, 10));
  if (!existing) return res.status(404).json({ error: 'Payroll run not found' });
  const run = await payroll.calculatePayrollRun(existing.financial_year_id, existing.payroll_month, req.session.user.id);
  res.json({ ...run, totalEmployees: run.total_employees });
}));

app.get('/api/payroll/runs/:id', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.getPayrollRun(parseInt(req.params.id, 10)));
}));

app.get('/api/payroll/runs/:id/details', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json({ details: await db.listPayrollDetails(parseInt(req.params.id, 10)) });
}));

app.get('/api/payroll/runs/:id/details.csv', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const rows = await db.listPayrollDetails(parseInt(req.params.id, 10));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="payroll-details.csv"');
  res.send(reports.payrollDetailsToCsv(rows));
}));

app.post('/api/payroll/runs/:id/review', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await payroll.reviewPayrollRun(parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
}));
app.post('/api/payroll/runs/:id/approve', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await payroll.approvePayrollRun(parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
}));
app.post('/api/payroll/runs/:id/lock', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await payroll.lockPayrollRun(parseInt(req.params.id, 10), req.session.user.id);
  res.json({ ok: true });
}));

app.get('/api/payroll/runs/:id/exceptions', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json({ exceptions: await db.listPayrollExceptions(parseInt(req.params.id, 10), req.query.unresolved === '1') });
}));
app.post('/api/payroll/exceptions/:id/resolve', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  await db.resolveException(parseInt(req.params.id, 10), req.session.user.id, (req.body || {}).notes);
  res.json({ ok: true });
}));

app.post('/api/payroll/details/:id/adjustments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { adjustmentType, amount, reason } = req.body || {};
  if (!adjustmentType || amount === undefined || !reason) return res.status(400).json({ error: 'adjustmentType, amount and reason are required' });
  const id = await payroll.requestPayrollAdjustment(parseInt(req.params.id, 10), adjustmentType, amount, reason, req.session.user.id);
  res.status(201).json({ id });
}));
app.get('/api/payroll/details/:id/adjustments', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.listPayrollAdjustments(parseInt(req.params.id, 10)));
}));
app.post('/api/payroll/adjustments/:id/decide', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { decision } = req.body || {};
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' });
  await payroll.decidePayrollAdjustment(parseInt(req.params.id, 10), decision, req.session.user.id);
  res.json({ ok: true });
}));

// ---------------------------------------------------------------------------
// PAYROLL — PAYSLIPS
// ---------------------------------------------------------------------------

app.post('/api/payroll/payslips/generate', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const { payrollDetailId } = req.body || {};
  if (!payrollDetailId) return res.status(400).json({ error: 'payrollDetailId is required' });
  const data = await payroll.preparePayslipData(payrollDetailId);
  const pdfBuffer = reports.buildPayslipPdf(data);
  const payslip = await payroll.generatePayslipRecord(payrollDetailId, req.session.user.id, null);
  res.status(201).json({ id: payslip.id, sizeBytes: pdfBuffer.length });
}));

app.get('/api/payroll/payslips/:id/pdf', auth.requireAuth, asyncHandler(async (req, res) => {
  const payslip = await db.getPayslip(parseInt(req.params.id, 10));
  if (!payslip) return res.status(404).json({ error: 'Payslip not found' });
  await assertPayrollAccess(req, payslip.user_id);
  const data = await payroll.preparePayslipData(payslip.payroll_detail_id);
  const pdfBuffer = reports.buildPayslipPdf(data);
  await db.markPayslipDownloaded(payslip.id, req.session.user.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="payslip-${payslip.payroll_month}.pdf"`);
  res.send(pdfBuffer);
}));

app.get('/api/payroll/my-payslips', auth.requireAuth, asyncHandler(async (req, res) => {
  res.json({ payslips: await db.listPayslipsForEmployee(req.session.user.id) });
}));

app.get('/api/payroll/employees/:userId/history', auth.requireAuth, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.userId, 10);
  await assertPayrollAccess(req, userId);
  res.json(await db.listPayrollHistoryForUser(userId));
}));

app.get('/api/payroll/employees-status', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  const fyId = req.query.financialYearId ? parseInt(req.query.financialYearId, 10) : (await db.getActiveFinancialYear()).id;
  res.json(await db.listEmployeesWithPayrollStatus(fyId));
}));

app.get('/api/payroll/audit-log/:entityType/:entityId', auth.requireAuth, auth.requireRoleMw(['admin']), asyncHandler(async (req, res) => {
  res.json(await db.getPayrollAuditLog(req.params.entityType, req.params.entityId));
}));

// ---------------------------------------------------------------------------
// HEALTH CHECK
// ---------------------------------------------------------------------------

app.get('/api/health', asyncHandler(async (req, res) => {
  await db.healthCheck();
  res.json({ ok: true, time: nowStr() });
}));

// 404 fallback for unmatched /api routes (keeps behavior explicit rather
// than falling through to Express's default HTML 404 page).
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

module.exports = app;

// ---------------------------------------------------------------------------
// STARTUP — only when run directly (not when required by tests)
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    await db.ensureRuntimeDefaults();
    const server = app.listen(PORT, () => {
      console.log(`Vasjo Timesheet Portal API listening on port ${PORT}`);
    });

    // Escalation sweep — same "check every N hours" pattern as the original
    // server, driven by settings.escalation_days.
    const ESCALATION_INTERVAL_MS = 1000 * 60 * 60; // hourly
    const escalationTimer = setInterval(async () => {
      try {
        const settings = await db.getSettings();
        await db.runEscalationCheck(numSetting(settings.escalation_days, 3));
      } catch (e) {
        console.error('Escalation check failed:', e);
      }
    }, ESCALATION_INTERVAL_MS);
    escalationTimer.unref();

    function shutdown() {
      clearInterval(escalationTimer);
      server.close(() => {
        db.prisma.$disconnect().finally(() => process.exit(0));
      });
    }
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })();
}
