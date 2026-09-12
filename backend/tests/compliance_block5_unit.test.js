// tests/compliance_block5_unit.test.js
//
// Offline unit tests for Block 5 (Tax & Compliance): quarter-month mapping,
// annual tax statement reconciliation, Form 16/24Q data shaping, and the
// PF/ESI/PT/statutory wage register compliance reports.
//
// Run with:  node --test tests/compliance_block5_unit.test.js

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../src/db');
const payroll = require('../src/payroll');
const compliance = require('../src/compliance');

let patched = [];
function mockDb(name, fn) { patched.push([db, name, db[name]]); db[name] = fn; }
function mockPayroll(name, fn) { patched.push([payroll, name, payroll[name]]); payroll[name] = fn; }
afterEach(() => {
  for (const [obj, name, original] of patched) obj[name] = original;
  patched = [];
});

// ---------------------------------------------------------------------------
// Quarter mapping
// ---------------------------------------------------------------------------

test('quarterMonths maps Indian FY quarters correctly, including the year rollover for Q4', () => {
  const fy = { start_date: '2026-04-01' };
  assert.deepEqual(compliance.quarterMonths(fy, 'Q1'), ['2026-04', '2026-05', '2026-06']);
  assert.deepEqual(compliance.quarterMonths(fy, 'Q2'), ['2026-07', '2026-08', '2026-09']);
  assert.deepEqual(compliance.quarterMonths(fy, 'Q3'), ['2026-10', '2026-11', '2026-12']);
  assert.deepEqual(compliance.quarterMonths(fy, 'Q4'), ['2027-01', '2027-02', '2027-03']);
});

test('quarterMonths rejects an invalid quarter', () => {
  assert.throws(() => compliance.quarterMonths({ start_date: '2026-04-01' }, 'Q5'), /quarter must be one of/);
});

// ---------------------------------------------------------------------------
// Employer statutory info
// ---------------------------------------------------------------------------

test('getEmployerStatutoryInfo falls back to defaults for unset settings', async () => {
  mockDb('getSettings', async () => ({ company_name: 'Acme Corp' }));
  const info = await compliance.getEmployerStatutoryInfo();
  assert.equal(info.company_name, 'Acme Corp');
  assert.equal(info.company_pan, 'Not configured');
});

// ---------------------------------------------------------------------------
// Annual tax statement
// ---------------------------------------------------------------------------

test('getAnnualTaxStatement reconciles computed tax against actual TDS deducted (current + previous employer)', async () => {
  mockDb('getFinancialYear', async () => ({ id: 1, name: 'FY 2026-27', start_date: '2026-04-01', end_date: '2027-03-31' }));
  mockDb('getPayrollDetailsForUserInFinancialYear', async () => ([
    { payroll_month: '2026-04', gross_earning: 100000, basic_earning: 40000, pf_employee_deduction: 4800, professional_tax_deduction: 200, tds_deduction: 8000, net_salary: 87000 },
    { payroll_month: '2026-05', gross_earning: 100000, basic_earning: 40000, pf_employee_deduction: 4800, professional_tax_deduction: 200, tds_deduction: 8000, net_salary: 87000 },
  ]));
  mockDb('getPreviousEmployerIncome', async () => ({ previous_employer_name: 'OldCo', gross_income: 200000, tds_deducted: 15000, professional_tax_paid: 400 }));
  mockDb('getEmployeeTaxRegime', async () => null);
  mockDb('getDefaultTaxRegime', async () => ({ id: 5, code: 'new', name: 'New Tax Regime' }));
  mockPayroll('getApprovedTaxDeductions', async () => 0);
  mockPayroll('calculateTaxLiability', async (regimeId, gross) => ({ taxableIncome: gross - 75000, annualTax: 40000 }));

  const statement = await compliance.getAnnualTaxStatement(1, 1);
  assert.equal(statement.totalAnnualGross, 400000); // 200000 current + 200000 previous
  assert.equal(statement.totalTdsDeducted, 31000); // 16000 current + 15000 previous
  assert.equal(statement.annualTaxComputed, 40000);
  assert.equal(statement.balance, 9000); // 40000 - 31000
  assert.equal(statement.balanceType, 'additional_tax_due');
});

test('getAnnualTaxStatement reports refund_due when TDS deducted exceeds computed liability', async () => {
  mockDb('getFinancialYear', async () => ({ id: 1, name: 'FY 2026-27', start_date: '2026-04-01', end_date: '2027-03-31' }));
  mockDb('getPayrollDetailsForUserInFinancialYear', async () => ([
    { payroll_month: '2026-04', gross_earning: 100000, tds_deduction: 30000, pf_employee_deduction: 0, professional_tax_deduction: 0, basic_earning: 0, net_salary: 0 },
  ]));
  mockDb('getPreviousEmployerIncome', async () => null);
  mockDb('getEmployeeTaxRegime', async () => ({ tax_regime_id: 5 }));
  mockDb('getTaxRegime', async () => ({ id: 5, code: 'old', name: 'Old Tax Regime' }));
  mockPayroll('getApprovedTaxDeductions', async () => 0);
  mockPayroll('calculateTaxLiability', async () => ({ taxableIncome: 20000, annualTax: 20000 }));

  const statement = await compliance.getAnnualTaxStatement(1, 1);
  assert.equal(statement.balance, -10000);
  assert.equal(statement.balanceType, 'refund_due');
});

// ---------------------------------------------------------------------------
// Form 24Q
// ---------------------------------------------------------------------------

test('getForm24QData aggregates gross paid and TDS per employee across the quarter', async () => {
  mockDb('getFinancialYear', async () => ({ id: 1, start_date: '2026-04-01' }));
  mockDb('getPayrollDetailsForMonths', async () => ([
    { user_id: 1, user_name: 'Asha', pan: 'ABCDE1234F', employee_code: 'E1', payroll_month: '2026-04', gross_earning: 100000, tds_deduction: 8000 },
    { user_id: 1, user_name: 'Asha', pan: 'ABCDE1234F', employee_code: 'E1', payroll_month: '2026-05', gross_earning: 100000, tds_deduction: 8000 },
    { user_id: 2, user_name: 'Ravi', pan: 'FGHIJ5678K', employee_code: 'E2', payroll_month: '2026-04', gross_earning: 80000, tds_deduction: 3000 },
  ]));
  mockDb('getSettings', async () => ({}));

  const data = await compliance.getForm24QData(1, 'Q1');
  assert.equal(data.deducteeCount, 2);
  const asha = data.deductees.find(d => d.userId === 1);
  assert.equal(asha.totalGrossPaid, 200000);
  assert.equal(asha.totalTdsDeducted, 16000);
  assert.equal(data.totalTdsDeducted, 19000);
});

// ---------------------------------------------------------------------------
// PF compliance report
// ---------------------------------------------------------------------------

test('getPfComplianceReport caps PF wage at the statutory ceiling and splits employer contribution into EPS/EPF', async () => {
  mockDb('getPayrollDetailsForMonths', async () => ([
    { employee_code: 'E1', user_name: 'Asha', uan: '1234', pf_number: 'PF1', basic_earning: 40000, pf_employee_deduction: 1800 },
  ]));
  mockDb('getSettings', async () => ({}));

  const report = await compliance.getPfComplianceReport(1, '2026-04');
  const emp = report.employees[0];
  assert.equal(emp.pfWage, 15000); // capped, even though basic is 40000
  assert.equal(emp.employerPfTotal, 1800); // 15000 * 0.12
  assert.equal(emp.employerEps, Math.round(15000 * 0.0833 * 100) / 100);
  assert.equal(Math.round((emp.employerEps + emp.employerEpf) * 100) / 100, emp.employerPfTotal);
});

// ---------------------------------------------------------------------------
// ESI compliance report
// ---------------------------------------------------------------------------

test('getEsiComplianceReport only computes contributions for employees under the wage ceiling', async () => {
  mockDb('getPayrollDetailsForMonths', async () => ([
    { employee_code: 'E1', user_name: 'Asha', esi_number: null, gross_earning: 18000 },
    { employee_code: 'E2', user_name: 'Ravi', esi_number: 'ESI2', gross_earning: 45000 },
  ]));
  mockDb('getSettings', async () => ({}));

  const report = await compliance.getEsiComplianceReport(1, '2026-04');
  const asha = report.employees.find(e => e.employeeCode === 'E1');
  const ravi = report.employees.find(e => e.employeeCode === 'E2');
  assert.equal(asha.eligible, true);
  assert.equal(asha.employeeEsi, Math.round(18000 * 0.0075 * 100) / 100);
  assert.equal(ravi.eligible, false);
  assert.equal(ravi.employeeEsi, 0);
  assert.equal(report.advisory, true);
});

// ---------------------------------------------------------------------------
// Statutory wage register
// ---------------------------------------------------------------------------

test('getStatutoryWageRegister returns one sorted row per employee with the compliance-relevant fields', async () => {
  mockDb('getPayrollDetailsForMonths', async () => ([
    { employee_code: 'E2', user_name: 'Ravi', title: 'Engineer', dept: 'Eng', uan: null, pan: 'X', working_days: 22, paid_days: 22, lop_days: 0, basic_earning: 30000, gross_earning: 60000, pf_employee_deduction: 1800, professional_tax_deduction: 200, tds_deduction: 1000, net_salary: 57000 },
    { employee_code: 'E1', user_name: 'Asha', title: 'Manager', dept: 'Eng', uan: '1', pan: 'Y', working_days: 22, paid_days: 21, lop_days: 1, basic_earning: 50000, gross_earning: 100000, pf_employee_deduction: 1800, professional_tax_deduction: 200, tds_deduction: 8000, net_salary: 90000 },
  ]));
  const register = await compliance.getStatutoryWageRegister(1, '2026-04');
  assert.equal(register.employeeCount, 2);
  assert.equal(register.employees[0].name, 'Asha'); // sorted alphabetically
  assert.equal(register.employees[1].name, 'Ravi');
});
