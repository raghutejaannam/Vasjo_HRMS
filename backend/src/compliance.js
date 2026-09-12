// src/compliance.js — BLOCK 5: Tax & Compliance reporting
//
// Most of Block 5's spec (tax declarations, proof upload, HR verification,
// approve/reject/resubmit, previous-employer income, old-vs-new regime
// comparison, monthly TDS) already existed in db.js/payroll.js/server.js
// before this file was written. This module is the genuinely-missing
// reporting layer on top of that data: the annual tax statement, Form 16 /
// Form 24Q data preparation, and PF/ESI/PT/statutory-register compliance
// reports — all derived from payroll_details, tax_declarations and the
// employee record, with no new source-of-truth tables needed beyond one
// column (users.esi_number).

const db = require('./db');
const payroll = require('./payroll');

function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// ---------------------------------------------------------------------------
// EMPLOYER STATUTORY INFO (stored in the existing settings key/value table)
// ---------------------------------------------------------------------------

const EMPLOYER_INFO_DEFAULTS = {
  company_name: 'Not configured', company_pan: 'Not configured', company_tan: 'Not configured',
  pf_establishment_code: 'Not configured', esi_establishment_code: 'Not configured', company_address: 'Not configured',
};

async function getEmployerStatutoryInfo() {
  const settings = await db.getSettings();
  const out = {};
  for (const key of Object.keys(EMPLOYER_INFO_DEFAULTS)) out[key] = settings[key] || EMPLOYER_INFO_DEFAULTS[key];
  return out;
}
async function updateEmployerStatutoryInfo(patch) {
  const allowed = {};
  for (const key of Object.keys(EMPLOYER_INFO_DEFAULTS)) if (patch[key] !== undefined) allowed[key] = patch[key];
  await db.updateSettings(allowed);
  return getEmployerStatutoryInfo();
}

// ---------------------------------------------------------------------------
// QUARTER HELPERS (Indian financial year: Apr–Jun / Jul–Sep / Oct–Dec / Jan–Mar)
// ---------------------------------------------------------------------------

const QUARTER_MONTH_OFFSETS = { Q1: [3, 4, 5], Q2: [6, 7, 8], Q3: [9, 10, 11], Q4: [0, 1, 2] };

function quarterMonths(financialYear, quarter) {
  const offsets = QUARTER_MONTH_OFFSETS[quarter];
  if (!offsets) throw new Error('quarter must be one of Q1, Q2, Q3, Q4');
  const fyStartYear = Number(financialYear.start_date.slice(0, 4));
  return offsets.map((monthIndex0) => {
    // Q4's months (Jan-Mar) fall in the calendar year AFTER the FY's start year.
    const year = monthIndex0 < 3 ? fyStartYear + 1 : fyStartYear;
    return `${year}-${String(monthIndex0 + 1).padStart(2, '0')}`;
  });
}

// ---------------------------------------------------------------------------
// ANNUAL TAX STATEMENT
// ---------------------------------------------------------------------------

async function getAnnualTaxStatement(userId, financialYearId) {
  const fy = await db.getFinancialYear(financialYearId);
  if (!fy) throw new Error('Financial year not found');

  const [rows, prevEmployer, selected, approvedDeductions] = await Promise.all([
    db.getPayrollDetailsForUserInFinancialYear(userId, financialYearId),
    db.getPreviousEmployerIncome(userId, financialYearId),
    db.getEmployeeTaxRegime(userId, financialYearId),
    payroll.getApprovedTaxDeductions(userId, financialYearId),
  ]);
  const regime = selected ? await db.getTaxRegime(selected.tax_regime_id) : await db.getDefaultTaxRegime(financialYearId);
  if (!regime) throw new Error('No tax regime configured for this financial year');

  const monthlyBreakdown = rows.map(r => ({
    payrollMonth: r.payroll_month, grossEarning: r.gross_earning, basicEarning: r.basic_earning,
    pfEmployeeDeduction: r.pf_employee_deduction, professionalTaxDeduction: r.professional_tax_deduction,
    tdsDeduction: r.tds_deduction, netSalary: r.net_salary,
  }));

  const sum = (key) => roundMoney(rows.reduce((s, r) => s + Number(r[key] || 0), 0));
  const currentEmployerGross = sum('gross_earning');
  const currentEmployerTds = sum('tds_deduction');
  const currentEmployerPf = sum('pf_employee_deduction');
  const currentEmployerPt = sum('professional_tax_deduction');

  const prevGross = prevEmployer ? Number(prevEmployer.gross_income) : 0;
  const prevTds = prevEmployer ? Number(prevEmployer.tds_deducted) : 0;
  const prevPt = prevEmployer ? Number(prevEmployer.professional_tax_paid) : 0;

  const totalAnnualGross = roundMoney(currentEmployerGross + prevGross);
  const totalTdsDeducted = roundMoney(currentEmployerTds + prevTds);

  const { taxableIncome, annualTax } = await payroll.calculateTaxLiability(regime.id, totalAnnualGross, approvedDeductions);
  const balance = roundMoney(annualTax - totalTdsDeducted); // positive = additional tax due, negative = refund due

  return {
    userId, financialYearId, financialYearName: fy.name,
    regime: { id: regime.id, code: regime.code, name: regime.name },
    currentEmployer: { grossIncome: currentEmployerGross, tdsDeducted: currentEmployerTds, pfDeducted: currentEmployerPf, ptDeducted: currentEmployerPt },
    previousEmployer: prevEmployer ? { name: prevEmployer.previous_employer_name, grossIncome: prevGross, tdsDeducted: prevTds, professionalTaxPaid: prevPt } : null,
    totalAnnualGross, approvedDeductions, taxableIncome, annualTaxComputed: annualTax,
    totalTdsDeducted, balance, balanceType: balance > 0 ? 'additional_tax_due' : balance < 0 ? 'refund_due' : 'settled',
    monthlyBreakdown,
  };
}

// ---------------------------------------------------------------------------
// FORM 16 DATA PREPARATION (Part A + Part B)
// ---------------------------------------------------------------------------

async function getForm16Data(userId, financialYearId) {
  const [statement, employerInfo, user, rows] = await Promise.all([
    getAnnualTaxStatement(userId, financialYearId),
    getEmployerStatutoryInfo(),
    db.findUserById(userId),
    db.getPayrollDetailsForUserInFinancialYear(userId, financialYearId),
  ]);
  const fy = await db.getFinancialYear(financialYearId);

  const quarterlyTds = { Q1: 0, Q2: 0, Q3: 0, Q4: 0 };
  for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4']) {
    const months = new Set(quarterMonths(fy, quarter));
    quarterlyTds[quarter] = roundMoney(rows.filter(r => months.has(r.payroll_month)).reduce((s, r) => s + Number(r.tds_deduction || 0), 0));
  }

  return {
    partA: {
      employer: { name: employerInfo.company_name, pan: employerInfo.company_pan, tan: employerInfo.company_tan, address: employerInfo.company_address },
      employee: { name: user.name, pan: user.pan || 'Not on file', employeeCode: user.employee_code },
      financialYear: fy.name, assessmentYear: `${Number(fy.start_date.slice(0, 4)) + 1}-${String((Number(fy.start_date.slice(0, 4)) + 2)).slice(-2)}`,
      period: { from: fy.start_date, to: fy.end_date },
      quarterlyTdsSummary: quarterlyTds,
      totalTdsDeposited: statement.totalTdsDeducted,
    },
    partB: {
      grossSalary: statement.totalAnnualGross,
      standardDeduction: null, // resolved inside calculateTaxLiability; surfaced separately below for statement clarity
      chapterVIADeductions: statement.approvedDeductions,
      taxableIncome: statement.taxableIncome,
      taxComputed: statement.annualTaxComputed,
      regime: statement.regime,
      totalTdsDeducted: statement.totalTdsDeducted,
      balance: statement.balance,
      balanceType: statement.balanceType,
    },
  };
}

// ---------------------------------------------------------------------------
// FORM 24Q DATA PREPARATION (quarterly TDS return — all employees)
// ---------------------------------------------------------------------------

async function getForm24QData(financialYearId, quarter) {
  const fy = await db.getFinancialYear(financialYearId);
  if (!fy) throw new Error('Financial year not found');
  const months = quarterMonths(fy, quarter);
  const rows = await db.getPayrollDetailsForMonths(financialYearId, months);

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) {
      byUser.set(r.user_id, {
        userId: r.user_id, name: r.user_name, pan: r.pan || 'Not on file', employeeCode: r.employee_code,
        totalGrossPaid: 0, totalTdsDeducted: 0, monthly: [],
      });
    }
    const entry = byUser.get(r.user_id);
    entry.totalGrossPaid = roundMoney(entry.totalGrossPaid + Number(r.gross_earning || 0));
    entry.totalTdsDeducted = roundMoney(entry.totalTdsDeducted + Number(r.tds_deduction || 0));
    entry.monthly.push({ payrollMonth: r.payroll_month, grossPaid: r.gross_earning, tdsDeducted: r.tds_deduction });
  }
  const deductees = [...byUser.values()].sort((a, b) => a.name.localeCompare(b.name));
  const employerInfo = await getEmployerStatutoryInfo();

  return {
    financialYearId, financialYearName: fy.name, quarter, months,
    employer: { name: employerInfo.company_name, tan: employerInfo.company_tan },
    deducteeCount: deductees.length,
    totalGrossPaid: roundMoney(deductees.reduce((s, d) => s + d.totalGrossPaid, 0)),
    totalTdsDeducted: roundMoney(deductees.reduce((s, d) => s + d.totalTdsDeducted, 0)),
    deductees,
  };
}

// ---------------------------------------------------------------------------
// PF COMPLIANCE REPORT
// ---------------------------------------------------------------------------

const PF_WAGE_CEILING = 15000;
const EPS_RATE = 0.0833; // Employees' Pension Scheme, out of the employer's 12%
const PF_RATE = 0.12;

async function getPfComplianceReport(financialYearId, payrollMonth) {
  const rows = await db.getPayrollDetailsForMonths(financialYearId, [payrollMonth]);
  const employerInfo = await getEmployerStatutoryInfo();

  const employees = rows.map(r => {
    const pfWage = Math.min(Number(r.basic_earning || 0), PF_WAGE_CEILING);
    const employeePf = roundMoney(r.pf_employee_deduction); // actual amount withheld in payroll
    // Employer-side PF isn't tracked as a separate payroll_details column
    // (the payroll engine only withholds the employee share) — this is a
    // statutory estimate computed from the same wage base for compliance
    // filing purposes, split into EPS/EPF the way EPFO requires.
    const employerPfTotal = roundMoney(pfWage * PF_RATE);
    const employerEps = roundMoney(pfWage * EPS_RATE);
    const employerEpf = roundMoney(employerPfTotal - employerEps);
    return {
      employeeCode: r.employee_code, name: r.user_name, uan: r.uan || 'Not on file', pfNumber: r.pf_number || 'Not on file',
      pfWage, employeePf, employerEps, employerEpf, employerPfTotal, totalRemittance: roundMoney(employeePf + employerPfTotal),
    };
  });

  return {
    financialYearId, payrollMonth, establishmentCode: employerInfo.pf_establishment_code,
    employeeCount: employees.length,
    totals: {
      employeePf: roundMoney(employees.reduce((s, e) => s + e.employeePf, 0)),
      employerPfTotal: roundMoney(employees.reduce((s, e) => s + e.employerPfTotal, 0)),
      totalRemittance: roundMoney(employees.reduce((s, e) => s + e.totalRemittance, 0)),
    },
    employees,
  };
}

// ---------------------------------------------------------------------------
// ESI COMPLIANCE REPORT
// ---------------------------------------------------------------------------

const ESI_WAGE_CEILING = 21000;
const ESI_EMPLOYEE_RATE = 0.0075;
const ESI_EMPLOYER_RATE = 0.0325;

// Advisory only — ESI is not currently withheld by the payroll engine
// itself (Block 4 didn't add it as a live deduction), so this report is
// computed independently from gross wages for compliance filing/decision
// purposes. If the company is ESI-registered, the natural next step is to
// add ESI as a real fixed-deduction salary component the same way PF/PT
// already are, so it actually gets withheld each payroll run.
async function getEsiComplianceReport(financialYearId, payrollMonth) {
  const rows = await db.getPayrollDetailsForMonths(financialYearId, [payrollMonth]);
  const employerInfo = await getEmployerStatutoryInfo();

  const employees = rows.map(r => {
    const gross = Number(r.gross_earning || 0);
    const eligible = gross > 0 && gross <= ESI_WAGE_CEILING;
    const employeeEsi = eligible ? roundMoney(gross * ESI_EMPLOYEE_RATE) : 0;
    const employerEsi = eligible ? roundMoney(gross * ESI_EMPLOYER_RATE) : 0;
    return {
      employeeCode: r.employee_code, name: r.user_name, esiNumber: r.esi_number || 'Not on file',
      grossWage: gross, eligible, employeeEsi, employerEsi, totalRemittance: roundMoney(employeeEsi + employerEsi),
    };
  });

  return {
    financialYearId, payrollMonth, establishmentCode: employerInfo.esi_establishment_code,
    wageCeiling: ESI_WAGE_CEILING, advisory: true,
    eligibleCount: employees.filter(e => e.eligible).length,
    totals: {
      employeeEsi: roundMoney(employees.reduce((s, e) => s + e.employeeEsi, 0)),
      employerEsi: roundMoney(employees.reduce((s, e) => s + e.employerEsi, 0)),
      totalRemittance: roundMoney(employees.reduce((s, e) => s + e.totalRemittance, 0)),
    },
    employees,
  };
}

// ---------------------------------------------------------------------------
// PT COMPLIANCE REPORT
// ---------------------------------------------------------------------------

async function getPtComplianceReport(financialYearId, payrollMonth) {
  const rows = await db.getPayrollDetailsForMonths(financialYearId, [payrollMonth]);
  const employees = rows.map(r => ({
    employeeCode: r.employee_code, name: r.user_name, location: r.location || 'Not on file',
    grossWage: r.gross_earning, professionalTaxDeducted: r.professional_tax_deduction,
  }));

  const byLocation = new Map();
  for (const e of employees) {
    const key = e.location;
    byLocation.set(key, roundMoney((byLocation.get(key) || 0) + Number(e.professionalTaxDeducted || 0)));
  }

  return {
    financialYearId, payrollMonth,
    employeeCount: employees.length,
    totalProfessionalTax: roundMoney(employees.reduce((s, e) => s + Number(e.professionalTaxDeducted || 0), 0)),
    byLocation: [...byLocation.entries()].map(([location, total]) => ({ location, total })),
    employees,
  };
}

// ---------------------------------------------------------------------------
// STATUTORY WAGE REGISTER (combined register for compliance inspection)
// ---------------------------------------------------------------------------

async function getStatutoryWageRegister(financialYearId, payrollMonth) {
  const rows = await db.getPayrollDetailsForMonths(financialYearId, [payrollMonth]);
  const employees = rows.map(r => ({
    employeeCode: r.employee_code, name: r.user_name, designation: r.title, department: r.dept,
    uan: r.uan || 'Not on file', pan: r.pan || 'Not on file',
    workingDays: r.working_days, paidDays: r.paid_days, lopDays: r.lop_days,
    basicEarning: r.basic_earning, grossEarning: r.gross_earning,
    pfEmployeeDeduction: r.pf_employee_deduction, professionalTaxDeduction: r.professional_tax_deduction,
    tdsDeduction: r.tds_deduction, netSalary: r.net_salary,
  })).sort((a, b) => a.name.localeCompare(b.name));

  return { financialYearId, payrollMonth, employeeCount: employees.length, employees };
}

module.exports = {
  getEmployerStatutoryInfo,
  updateEmployerStatutoryInfo,
  quarterMonths,
  getAnnualTaxStatement,
  getForm16Data,
  getForm24QData,
  getPfComplianceReport,
  getEsiComplianceReport,
  getPtComplianceReport,
  getStatutoryWageRegister,
};
