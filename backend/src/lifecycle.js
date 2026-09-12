// src/lifecycle.js — BLOCK 1: Advanced Employee Lifecycle
//
// Target lifecycle: Candidate -> Offer -> Onboarding -> Probation ->
// Confirmed -> Active -> Promotion/Transfer -> Resignation -> Notice Period
// -> Full & Final -> Exited. This system doesn't model pre-hire stages
// (Candidate/Offer — that's applicant-tracking scope, not HRIS scope); the
// lifecycle here starts the moment a user account is created. Resignation,
// notice period, and Full & Final are already owned by src/fnf.js (Block 6)
// — this module hooks into that (see the two integration functions at the
// bottom) rather than re-implementing it.

const db = require('./db');
const { nowStr, todayStr } = require('./utils');

const TRANSFERABLE_FIELDS = {
  department_transfer: { userField: 'dept', dbColumn: 'dept' },
  designation_change: { userField: 'title', dbColumn: 'title' },
  manager_change: { userField: 'manager_id', dbColumn: 'manager_id' },
  location_change: { userField: 'location', dbColumn: 'location' },
};

// ---------------------------------------------------------------------------
// ONBOARDING
// ---------------------------------------------------------------------------

async function initializeLifecycle(userId, actorId) {
  const user = await db.findUserById(userId);
  if (!user) throw new Error('User not found');
  await db.updateLifecycleStatus(userId, 'onboarding');
  await db.createLifecycleEvent({ userId, eventType: 'joined', newValue: user.joined_date || todayStr(), effectiveDate: user.joined_date || todayStr(), recordedBy: actorId });
  const tasksCreated = await generateChecklist(userId, 'onboarding');
  return { userId, status: 'onboarding', tasksCreated };
}

async function generateChecklist(userId, type, employeeSeparationId) {
  const templates = await db.listChecklistTemplateItems(type);
  for (const t of templates) {
    await db.createChecklistTask({ userId, employeeSeparationId, templateItemId: t.id, type, label: t.label });
  }
  return templates.length;
}

async function completeOnboarding(userId, actorId, notes) {
  await db.updateLifecycleStatus(userId, 'active');
  await db.createLifecycleEvent({ userId, eventType: 'status_change', previousValue: 'onboarding', newValue: 'active', effectiveDate: todayStr(), notes, recordedBy: actorId });
  return { userId, status: 'active' };
}

// ---------------------------------------------------------------------------
// TRANSFERS (department / designation / manager / location)
// ---------------------------------------------------------------------------

async function recordTransfer(eventType, { userId, newValue, effectiveDate, actorId, notes }) {
  const mapping = TRANSFERABLE_FIELDS[eventType];
  if (!mapping) throw new Error(`Unknown transfer event type: ${eventType}`);
  const user = await db.findUserById(userId);
  if (!user) throw new Error('User not found');
  const previousValue = user[mapping.userField] != null ? String(user[mapping.userField]) : null;

  await db.updateUserAdmin(userId, { [mapping.dbColumn]: newValue });
  await db.createLifecycleEvent({
    userId, eventType, previousValue, newValue: newValue != null ? String(newValue) : null,
    effectiveDate: effectiveDate || todayStr(), notes, recordedBy: actorId,
  });
  return { userId, eventType, previousValue, newValue };
}

const transferDepartment = (args) => recordTransfer('department_transfer', { ...args, newValue: args.newDept });
const changeDesignation = (args) => recordTransfer('designation_change', { ...args, newValue: args.newTitle });
const changeManager = (args) => recordTransfer('manager_change', { ...args, newValue: args.newManagerId });
const changeLocation = (args) => recordTransfer('location_change', { ...args, newValue: args.newLocation });

async function promoteEmployee({ userId, newTitle, newDept, effectiveDate, actorId, notes }) {
  const user = await db.findUserById(userId);
  if (!user) throw new Error('User not found');
  const previousValue = JSON.stringify({ title: user.title, dept: user.dept });
  const patch = {};
  if (newTitle) patch.title = newTitle;
  if (newDept) patch.dept = newDept;
  if (!Object.keys(patch).length) throw new Error('Provide at least a newTitle or newDept for a promotion');
  await db.updateUserAdmin(userId, patch);
  const newValue = JSON.stringify({ title: newTitle || user.title, dept: newDept || user.dept });
  await db.createLifecycleEvent({ userId, eventType: 'promotion', previousValue, newValue, effectiveDate: effectiveDate || todayStr(), notes, recordedBy: actorId });
  return { userId, previousValue: JSON.parse(previousValue), newValue: JSON.parse(newValue) };
}

// ---------------------------------------------------------------------------
// PROBATION
// ---------------------------------------------------------------------------

async function startProbation({ userId, startDate, durationDays, actorId, notes }) {
  const existing = await db.getActiveProbationForUser(userId);
  if (existing) throw new Error('This employee already has an active probation record');
  const start = startDate || todayStr();
  const expected = new Date(start + 'T00:00:00Z');
  expected.setUTCDate(expected.getUTCDate() + (durationDays || 90));
  const expectedEndDate = expected.toISOString().slice(0, 10);

  const id = await db.createProbationRecord({ userId, startDate: start, expectedEndDate, notes });
  await db.updateLifecycleStatus(userId, 'probation');
  await db.createLifecycleEvent({ userId, eventType: 'probation_started', newValue: expectedEndDate, effectiveDate: start, notes, recordedBy: actorId });
  return { id, userId, startDate: start, expectedEndDate };
}

async function confirmProbation(probationId, actorId, notes) {
  const record = await db.getProbationRecord(probationId);
  if (!record) throw new Error('Probation record not found');
  if (record.status === 'confirmed') throw new Error('This probation has already been confirmed');
  await db.confirmProbationRecord(probationId, actorId);
  await db.updateLifecycleStatus(record.user_id, 'active');
  await db.createLifecycleEvent({ userId: record.user_id, eventType: 'probation_confirmed', effectiveDate: todayStr(), notes, recordedBy: actorId });
  return db.getProbationRecord(probationId);
}

async function extendProbation(probationId, newEndDate, actorId, notes) {
  const record = await db.getProbationRecord(probationId);
  if (!record) throw new Error('Probation record not found');
  if (record.status === 'confirmed') throw new Error('Cannot extend a probation that has already been confirmed');
  if (newEndDate <= record.expected_end_date) throw new Error('The extended date must be after the current expected end date');
  await db.extendProbationRecord(probationId, newEndDate, notes);
  await db.createLifecycleEvent({ userId: record.user_id, eventType: 'probation_extended', previousValue: record.expected_end_date, newValue: newEndDate, effectiveDate: todayStr(), notes, recordedBy: actorId });
  return db.getProbationRecord(probationId);
}

// ---------------------------------------------------------------------------
// DOCUMENTS
// ---------------------------------------------------------------------------

async function uploadDocument({ userId, docType, filePath, issueDate, expiryDate, uploadedBy }) {
  if (!docType) throw new Error('docType is required');
  return db.createEmployeeDocument({ userId, docType, filePath, issueDate, expiryDate, uploadedBy });
}

async function getExpiringDocuments(daysAhead) {
  return db.listExpiringDocuments(daysAhead || 30);
}

// ---------------------------------------------------------------------------
// CHECKLIST TASKS
// ---------------------------------------------------------------------------

async function completeChecklistTask(taskId, actorId, notes) {
  return db.completeChecklistTask(taskId, actorId, notes);
}

// ---------------------------------------------------------------------------
// EXIT INTERVIEW
// ---------------------------------------------------------------------------

async function recordExitInterview({ employeeSeparationId, conductedBy, reasonForLeaving, feedback, wouldRehire, rating }) {
  const existing = await db.getExitInterview(employeeSeparationId);
  if (existing) throw new Error('An exit interview has already been recorded for this separation');
  return db.createExitInterview({ employeeSeparationId, conductedBy, reasonForLeaving, feedback, wouldRehire, rating });
}

// ---------------------------------------------------------------------------
// TIMELINE / PROFILE
// ---------------------------------------------------------------------------

async function getEmployeeLifecycleProfile(userId) {
  const [user, events, probation, documents, onboardingTasks] = await Promise.all([
    db.findUserById(userId), db.listLifecycleEventsForUser(userId), db.getActiveProbationForUser(userId),
    db.listDocumentsForUser(userId), db.listChecklistTasksForUser(userId, 'onboarding'),
  ]);
  if (!user) throw new Error('User not found');
  return {
    userId, lifecycleStatus: user.lifecycle_status, events, activeProbation: probation, documents, onboardingTasks,
  };
}

// ---------------------------------------------------------------------------
// INTEGRATION WITH BLOCK 6 (fnf.js) — separation approval / settlement paid
// ---------------------------------------------------------------------------

// Called from fnf.js when a separation is approved: moves the employee into
// notice_period and generates the offboarding checklist for that separation.
async function onSeparationApproved(userId, employeeSeparationId, actorId) {
  await db.updateLifecycleStatus(userId, 'notice_period');
  await db.createLifecycleEvent({ userId, eventType: 'resigned', effectiveDate: todayStr(), recordedBy: actorId });
  const tasksCreated = await generateChecklist(userId, 'offboarding', employeeSeparationId);
  return { tasksCreated };
}

// Called from fnf.js when a settlement is marked paid: the terminal lifecycle event.
async function onSettlementPaid(userId, actorId, client) {
  await db.updateLifecycleStatus(userId, 'exited', client);
  await db.createLifecycleEvent({ userId, eventType: 'exited', effectiveDate: todayStr(), recordedBy: actorId }, client);
}

module.exports = {
  initializeLifecycle,
  generateChecklist,
  completeOnboarding,
  transferDepartment,
  changeDesignation,
  changeManager,
  changeLocation,
  promoteEmployee,
  startProbation,
  confirmProbation,
  extendProbation,
  uploadDocument,
  getExpiringDocuments,
  completeChecklistTask,
  recordExitInterview,
  getEmployeeLifecycleProfile,
  onSeparationApproved,
  onSettlementPaid,
};
