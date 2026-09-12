// tests/lifecycle_block1_unit.test.js
//
// Offline unit tests for Block 1 (Advanced Employee Lifecycle).
//
// Run with:  node --test tests/lifecycle_block1_unit.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const lifecycle = require('../src/lifecycle');

let patched = [];
function mock(name, fn) { patched.push([name, db[name]]); db[name] = fn; }
afterEach(() => {
  for (const [name, original] of patched) db[name] = original;
  patched = [];
});

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

test('initializeLifecycle sets status to onboarding and generates the onboarding checklist', async () => {
  mock('findUserById', async () => ({ id: 1, joined_date: '2026-06-01' }));
  let statusSet;
  mock('updateLifecycleStatus', async (userId, status) => { statusSet = status; });
  mock('createLifecycleEvent', async () => {});
  mock('listChecklistTemplateItems', async () => ([{ id: 1, label: 'Collect ID' }, { id: 2, label: 'Set up payroll' }]));
  let tasksCreated = 0;
  mock('createChecklistTask', async () => { tasksCreated++; });

  const result = await lifecycle.initializeLifecycle(1, 9);
  assert.equal(statusSet, 'onboarding');
  assert.equal(tasksCreated, 2);
  assert.equal(result.tasksCreated, 2);
});

test('completeOnboarding moves the employee to active status', async () => {
  let statusSet;
  mock('updateLifecycleStatus', async (userId, status) => { statusSet = status; });
  mock('createLifecycleEvent', async () => {});
  const result = await lifecycle.completeOnboarding(1, 9);
  assert.equal(statusSet, 'active');
  assert.equal(result.status, 'active');
});

// ---------------------------------------------------------------------------
// Transfers (department / designation / manager / location)
// ---------------------------------------------------------------------------

test('transferDepartment updates the live field and logs previous/new values', async () => {
  mock('findUserById', async () => ({ dept: 'Engineering' }));
  let patched_;
  mock('updateUserAdmin', async (userId, patch) => { patched_ = patch; });
  let event;
  mock('createLifecycleEvent', async (data) => { event = data; });

  const result = await lifecycle.transferDepartment({ userId: 1, newDept: 'Sales', actorId: 9 });
  assert.equal(patched_.dept, 'Sales');
  assert.equal(event.eventType, 'department_transfer');
  assert.equal(event.previousValue, 'Engineering');
  assert.equal(event.newValue, 'Sales');
  assert.equal(result.previousValue, 'Engineering');
});

test('changeManager stores manager IDs as strings for the history record', async () => {
  mock('findUserById', async () => ({ manager_id: 5 }));
  mock('updateUserAdmin', async () => {});
  let event;
  mock('createLifecycleEvent', async (data) => { event = data; });

  await lifecycle.changeManager({ userId: 1, newManagerId: 8, actorId: 9 });
  assert.equal(event.eventType, 'manager_change');
  assert.equal(event.previousValue, '5');
  assert.equal(event.newValue, '8');
});

test('changeLocation handles a null previous location gracefully', async () => {
  mock('findUserById', async () => ({ location: null }));
  mock('updateUserAdmin', async () => {});
  let event;
  mock('createLifecycleEvent', async (data) => { event = data; });

  await lifecycle.changeLocation({ userId: 1, newLocation: 'Hyderabad', actorId: 9 });
  assert.equal(event.previousValue, null);
  assert.equal(event.newValue, 'Hyderabad');
});

// ---------------------------------------------------------------------------
// Promotion
// ---------------------------------------------------------------------------

test('promoteEmployee requires at least a newTitle or newDept', async () => {
  mock('findUserById', async () => ({ title: 'Engineer', dept: 'Eng' }));
  await assert.rejects(() => lifecycle.promoteEmployee({ userId: 1, actorId: 9 }), /Provide at least/);
});

test('promoteEmployee updates only the provided fields and logs both old and new as JSON', async () => {
  mock('findUserById', async () => ({ title: 'Engineer', dept: 'Eng' }));
  let patched_;
  mock('updateUserAdmin', async (userId, patch) => { patched_ = patch; });
  let event;
  mock('createLifecycleEvent', async (data) => { event = data; });

  await lifecycle.promoteEmployee({ userId: 1, newTitle: 'Senior Engineer', actorId: 9 });
  assert.deepEqual(patched_, { title: 'Senior Engineer' });
  const prev = JSON.parse(event.previousValue);
  const next = JSON.parse(event.newValue);
  assert.equal(prev.title, 'Engineer');
  assert.equal(next.title, 'Senior Engineer');
  assert.equal(next.dept, 'Eng'); // unchanged field carried through
});

// ---------------------------------------------------------------------------
// Probation
// ---------------------------------------------------------------------------

test('startProbation refuses a second active probation for the same employee', async () => {
  mock('getActiveProbationForUser', async () => ({ id: 1, status: 'on_probation' }));
  await assert.rejects(() => lifecycle.startProbation({ userId: 1, actorId: 9 }), /already has an active probation/);
});

test('startProbation computes the expected end date from the duration', async () => {
  mock('getActiveProbationForUser', async () => null);
  let captured;
  mock('createProbationRecord', async (data) => { captured = data; return 501; });
  mock('updateLifecycleStatus', async () => {});
  mock('createLifecycleEvent', async () => {});

  const result = await lifecycle.startProbation({ userId: 1, startDate: '2026-01-01', durationDays: 90, actorId: 9 });
  assert.equal(result.expectedEndDate, '2026-04-01');
  assert.equal(captured.expectedEndDate, '2026-04-01');
});

test('confirmProbation refuses to re-confirm an already-confirmed record', async () => {
  mock('getProbationRecord', async () => ({ status: 'confirmed' }));
  await assert.rejects(() => lifecycle.confirmProbation(1, 9), /already been confirmed/);
});

test('confirmProbation moves lifecycle status to active', async () => {
  mock('getProbationRecord', async () => ({ id: 1, user_id: 1, status: 'on_probation' }));
  mock('confirmProbationRecord', async () => {});
  let statusSet;
  mock('updateLifecycleStatus', async (userId, status) => { statusSet = status; });
  mock('createLifecycleEvent', async () => {});
  await lifecycle.confirmProbation(1, 9);
  assert.equal(statusSet, 'active');
});

test('extendProbation refuses to extend an already-confirmed probation', async () => {
  mock('getProbationRecord', async () => ({ status: 'confirmed', expected_end_date: '2026-04-01' }));
  await assert.rejects(() => lifecycle.extendProbation(1, '2026-06-01', 9), /already been confirmed/);
});

test('extendProbation requires the new date to be after the current expected end date', async () => {
  mock('getProbationRecord', async () => ({ status: 'on_probation', expected_end_date: '2026-04-01' }));
  await assert.rejects(() => lifecycle.extendProbation(1, '2026-03-01', 9), /must be after/);
});

test('extendProbation succeeds with a valid later date and logs the change', async () => {
  mock('getProbationRecord', async () => ({ user_id: 1, status: 'on_probation', expected_end_date: '2026-04-01' }));
  mock('extendProbationRecord', async () => {});
  let event;
  mock('createLifecycleEvent', async (data) => { event = data; });
  await lifecycle.extendProbation(1, '2026-06-01', 9, 'needs more ramp-up time');
  assert.equal(event.eventType, 'probation_extended');
  assert.equal(event.previousValue, '2026-04-01');
  assert.equal(event.newValue, '2026-06-01');
});

// ---------------------------------------------------------------------------
// Exit interview
// ---------------------------------------------------------------------------

test('recordExitInterview refuses to record a second interview for the same separation', async () => {
  mock('getExitInterview', async () => ({ id: 1 }));
  await assert.rejects(() => lifecycle.recordExitInterview({ employeeSeparationId: 1, conductedBy: 9 }), /already been recorded/);
});

// ---------------------------------------------------------------------------
// F&F integration hooks
// ---------------------------------------------------------------------------

test('onSeparationApproved moves the employee to notice_period and generates the offboarding checklist', async () => {
  let statusSet;
  mock('updateLifecycleStatus', async (userId, status) => { statusSet = status; });
  mock('createLifecycleEvent', async () => {});
  mock('listChecklistTemplateItems', async () => ([{ id: 1, label: 'Return laptop' }]));
  let taskArgs;
  mock('createChecklistTask', async (data) => { taskArgs = data; });

  const result = await lifecycle.onSeparationApproved(1, 55, 9);
  assert.equal(statusSet, 'notice_period');
  assert.equal(result.tasksCreated, 1);
  assert.equal(taskArgs.employeeSeparationId, 55);
  assert.equal(taskArgs.type, 'offboarding');
});

test('onSettlementPaid sets lifecycle status to exited and logs the terminal event', async () => {
  let statusSet;
  mock('updateLifecycleStatus', async (userId, status) => { statusSet = status; });
  let event;
  mock('createLifecycleEvent', async (data) => { event = data; });

  await lifecycle.onSettlementPaid(1, 9);
  assert.equal(statusSet, 'exited');
  assert.equal(event.eventType, 'exited');
});
