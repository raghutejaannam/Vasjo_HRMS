// ============================================================
// api.js — ALL backend communication lives here.
//
// This is a 1:1 port of the `api()` helper and every fetch call that used to
// live inline inside the old single-file HTML app. Endpoints, HTTP methods,
// request payloads and response shapes are UNCHANGED from the original app.
// The backend, database, auth and business logic (esp. payroll calculation)
// are untouched — React only calls these endpoints and displays what comes
// back. Nothing here computes payroll, tax, or leave balances itself.
// ============================================================

let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token;
}

export function getCsrfToken() {
  return csrfToken;
}

/**
 * Low-level fetch wrapper — identical behavior to the original `api()`:
 * - always sends cookies (credentials: include)
 * - attaches X-CSRF-Token on non-GET requests once we have one
 * - throws an Error with `.status` set on non-2xx responses
 * - tolerates empty/non-JSON bodies (e.g. CSV/PDF download endpoints)
 */
async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (opts.method && opts.method !== "GET" && csrfToken) headers["X-CSRF-Token"] = csrfToken;
  const res = await fetch(path, { credentials: "include", ...opts, headers });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* no body, e.g. CSV/PDF endpoints */
  }
  if (!res.ok) {
    const err = new Error(data.error || "Request failed");
    err.status = res.status;
    throw err;
  }
  return data;
}

export default api;

// ------------------------------------------------------------
// Auth
// ------------------------------------------------------------
export const login = (email, password) =>
  api("/api/login", { method: "POST", body: JSON.stringify({ email, password }) });

export const logout = () => api("/api/logout", { method: "POST" });

export const me = () => api("/api/me");

export const updateMe = (payload) => api("/api/me", { method: "PATCH", body: JSON.stringify(payload) });

export const changePassword = (currentPassword, newPassword) =>
  api("/api/change-password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });

// ------------------------------------------------------------
// Notifications
// ------------------------------------------------------------
export const getNotifications = () => api("/api/notifications");
export const markNotificationRead = (id) => api(`/api/notifications/${id}/read`, { method: "PATCH" });
export const markAllNotificationsRead = () => api("/api/notifications/read-all", { method: "PATCH" });

// ------------------------------------------------------------
// Settings / leave types / holidays / departments
// ------------------------------------------------------------
export const getSettings = () => api("/api/settings");
export const saveSettings = (payload) => api("/api/settings", { method: "PATCH", body: JSON.stringify(payload) });

export const getLeaveTypes = () => api("/api/leave-types");
export const addLeaveType = (payload) => api("/api/leave-types", { method: "POST", body: JSON.stringify(payload) });
export const updateLeaveType = (id, payload) => api(`/api/leave-types/${id}`, { method: "PATCH", body: JSON.stringify(payload) });

export const getHolidays = () => api("/api/holidays");
export const addHoliday = (payload) => api("/api/holidays", { method: "POST", body: JSON.stringify(payload) });
export const deleteHoliday = (id) => api(`/api/holidays/${id}`, { method: "DELETE" });

export const getDepartments = (all) => api(`/api/departments${all ? "?all=1" : ""}`);
export const addDepartment = (name) => api("/api/departments", { method: "POST", body: JSON.stringify({ name }) });
export const toggleDepartment = (id, active) => api(`/api/departments/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });

// ------------------------------------------------------------
// Projects & tasks
// ------------------------------------------------------------
export const getProjects = (all) => api(`/api/projects${all ? "?all=1" : ""}`);
export const addProject = (payload) => api("/api/projects", { method: "POST", body: JSON.stringify(payload) });
export const toggleProject = (id, active) => api(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify({ active }) });
export const getProjectAssignments = (projectId) => api(`/api/projects/${projectId}/assignments`);
export const saveProjectAssignments = (projectId, userIds) =>
  api(`/api/projects/${projectId}/assignments`, { method: "PUT", body: JSON.stringify({ userIds }) });

export const getTasks = (all) => api(`/api/tasks${all ? "?all=1" : ""}`);
export const addTask = (projectId, name) => api("/api/tasks", { method: "POST", body: JSON.stringify({ projectId, name }) });

// ------------------------------------------------------------
// Timesheets
// ------------------------------------------------------------
export const getTimesheetByWeek = (weekStart) => api(`/api/timesheets?weekStart=${weekStart}`);
export const getMyTimesheets = () => api("/api/timesheets");
export const getMyTimesheetsPaged = (page, pageSize) => api(`/api/timesheets?page=${page}&pageSize=${pageSize}`);
export const getPendingTimesheets = () => api("/api/timesheets?all=1&status=pending");
export const getAllTimesheets = ({ page = 1, pageSize = 25, employeeId, status } = {}) => {
  let url = `/api/timesheets?all=1&page=${page}&pageSize=${pageSize}`;
  if (employeeId) url += `&employeeId=${employeeId}`;
  if (status) url += `&status=${status}`;
  return api(url);
};
export const saveTimesheet = (weekStart, entries, submit) =>
  api("/api/timesheets", { method: "POST", body: JSON.stringify({ weekStart, entries, submit }) });
export const decideTimesheet = (id, action, comment) =>
  api(`/api/timesheets/${id}`, { method: "PATCH", body: JSON.stringify({ action, comment }) });
export const bulkDecideTimesheets = (ids, action, comment) =>
  api("/api/timesheets/bulk-decide", { method: "POST", body: JSON.stringify({ ids, action, comment }) });
export const requestTimesheetCorrection = (id, reason) =>
  api(`/api/timesheets/${id}/request-correction`, { method: "POST", body: JSON.stringify({ reason }) });
export const decideTimesheetCorrection = (id, action, comment) =>
  api(`/api/timesheets/${id}/decide-correction`, { method: "PATCH", body: JSON.stringify({ action, comment }) });
export const getCorrectionRequests = () => api("/api/correction-requests");

// ------------------------------------------------------------
// Leave
// ------------------------------------------------------------
export const getMyLeaveApplications = () => api("/api/leave-applications");
export const getPendingLeaveApplications = () => api("/api/leave-applications?all=1&status=pending");
export const getTeamLeaveApplications = () => api("/api/leave-applications?team=1");
export const getLeaveBalances = () => api("/api/leave-balances");
export const applyForLeave = ({ leaveTypeId, from, to, reason, halfDay }) =>
  api("/api/leave-applications", { method: "POST", body: JSON.stringify({ leaveTypeId, from, to, reason, halfDay }) });
export const cancelLeaveApplication = (id) => api(`/api/leave-applications/${id}/cancel`, { method: "PATCH" });
export const decideLeaveApplication = (id, action, comment) =>
  api(`/api/leave-applications/${id}`, { method: "PATCH", body: JSON.stringify({ action, comment }) });
export const bulkDecideLeaveApplications = (ids, action, comment) =>
  api("/api/leave-applications/bulk-decide", { method: "POST", body: JSON.stringify({ ids, action, comment }) });

// ------------------------------------------------------------
// Team / users / admin
// ------------------------------------------------------------
export const getTeamMembers = () => api("/api/team-members");
export const getUsersFlat = () => api("/api/users/flat");
export const getUsers = (pageSize = 100) => api(`/api/users?pageSize=${pageSize}`);
export const getUser = (id) => api(`/api/users/${id}`);
export const updateUser = (id, payload) => api(`/api/users/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const createUser = (payload) => api("/api/users", { method: "POST", body: JSON.stringify(payload) });
export const resetUserPassword = (id) => api(`/api/users/${id}/reset-password`, { method: "POST" });
export const importUsersCsv = (csv) => api("/api/users/import-csv", { method: "POST", body: JSON.stringify({ csv }) });

export const getAdminEmployees = ({ page = 1, pageSize = 50, search = "", department = "", status = "", sortBy = "name", sortDir = "asc" } = {}) =>
  api(`/api/admin/employees?pageSize=${pageSize}&page=${page}&search=${encodeURIComponent(search)}&department=${encodeURIComponent(department)}&status=${status}&sortBy=${sortBy}&sortDir=${sortDir}`);
export const getAdminDepartments = () => api("/api/admin/departments");
export const getEmployeeCompensation = (userId) => api(`/api/admin/employees/${userId}/compensation`);
export const getEmployeeSalaryRevisions = (userId) => api(`/api/admin/employees/${userId}/salary-revisions`);
export const giveEmployeeHike = (userId, payload) =>
  api(`/api/admin/employees/${userId}/hike`, { method: "POST", body: JSON.stringify(payload) });

// ------------------------------------------------------------
// Audit log
// ------------------------------------------------------------
export const getAuditLog = (entityType, entityId) => api(`/api/audit-log?entityType=${entityType}&entityId=${entityId}`);

// ------------------------------------------------------------
// Analytics
// ------------------------------------------------------------
export const getMyTrend = (weeks = 8) => api(`/api/analytics/my-trend?weeks=${weeks}`);
export const getTeamSummary = () => api("/api/analytics/team-summary");

// ------------------------------------------------------------
// Reports (JSON views; CSV export links are built directly against these
// same endpoints with &format=csv, or the dedicated .csv routes below)
// ------------------------------------------------------------
export const getProjectHoursReport = (from, to) => api(`/api/reports/project-hours?from=${from}&to=${to}`);
export const getUtilizationReport = (from, to) => api(`/api/reports/utilization?from=${from}&to=${to}`);
export const getLeaveUsageReport = (year) => api(`/api/reports/leave-usage?year=${year}`);
export const getComplianceReport = (weekStart) => api(`/api/reports/compliance?weekStart=${weekStart}`);
export const getPendingApprovalsReport = () => api("/api/reports/pending-approvals");
export const timesheetsCsvUrl = () => "/api/reports/timesheets.csv";
export const leaveCsvUrl = () => "/api/reports/leave.csv";
export const projectHoursCsvUrl = (from, to) => `/api/reports/project-hours?from=${from}&to=${to}&format=csv`;
export const utilizationCsvUrl = (from, to) => `/api/reports/utilization?from=${from}&to=${to}&format=csv`;
export const leaveUsageCsvUrl = (year) => `/api/reports/leave-usage?year=${year}&format=csv`;
export const complianceCsvUrl = (weekStart) => `/api/reports/compliance?weekStart=${weekStart}&format=csv`;

// ------------------------------------------------------------
// Payroll — financial years
// ------------------------------------------------------------
export const getFinancialYears = () => api("/api/payroll/financial-years");

// ------------------------------------------------------------
// Payroll — salary structures (admin builds these; frontend never computes
// CTC/PF/tax/gratuity/insurance math — it only sends amounts the admin typed
// and displays whatever the backend returns)
// ------------------------------------------------------------
export const getSalaryStructures = (userId) => api(`/api/payroll/salary-structures?userId=${userId}`);
export const getSalaryStructure = (id) => api(`/api/payroll/salary-structures/${id}`);
export const createSalaryStructure = (payload) =>
  api("/api/payroll/salary-structures", { method: "POST", body: JSON.stringify(payload) });
export const updateSalaryStructure = (id, payload) =>
  api(`/api/payroll/salary-structures/${id}`, { method: "PATCH", body: JSON.stringify(payload) });
export const saveSalaryStructureComponents = (id, components) =>
  api(`/api/payroll/salary-structures/${id}/components`, { method: "PUT", body: JSON.stringify({ components }) });
export const activateSalaryStructure = (id) => api(`/api/payroll/salary-structures/${id}/activate`, { method: "POST" });

// ------------------------------------------------------------
// Payroll — my tax regime / declarations (employee self-service)
// ------------------------------------------------------------
export const getMyTaxRegime = (financialYearId) => api(`/api/payroll/my-tax-regime?financialYearId=${financialYearId}`);
export const setMyTaxRegime = (financialYearId, taxRegimeId) =>
  api("/api/payroll/my-tax-regime", { method: "POST", body: JSON.stringify({ financialYearId, taxRegimeId }) });
export const compareMyTaxRegimes = (financialYearId) => api(`/api/payroll/my-tax-regime/compare?financialYearId=${financialYearId}`);
export const getTaxRegimes = (financialYearId) => api(`/api/payroll/tax-regimes?financialYearId=${financialYearId}`);
export const getTaxDeclarationSections = (financialYearId) => api(`/api/payroll/tax-declaration-sections?financialYearId=${financialYearId}`);
export const getMyTaxDeclarations = (financialYearId) => api(`/api/payroll/my-tax-declarations?financialYearId=${financialYearId}`);
export const createOrGetTaxDeclaration = (financialYearId, sectionId) =>
  api("/api/payroll/my-tax-declarations", { method: "POST", body: JSON.stringify({ financialYearId, sectionId }) });
export const addTaxDeclarationEntry = (declarationId, payload) =>
  api(`/api/payroll/tax-declarations/${declarationId}/entries`, { method: "POST", body: JSON.stringify(payload) });
export const deleteTaxDeclarationEntry = (entryId) => api(`/api/payroll/tax-entries/${entryId}`, { method: "DELETE" });
export const submitAllTaxDeclarations = (financialYearId) =>
  api("/api/payroll/my-tax-declarations/submit-all", { method: "POST", body: JSON.stringify({ financialYearId }) });
export const getMyTaxSummary = (financialYearId) => api(`/api/payroll/my-tax-summary?financialYearId=${financialYearId}`);

// ------------------------------------------------------------
// Payroll — payslips
// ------------------------------------------------------------
export const getMyPayslips = (financialYearId) => api(`/api/payroll/my-payslips?financialYearId=${financialYearId}`);
export const generatePayslip = (payrollDetailId) =>
  api("/api/payroll/payslips/generate", { method: "POST", body: JSON.stringify({ payrollDetailId }) });
export const payslipPdfUrl = (payslipId) => `/api/payroll/payslips/${payslipId}/pdf`;

// ------------------------------------------------------------
// Payroll — admin dashboard & runs
// ------------------------------------------------------------
export const getPayrollDashboard = (financialYearId) => api(`/api/payroll/dashboard?financialYearId=${financialYearId}`);
export const getPayrollRuns = (financialYearId) => api(`/api/payroll/runs?financialYearId=${financialYearId}`);
export const createPayrollRun = (financialYearId, payrollMonth) =>
  api("/api/payroll/runs", { method: "POST", body: JSON.stringify({ financialYearId, payrollMonth }) });
export const actOnPayrollRun = (runId, action) => api(`/api/payroll/runs/${runId}/${action}`, { method: "POST" });
export const deletePayrollRun = (runId) => api(`/api/payroll/runs/${runId}`, { method: "DELETE" });
export const getPayrollRunDetails = (runId) => api(`/api/payroll/runs/${runId}/details`);
export const getPayrollRunExceptions = (runId) => api(`/api/payroll/runs/${runId}/exceptions`);
export const resolvePayrollException = (exceptionId, notes) =>
  api(`/api/payroll/exceptions/${exceptionId}/resolve`, { method: "POST", body: JSON.stringify({ notes }) });

// ------------------------------------------------------------
// Payroll — employee loans
// ------------------------------------------------------------
export const getLoansForEmployee = (userId) => api(`/api/payroll/employees/${userId}/loans`);
export const requestLoan = (userId, payload) =>
  api(`/api/payroll/employees/${userId}/loans`, { method: "POST", body: JSON.stringify(payload) });
export const getAllLoans = (status) => api(`/api/payroll/loans${status ? `?status=${status}` : ""}`);
export const decideLoan = (loanId, decision) =>
  api(`/api/payroll/loans/${loanId}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
export const disburseLoan = (loanId) => api(`/api/payroll/loans/${loanId}/disburse`, { method: "POST" });
export const getLoanRepayments = (loanId) => api(`/api/payroll/loans/${loanId}/repayments`);

// ------------------------------------------------------------
// Payroll — salary advances
// ------------------------------------------------------------
export const getAdvancesForEmployee = (userId) => api(`/api/payroll/employees/${userId}/advances`);
export const requestAdvance = (userId, payload) =>
  api(`/api/payroll/employees/${userId}/advances`, { method: "POST", body: JSON.stringify(payload) });
export const getAllAdvances = (status) => api(`/api/payroll/advances${status ? `?status=${status}` : ""}`);
export const decideAdvance = (advanceId, decision, recoveryMonths, monthlyRecoveryAmount) =>
  api(`/api/payroll/advances/${advanceId}/decide`, { method: "POST", body: JSON.stringify({ decision, recoveryMonths, monthlyRecoveryAmount }) });
export const getAdvanceRecoveries = (advanceId) => api(`/api/payroll/advances/${advanceId}/recoveries`);

// ------------------------------------------------------------
// Payroll — leave encashment
// ------------------------------------------------------------
export const getLeaveEncashmentsForEmployee = (userId) => api(`/api/payroll/employees/${userId}/leave-encashment`);
export const requestLeaveEncashment = (userId, payload) =>
  api(`/api/payroll/employees/${userId}/leave-encashment`, { method: "POST", body: JSON.stringify(payload) });
export const getAllLeaveEncashments = (status) => api(`/api/payroll/leave-encashment${status ? `?status=${status}` : ""}`);
export const decideLeaveEncashment = (id, decision) =>
  api(`/api/payroll/leave-encashment/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });

// ------------------------------------------------------------
// Payroll — gratuity & arrears
// ------------------------------------------------------------
export const getGratuityEstimate = (userId, financialYearId) =>
  api(`/api/payroll/employees/${userId}/gratuity${financialYearId ? `?financialYearId=${financialYearId}` : ""}`);
export const getArrearsForEmployee = (userId) => api(`/api/payroll/employees/${userId}/arrears`);

// ------------------------------------------------------------
// Payroll — reports: month-to-month comparison & variance
// ------------------------------------------------------------
export const getPayrollComparisonReport = (financialYearId, monthA, monthB) =>
  api(`/api/payroll/reports/comparison?financialYearId=${financialYearId}&monthA=${monthA}&monthB=${monthB}`);
export const getPayrollVarianceReport = (financialYearId, monthA, monthB, threshold) =>
  api(`/api/payroll/reports/variance?financialYearId=${financialYearId}&monthA=${monthA}&monthB=${monthB}${threshold != null ? `&threshold=${threshold}` : ""}`);

// ------------------------------------------------------------
// Attendance — Block 2
// ------------------------------------------------------------
export const getShifts = (all) => api(`/api/attendance/shifts${all ? "?all=true" : ""}`);
export const createShift = (payload) => api("/api/attendance/shifts", { method: "POST", body: JSON.stringify(payload) });
export const updateShift = (id, payload) => api(`/api/attendance/shifts/${id}`, { method: "PUT", body: JSON.stringify(payload) });
export const assignShift = (userId, shiftId, effectiveFrom) =>
  api(`/api/attendance/employees/${userId}/shift`, { method: "POST", body: JSON.stringify({ shiftId, effectiveFrom }) });
export const getShiftHistory = (userId) => api(`/api/attendance/employees/${userId}/shift-history`);

export const getWeeklyOffDays = () => api("/api/attendance/weekly-off");
export const setWeeklyOffDays = (days) => api("/api/attendance/weekly-off", { method: "PUT", body: JSON.stringify({ days }) });

export const checkIn = () => api("/api/attendance/check-in", { method: "POST", body: JSON.stringify({}) });
export const checkOut = () => api("/api/attendance/check-out", { method: "POST", body: JSON.stringify({}) });
export const getTodayAttendance = () => api("/api/attendance/today");

export const markAttendance = (userId, payload) =>
  api(`/api/attendance/employees/${userId}/mark`, { method: "POST", body: JSON.stringify(payload) });

export const getAttendanceCalendar = (userId, year, month) =>
  api(`/api/attendance/employees/${userId}/calendar?year=${year}&month=${month}`);
export const getAttendanceForDay = (date) => api(`/api/attendance/day/${date}`);
export const getTeamAttendance = (from, to) => api(`/api/attendance/team?from=${from}&to=${to}`);

export const requestAttendanceCorrection = (userId, payload) =>
  api(`/api/attendance/employees/${userId}/correction`, { method: "POST", body: JSON.stringify(payload) });
export const getAttendanceCorrectionsForEmployee = (userId) => api(`/api/attendance/employees/${userId}/corrections`);
export const getAllAttendanceCorrections = (status) => api(`/api/attendance/corrections${status ? `?status=${status}` : ""}`);
export const decideAttendanceCorrection = (id, decision) =>
  api(`/api/attendance/corrections/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });

// ------------------------------------------------------------
// Compliance — Block 5
// ------------------------------------------------------------
export const getEmployerStatutoryInfo = () => api("/api/compliance/employer-info");
export const updateEmployerStatutoryInfo = (payload) => api("/api/compliance/employer-info", { method: "PUT", body: JSON.stringify(payload) });

export const getAnnualTaxStatement = (userId, financialYearId) =>
  api(`/api/compliance/employees/${userId}/annual-tax-statement${financialYearId ? `?financialYearId=${financialYearId}` : ""}`);
export const getForm16 = (userId, financialYearId) =>
  api(`/api/compliance/employees/${userId}/form16${financialYearId ? `?financialYearId=${financialYearId}` : ""}`);
export const getForm24Q = (financialYearId, quarter) =>
  api(`/api/compliance/form24q?financialYearId=${financialYearId}&quarter=${quarter}`);
export const getPfComplianceReport = (financialYearId, payrollMonth) =>
  api(`/api/compliance/pf-report?financialYearId=${financialYearId}&payrollMonth=${payrollMonth}`);
export const getEsiComplianceReport = (financialYearId, payrollMonth) =>
  api(`/api/compliance/esi-report?financialYearId=${financialYearId}&payrollMonth=${payrollMonth}`);
export const getPtComplianceReport = (financialYearId, payrollMonth) =>
  api(`/api/compliance/pt-report?financialYearId=${financialYearId}&payrollMonth=${payrollMonth}`);
export const getStatutoryWageRegister = (financialYearId, payrollMonth) =>
  api(`/api/compliance/wage-register?financialYearId=${financialYearId}&payrollMonth=${payrollMonth}`);

// ------------------------------------------------------------
// Full & Final Settlement — Block 6
// ------------------------------------------------------------
export const initiateSeparation = (payload) => api("/api/fnf/separations", { method: "POST", body: JSON.stringify(payload) });
export const getSeparations = (status) => api(`/api/fnf/separations${status ? `?status=${status}` : ""}`);
export const getSeparation = (id) => api(`/api/fnf/separations/${id}`);
export const decideSeparation = (id, decision) =>
  api(`/api/fnf/separations/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });

export const generateFnfSettlement = (separationId, overrides) =>
  api(`/api/fnf/separations/${separationId}/settlement`, { method: "POST", body: JSON.stringify(overrides || {}) });
export const getFnfSettlements = (status) => api(`/api/fnf/settlements${status ? `?status=${status}` : ""}`);
export const getFnfSettlement = (id) => api(`/api/fnf/settlements/${id}`);
export const getFnfSettlementStatement = (id) => api(`/api/fnf/settlements/${id}/statement`);
export const submitFnfSettlement = (id) => api(`/api/fnf/settlements/${id}/submit`, { method: "POST" });
export const decideFnfSettlement = (id, decision) =>
  api(`/api/fnf/settlements/${id}/decide`, { method: "POST", body: JSON.stringify({ decision }) });
export const markFnfSettlementPaid = (id) => api(`/api/fnf/settlements/${id}/mark-paid`, { method: "POST" });

// ------------------------------------------------------------
// Advanced Leave Management — Block 3
// ------------------------------------------------------------
export const getLeavePolicies = (leaveTypeId) => api(`/api/leave/policies?leaveTypeId=${leaveTypeId}`);
export const createLeavePolicy = (payload) => api("/api/leave/policies", { method: "POST", body: JSON.stringify(payload) });
export const updateLeavePolicy = (id, payload) => api(`/api/leave/policies/${id}`, { method: "PUT", body: JSON.stringify(payload) });
export const deleteLeavePolicy = (id) => api(`/api/leave/policies/${id}`, { method: "DELETE" });
export const getEffectiveLeavePolicy = (userId, leaveTypeId) => api(`/api/leave/effective-policy?userId=${userId}&leaveTypeId=${leaveTypeId}`);

export const applyForLeaveAdvanced = (payload) => api("/api/leave/applications-advanced", { method: "POST", body: JSON.stringify(payload) });
export const decideLeaveApplicationAdvanced = (id, decision, comment) =>
  api(`/api/leave/applications/${id}/decide-advanced`, { method: "POST", body: JSON.stringify({ decision, comment }) });
export const getLeaveApprovals = (id) => api(`/api/leave/applications/${id}/approvals`);

export const requestCompOff = (payload) => api("/api/leave/comp-offs", { method: "POST", body: JSON.stringify(payload) });
export const getMyCompOffs = () => api("/api/leave/comp-offs");
export const getAllCompOffs = (status) => api(`/api/leave/comp-offs/all${status ? `?status=${status}` : ""}`);
export const decideCompOff = (id, decision, expiryMonths) =>
  api(`/api/leave/comp-offs/${id}/decide`, { method: "POST", body: JSON.stringify({ decision, expiryMonths }) });
export const redeemCompOff = (id, date) => api(`/api/leave/comp-offs/${id}/redeem`, { method: "POST", body: JSON.stringify({ date }) });

export const runLeaveAccrual = (year, month) => api("/api/leave/accrual/run", { method: "POST", body: JSON.stringify({ year, month }) });
export const runCarryForwardExpiry = () => api("/api/leave/carry-forward-expiry/run", { method: "POST" });

export const getLeaveCalendar = (from, to, scope) => api(`/api/leave/calendar?from=${from}&to=${to}${scope ? `&scope=${scope}` : ""}`);
export const getLeaveConflicts = (from, to) => api(`/api/leave/conflicts?from=${from}&to=${to}`);

// ------------------------------------------------------------
// Advanced Employee Lifecycle — Block 1
// ------------------------------------------------------------
export const getLifecycleProfile = (userId) => api(`/api/lifecycle/employees/${userId}/profile`);
export const transferDepartment = (userId, payload) => api(`/api/lifecycle/employees/${userId}/transfer-department`, { method: "POST", body: JSON.stringify(payload) });
export const changeDesignation = (userId, payload) => api(`/api/lifecycle/employees/${userId}/change-designation`, { method: "POST", body: JSON.stringify(payload) });
export const changeManager = (userId, payload) => api(`/api/lifecycle/employees/${userId}/change-manager`, { method: "POST", body: JSON.stringify(payload) });
export const changeLocation = (userId, payload) => api(`/api/lifecycle/employees/${userId}/change-location`, { method: "POST", body: JSON.stringify(payload) });
export const promoteEmployee = (userId, payload) => api(`/api/lifecycle/employees/${userId}/promote`, { method: "POST", body: JSON.stringify(payload) });

export const startProbation = (userId, payload) => api(`/api/lifecycle/employees/${userId}/probation/start`, { method: "POST", body: JSON.stringify(payload) });
export const confirmProbation = (id, notes) => api(`/api/lifecycle/probation/${id}/confirm`, { method: "POST", body: JSON.stringify({ notes }) });
export const extendProbation = (id, newEndDate, notes) => api(`/api/lifecycle/probation/${id}/extend`, { method: "POST", body: JSON.stringify({ newEndDate, notes }) });

export const getEmployeeDocuments = (userId) => api(`/api/lifecycle/employees/${userId}/documents`);
export const uploadEmployeeDocument = (userId, payload) => api(`/api/lifecycle/employees/${userId}/documents`, { method: "POST", body: JSON.stringify(payload) });
export const getExpiringDocuments = (daysAhead) => api(`/api/lifecycle/documents/expiring${daysAhead ? `?daysAhead=${daysAhead}` : ""}`);

export const getChecklistTemplates = (type) => api(`/api/lifecycle/checklist/templates${type ? `?type=${type}` : ""}`);
export const createChecklistTemplate = (payload) => api("/api/lifecycle/checklist/templates", { method: "POST", body: JSON.stringify(payload) });
export const updateChecklistTemplate = (id, payload) => api(`/api/lifecycle/checklist/templates/${id}`, { method: "PUT", body: JSON.stringify(payload) });
export const getEmployeeChecklist = (userId, type) => api(`/api/lifecycle/employees/${userId}/checklist${type ? `?type=${type}` : ""}`);
export const completeChecklistTask = (id, notes) => api(`/api/lifecycle/checklist/tasks/${id}/complete`, { method: "POST", body: JSON.stringify({ notes }) });

export const recordExitInterview = (separationId, payload) => api(`/api/fnf/separations/${separationId}/exit-interview`, { method: "POST", body: JSON.stringify(payload) });
export const getExitInterview = (separationId) => api(`/api/fnf/separations/${separationId}/exit-interview`);
export const getSeparationChecklist = (separationId) => api(`/api/fnf/separations/${separationId}/checklist`);
