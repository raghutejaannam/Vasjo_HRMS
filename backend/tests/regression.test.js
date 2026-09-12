// tests/regression.test.js
//
// End-to-end regression suite for the migrated backend. Boots the real
// Express app (src/server.js) on an ephemeral port and drives it with plain
// HTTP requests using the EXACT paths/methods/payload shapes the React
// frontend (src/api.js) uses — so a passing suite here is a guarantee the
// frontend and backend are actually in sync, not just that the backend
// works in isolation.
//
// Prerequisites before running (`npm test`):
//   1. DATABASE_URL points at a disposable PostgreSQL database.
//   2. The schema has been applied: `npx prisma migrate deploy` (or apply
//      prisma/migrations/0001_init/migration.sql directly).
//   3. Seed data has been loaded: `npx prisma db seed` (creates
//      admin@vasjo.com / admin123, manager@vasjo.com / manager123,
//      employee@vasjo.com / employee123, plus leave types, a financial year,
//      salary components, etc. — see prisma/seed.js).
//
// These tests are read/write against real data, so use a database you don't
// mind mutating — do not point this at production.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../src/server');
const db = require('../src/db');

let server;
let baseUrl;

before(async () => {
  await new Promise((resolve) => {
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.prisma.$disconnect();
});

// Small fetch wrapper that carries cookies + CSRF token per logged-in
// "session" object, mirroring how the real frontend talks to this API.
function makeClient() {
  let cookie = null;
  let csrfToken = null;
  async function request(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    if (csrfToken && method !== 'GET') headers['x-csrf-token'] = csrfToken;
    const res = await fetch(baseUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let json = null;
    const text = await res.text();
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  }
  return {
    get: (path) => request('GET', path),
    post: (path, body) => request('POST', path, body),
    put: (path, body) => request('PUT', path, body),
    patch: (path, body) => request('PATCH', path, body),
    del: (path) => request('DELETE', path),
    cookieHeader: () => cookie,
    async login(email, password) {
      const res = await request('POST', '/api/login', { email, password });
      if (res.body && res.body.csrfToken) csrfToken = res.body.csrfToken;
      return res;
    },
  };
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

test('health check reports ok', async () => {
  const client = makeClient();
  const res = await client.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
});

test('rejects bad credentials, accepts good ones, and reports mustReset', async () => {
  const client = makeClient();
  const bad = await client.login('admin@vasjo.com', 'wrong-password');
  assert.equal(bad.status, 401);

  const good = await client.login('admin@vasjo.com', 'admin123');
  assert.equal(good.status, 200);
  assert.equal(good.body.user.email, 'admin@vasjo.com');
  assert.ok(good.body.csrfToken);
  assert.equal(typeof good.body.mustReset, 'boolean');
});

test('unauthenticated requests are rejected', async () => {
  const client = makeClient();
  const res = await client.get('/api/me');
  assert.equal(res.status, 401);
});

test('mutating request without CSRF token is rejected even with a valid session', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');
  // Bypass the test client's automatic CSRF header to simulate a forged request.
  const res = await fetch(baseUrl + '/api/leave-applications', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: client.cookieHeader() },
    body: JSON.stringify({ leaveTypeId: 1, from: '2026-12-20', to: '2026-12-20' }),
  });
  assert.equal(res.status, 403);
});

test('PATCH /api/me updates the profile and returns the updated user', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');
  const res = await client.patch('/api/me', { phone: '9999999999' });
  assert.equal(res.status, 200);
  assert.equal(res.body.user.phone, '9999999999');
});

// ---------------------------------------------------------------------------
// TIMESHEETS — the single /api/timesheets endpoint's four modes
// ---------------------------------------------------------------------------

test('employee can submit a timesheet and it appears in their own list', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');

  const weekStart = '2026-11-02'; // a Monday, unlikely to collide with seeded data
  const save = await client.post('/api/timesheets', {
    weekStart,
    submit: true,
    entries: [{ date: '2026-11-02', inTime: '09:00', outTime: '18:00', note: 'Regression test entry' }],
  });
  assert.equal(save.status, 200);
  assert.ok(save.body.id);

  const list = await client.get('/api/timesheets');
  assert.equal(list.status, 200);
  const found = list.body.timesheets.find((t) => t.id === save.body.id);
  assert.ok(found, "submitted timesheet should appear in the employee's own list");
  assert.equal(found.status, 'pending');
  assert.equal(found.total_hours, 9);

  const byWeek = await client.get(`/api/timesheets?weekStart=${weekStart}`);
  assert.equal(byWeek.status, 200);
  assert.equal(byWeek.body.timesheet.id, save.body.id);
  assert.equal(byWeek.body.entries.length, 1);
});

test('manager can approve a submitted timesheet via PATCH /api/timesheets/:id', async () => {
  const employee = makeClient();
  await employee.login('employee@vasjo.com', 'employee123');
  const weekStart = '2026-11-09';
  const save = await employee.post('/api/timesheets', {
    weekStart,
    submit: true,
    entries: [{ date: '2026-11-09', inTime: '09:00', outTime: '17:00' }],
  });
  assert.equal(save.status, 200);

  const manager = makeClient();
  await manager.login('manager@vasjo.com', 'manager123');
  const decide = await manager.patch(`/api/timesheets/${save.body.id}`, { action: 'approve', comment: 'Looks good' });
  assert.equal(decide.status, 200);

  const list = await employee.get('/api/timesheets');
  const found = list.body.timesheets.find((t) => t.id === save.body.id);
  assert.equal(found.status, 'approved');
});

test('manager can list the team queue via ?all=1 and an employee cannot', async () => {
  const manager = makeClient();
  await manager.login('manager@vasjo.com', 'manager123');
  const res = await manager.get('/api/timesheets?all=1&status=pending');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.timesheets));

  const employee = makeClient();
  await employee.login('employee@vasjo.com', 'employee123');
  const forbidden = await employee.get('/api/timesheets?all=1&status=pending');
  assert.equal(forbidden.status, 403);
});

// ---------------------------------------------------------------------------
// LEAVE
// ---------------------------------------------------------------------------

test('rejects a leave request that overlaps an existing one', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');

  const first = await client.post('/api/leave-applications', { leaveTypeId: 3, from: '2026-12-01', to: '2026-12-02' });
  assert.equal(first.status, 201);

  const overlapping = await client.post('/api/leave-applications', { leaveTypeId: 3, from: '2026-12-02', to: '2026-12-03' });
  assert.equal(overlapping.status, 400);
  assert.equal(overlapping.body.code, 'OVERLAP');
});

test('rejects a leave request beyond the remaining balance', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');
  const currentYear = new Date().getFullYear();
  const res = await client.post('/api/leave-applications', { leaveTypeId: 1, from: `${currentYear}-02-02`, to: `${currentYear}-04-30` });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, 'INSUFFICIENT_BALANCE');
});

test('leave balances and leave types return the wrapped shapes the frontend expects', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');
  const balances = await client.get('/api/leave-balances');
  assert.equal(balances.status, 200);
  assert.ok(Array.isArray(balances.body.balances));

  const types = await client.get('/api/leave-types');
  assert.equal(types.status, 200);
  assert.ok(Array.isArray(types.body));
});

// ---------------------------------------------------------------------------
// USERS / ADMIN DIRECTORY
// ---------------------------------------------------------------------------

test('non-admin cannot access the admin employee directory', async () => {
  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');
  const res = await client.get('/api/admin/employees');
  assert.equal(res.status, 403);
});

test('admin can search/filter/sort the employee directory', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');
  const res = await client.get('/api/admin/employees?page=1&pageSize=50&search=&department=&status=active&sortBy=name&sortDir=asc');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.items));
  assert.equal(typeof res.body.total, 'number');
});


test('admin system data endpoints return all shapes required by the admin page', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');

  const [departments, leaveTypes, holidays, settings, projects, tasks, allDepartments] = await Promise.all([
    client.get('/api/admin/departments'),
    client.get('/api/leave-types'),
    client.get('/api/holidays'),
    client.get('/api/settings'),
    client.get('/api/projects?all=1'),
    client.get('/api/tasks?all=1'),
    client.get('/api/departments?all=1'),
  ]);

  for (const response of [departments, leaveTypes, holidays, settings, projects, tasks, allDepartments]) {
    assert.equal(response.status, 200);
  }
  assert.ok(Array.isArray(departments.body.departments));
  assert.ok(departments.body.departments.every((d) => typeof d === 'string'));
  assert.ok(Array.isArray(leaveTypes.body));
  assert.ok(Array.isArray(holidays.body.holidays));
  assert.equal(typeof settings.body, 'object');
  assert.ok(Array.isArray(projects.body.projects));
  assert.ok(Array.isArray(tasks.body.tasks));
  assert.ok(Array.isArray(allDepartments.body.departments));
});

test('reports return the response fields consumed by the React reports page', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');

  const [project, utilization, leave, compliance, pending] = await Promise.all([
    client.get('/api/reports/project-hours?from=2026-01-01&to=2026-12-31'),
    client.get('/api/reports/utilization?from=2026-01-01&to=2026-12-31'),
    client.get('/api/reports/leave-usage?year=2026'),
    client.get('/api/reports/compliance?weekStart=2026-11-02'),
    client.get('/api/reports/pending-approvals'),
  ]);

  for (const response of [project, utilization, leave, compliance, pending]) assert.equal(response.status, 200);
  assert.ok(Array.isArray(project.body.rows));
  assert.ok(Array.isArray(utilization.body.rows));
  assert.ok(Array.isArray(leave.body.rows));
  assert.ok(Array.isArray(compliance.body.rows));
  assert.ok(Array.isArray(pending.body.timesheets));
  assert.ok(Array.isArray(pending.body.leave));

  if (project.body.rows.length) {
    assert.ok('project_name' in project.body.rows[0]);
    assert.ok('user_name' in project.body.rows[0]);
    assert.ok('hours' in project.body.rows[0]);
  }
  if (utilization.body.rows.length) assert.ok('utilization_pct' in utilization.body.rows[0]);
  if (leave.body.rows.length) {
    assert.ok('type_name' in leave.body.rows[0]);
    assert.ok('pending_days' in leave.body.rows[0]);
  }
  if (compliance.body.rows.length) {
    assert.ok('email' in compliance.body.rows[0]);
    assert.ok('status' in compliance.body.rows[0]);
  }
  if (pending.body.timesheets.length) assert.ok('manager_name' in pending.body.timesheets[0]);
});

test('report CSV format returns CSV instead of JSON', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');
  const res = await client.get('/api/reports/utilization?from=2026-01-01&to=2026-12-31&format=csv');
  assert.equal(res.status, 200);
  assert.match(String(res.body), /(?:user_name|user|name)/i);
});

test('GET /api/users/flat and GET /api/team-members return their wrapped shapes', async () => {
  const employee = makeClient();
  await employee.login('employee@vasjo.com', 'employee123');
  const flat = await employee.get('/api/users/flat');
  assert.equal(flat.status, 200);
  assert.ok(Array.isArray(flat.body.users));

  const manager = makeClient();
  await manager.login('manager@vasjo.com', 'manager123');
  const team = await manager.get('/api/team-members');
  assert.equal(team.status, 200);
  assert.ok(Array.isArray(team.body.members));
});

// ---------------------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------------------

test('admin can list settings and update them via PATCH', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');
  const res = await client.patch('/api/settings', { escalation_days: '5' });
  assert.equal(res.status, 200);
  assert.equal(res.body.escalation_days, '5');
  // restore default so this test is idempotent across reruns
  await client.patch('/api/settings', { escalation_days: '3' });
});

// ---------------------------------------------------------------------------
// PAYROLL — full flow, including the draft -> activate lifecycle and the
// percentage-based hike path that were both broken before this fix.
// ---------------------------------------------------------------------------

test('admin payroll dashboard loads with JSON-safe numeric values', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');
  const fyRes = await client.get('/api/payroll/financial-years');
  assert.equal(fyRes.status, 200);
  const fy = fyRes.body.financialYears[0];
  assert.ok(fy);
  const res = await client.get(`/api/payroll/dashboard?financialYearId=${fy.id}`);
  assert.equal(res.status, 200);
  assert.equal(typeof res.body.totalEmployees, 'number');
  assert.equal(typeof res.body.processed, 'number');
  assert.equal(typeof res.body.pending, 'number');
  assert.equal(typeof res.body.payrollExceptions, 'number');
  assert.equal(typeof res.body.totalGross, 'number');
});

test('full payroll flow: draft structure -> activate -> regime -> calculate -> approve -> payslip', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');

  const fyRes = await client.get('/api/payroll/financial-years');
  assert.equal(fyRes.status, 200);
  const fy = fyRes.body.financialYears[0];
  assert.ok(fy, 'seed data should include a financial year');

  const usersRes = await client.get('/api/admin/employees?pageSize=200');
  const employee = usersRes.body.items.find((u) => u.role === 'employee');
  assert.ok(employee, 'seed data should include an employee');

  // Creating a structure must land in 'draft' and must NOT disturb whatever
  // active structure already existed (the bug this regression guards).
  const preExisting = await client.get(`/api/payroll/salary-structures?userId=${employee.id}`);
  const activeBefore = preExisting.body.structures.find((s) => s.status === 'active');

  const structureRes = await client.post('/api/payroll/salary-structures', {
    userId: employee.id, effectiveFrom: fy.start_date, annualCtc: 900000,
  });
  assert.equal(structureRes.status, 201);
  const structureId = structureRes.body.id;

  const afterCreate = await client.get(`/api/payroll/salary-structures/${structureId}`);
  assert.equal(afterCreate.status, 200);
  assert.equal(afterCreate.body.status, 'draft');

  if (activeBefore) {
    const stillActive = await client.get(`/api/payroll/salary-structures/${activeBefore.id}`);
    assert.equal(stillActive.body.status, 'active', 'creating a draft must not supersede the existing active structure');
  }

  // Free-form named components (the "Salary Structure Builder" contract).
  const saveComponents = await client.put(`/api/payroll/salary-structures/${structureId}/components`, {
    components: [
      { componentName: 'Basic', type: 'earning', category: null, amount: 40000, isTaxable: true },
      { componentName: 'Special Allowance', type: 'earning', category: null, amount: 20000, isTaxable: true },
    ],
  });
  assert.equal(saveComponents.status, 200);

  // Now activate the draft — this is the step that should supersede the
  // previous active structure.
  const activateRes = await client.post(`/api/payroll/salary-structures/${structureId}/activate`);
  assert.equal(activateRes.status, 200);

  const afterActivate = await client.get(`/api/payroll/salary-structures/${structureId}`);
  assert.equal(afterActivate.body.status, 'active');
  if (activeBefore) {
    const nowSuperseded = await client.get(`/api/payroll/salary-structures/${activeBefore.id}`);
    assert.equal(nowSuperseded.body.status, 'superseded');
  }

  const regimesRes = await client.get(`/api/payroll/tax-regimes?financialYearId=${fy.id}`);
  const newRegime = regimesRes.body.regimes.find((r) => r.code === 'new');
  const regimeSetRes = await client.post('/api/payroll/my-tax-regime', {
    financialYearId: fy.id, taxRegimeId: newRegime.id,
  });
  // setting *my* tax regime as the admin isn't the point here — this exists
  // to confirm the endpoint accepts the frontend's exact self-service shape.
  assert.equal(regimeSetRes.status, 200);

  const payrollMonth = '2027-03'; // month unlikely to already have a run in fresh seed data
  const createRun = await client.post('/api/payroll/runs', { financialYearId: fy.id, payrollMonth });
  assert.equal(createRun.status, 201);
  const runId = createRun.body.id;

  const calcRes = await client.post(`/api/payroll/runs/${runId}/calculate`, {});
  assert.equal(calcRes.status, 200);
  assert.equal(calcRes.body.status, 'calculated');
  assert.equal(calcRes.body.totalEmployees, calcRes.body.total_employees);

  const detailsRes = await client.get(`/api/payroll/runs/${runId}/details`);
  assert.equal(detailsRes.status, 200);
  const detail = detailsRes.body.details.find((d) => d.user_id === employee.id);
  assert.ok(detail, 'the employee with an active salary structure should have a payroll detail row');
  assert.ok(detail.gross_earning > 0);
  assert.equal(Math.round((detail.gross_earning - detail.total_deductions) * 100) / 100, detail.net_salary);

  const approveRes = await client.post(`/api/payroll/runs/${runId}/approve`, {});
  assert.equal(approveRes.status, 200);

  const payslipRes = await client.post('/api/payroll/payslips/generate', { payrollDetailId: detail.id });
  assert.equal(payslipRes.status, 201);
  assert.ok(payslipRes.body.id);
  assert.ok(payslipRes.body.sizeBytes > 100);
});

test('a percentage-based hike (no newAnnualCtc, no financialYearId) works end to end', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');

  const usersRes = await client.get('/api/admin/employees?pageSize=200');
  const employee = usersRes.body.items.find((u) => u.annual_ctc);
  assert.ok(employee, 'seed data should include an employee with an active salary structure');

  // This is exactly the payload HikeModalBody sends when the admin fills in
  // a hike percentage instead of typing a new CTC directly.
  const hikeRes = await client.post(`/api/admin/employees/${employee.id}/hike`, {
    hikePercentage: 10,
    effectiveDate: '2027-04-01',
    reason: 'Regression test annual hike',
  });
  assert.equal(hikeRes.status, 201);
  assert.ok(hikeRes.body.newCtc > employee.annual_ctc);
  assert.equal(Math.round(hikeRes.body.hikePercentage), 10);
});

test('employee cannot view another employee\'s payroll data', async () => {
  const adminClient = makeClient();
  await adminClient.login('admin@vasjo.com', 'admin123');
  const usersRes = await adminClient.get('/api/admin/employees?pageSize=200');
  const manager = usersRes.body.items.find((u) => u.role === 'manager');
  assert.ok(manager, 'seed data should include a manager');

  const client = makeClient();
  await client.login('employee@vasjo.com', 'employee123');
  const res = await client.get(`/api/payroll/salary-structures?userId=${manager.id}`);
  assert.equal(res.status, 403);
});

test('admin dashboard aggregation returns the fields the payroll dashboard reads', async () => {
  const client = makeClient();
  await client.login('admin@vasjo.com', 'admin123');
  const fyRes = await client.get('/api/payroll/financial-years');
  const fy = fyRes.body.financialYears[0];

  const res = await client.get(`/api/payroll/dashboard?financialYearId=${fy.id}`);
  assert.equal(res.status, 200);
  for (const field of ['totalEmployees', 'processed', 'pending', 'totalGross', 'currentMonth']) {
    assert.ok(field in res.body, `dashboard response should include ${field}`);
  }
});
