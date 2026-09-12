// src/payroll.js — payroll & tax calculation engine.
//
// Everything here is calculation/orchestration: CTC breakdown, income-tax
// slab calculation for both regimes, monthly TDS projection, the full
// monthly payroll run, salary revisions/hikes, and payslip data preparation.
// Pure data access (CRUD) lives in db.js; this module calls into db.js for
// reads/writes and focuses on the arithmetic and business rules.
//
// Ported from the payroll section of the original src/db.js. Formulas are
// unchanged; only the data-access calls were adapted to the new async/Prisma
// data layer.

const db = require('./db');
const attendance = require('./attendance');
const { nowStr, todayStr, evaluateArithmeticFormula, evaluateConditionalRule, computeEmi, yearsOfService } = require('./utils');

// ---------------------------------------------------------------------------
// SMALL MATH/DATE HELPERS
// ---------------------------------------------------------------------------

function roundMoney(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function dateOnly(d) {
  return d.toISOString().slice(0, 10);
}

function maxDate(a, b) {
  return a > b ? a : b;
}
function minDate(a, b) {
  return a < b ? a : b;
}

function daysInMonthUTC(year, month /* 1-12 */) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parsePayrollMonth(payrollMonth) {
  // 'YYYY-MM'
  const [y, m] = payrollMonth.split('-').map(Number);
  return { year: y, month: m };
}

// ---------------------------------------------------------------------------
// STATUTORY TAX RULE DEFAULTS — used to backfill tax_rules/tax_slabs for a
// financial year the first time it's needed, so payroll never breaks just
// because the tax master data wasn't hand-entered for a new FY yet.
// (India FY24-25 / AY25-26 defaults; admins can override via the tax
// configuration screens which write straight to tax_rules/tax_slabs.)
// ---------------------------------------------------------------------------

const OLD_REGIME_SLABS = [
  { minIncome: 0, maxIncome: 250000, rate: 0 },
  { minIncome: 250000, maxIncome: 500000, rate: 5 },
  { minIncome: 500000, maxIncome: 1000000, rate: 20 },
  { minIncome: 1000000, maxIncome: null, rate: 30 },
];
const NEW_REGIME_SLABS = [
  { minIncome: 0, maxIncome: 300000, rate: 0 },
  { minIncome: 300000, maxIncome: 600000, rate: 5 },
  { minIncome: 600000, maxIncome: 900000, rate: 10 },
  { minIncome: 900000, maxIncome: 1200000, rate: 15 },
  { minIncome: 1200000, maxIncome: 1500000, rate: 20 },
  { minIncome: 1500000, maxIncome: null, rate: 30 },
];
const OLD_REGIME_RULES = {
  standard_deduction: { value: 50000, type: 'amount', description: 'Standard deduction' },
  rebate_87a_limit: { value: 500000, type: 'amount', description: 'Sec 87A rebate eligibility limit (taxable income)' },
  rebate_87a_amount: { value: 12500, type: 'amount', description: 'Sec 87A max rebate amount' },
  cess_rate: { value: 4, type: 'percentage', description: 'Health & education cess' },
};
const NEW_REGIME_RULES = {
  standard_deduction: { value: 75000, type: 'amount', description: 'Standard deduction' },
  rebate_87a_limit: { value: 700000, type: 'amount', description: 'Sec 87A rebate eligibility limit (taxable income)' },
  rebate_87a_amount: { value: 25000, type: 'amount', description: 'Sec 87A max rebate amount' },
  cess_rate: { value: 4, type: 'percentage', description: 'Health & education cess' },
};

async function ensureStatutoryTaxRules(financialYearId) {
  let regimes = await db.listTaxRegimes(financialYearId);
  if (!regimes.length) {
    const oldInfo = await db.insertTaxRegime(financialYearId, 'old', 'Old Tax Regime', false);
    const newInfo = await db.insertTaxRegime(financialYearId, 'new', 'New Tax Regime', true);
    regimes = [
      { id: oldInfo.lastInsertRowid, code: 'old' },
      { id: newInfo.lastInsertRowid, code: 'new' },
    ];
  }
  for (const regime of regimes) {
    const slabs = await db.listTaxSlabs(regime.id);
    if (!slabs.length) {
      const slabDefs = regime.code === 'new' ? NEW_REGIME_SLABS : OLD_REGIME_SLABS;
      let order = 0;
      for (const s of slabDefs) await db.insertTaxSlab(regime.id, s.minIncome, s.maxIncome, s.rate, order++);
    }
    const rules = await db.listTaxRules(regime.id);
    if (!rules.length) {
      const ruleDefs = regime.code === 'new' ? NEW_REGIME_RULES : OLD_REGIME_RULES;
      for (const [key, r] of Object.entries(ruleDefs)) await db.upsertTaxRule(regime.id, key, r.value, r.type, r.description);
    }
  }
  const limits = await db.listDeductionLimits(financialYearId);
  if (!limits.length) {
    await db.upsertDeductionLimit(financialYearId, '80C', 'Section 80C', 150000);
    await db.upsertDeductionLimit(financialYearId, '80D', 'Section 80D (Medical Insurance)', 25000);
    await db.upsertDeductionLimit(financialYearId, '80CCD1B', 'Section 80CCD(1B) NPS', 50000);
  }
  return regimes;
}

// ---------------------------------------------------------------------------
// INCOME TAX CALCULATION FOR A GIVEN REGIME
// ---------------------------------------------------------------------------

// annualTaxableIncome: gross annual income minus standard deduction and (for
// the old regime) approved Chapter VI-A deductions — the caller is
// responsible for arriving at this figure; this function only applies slabs,
// cess and the Section 87A rebate.
async function calculateTaxForRegime(taxRegimeId, annualTaxableIncome) {
  const slabs = await db.listTaxSlabs(taxRegimeId);
  const rules = await db.listTaxRules(taxRegimeId);
  const ruleMap = {};
  rules.forEach(r => { ruleMap[r.rule_key] = r.rule_value; });

  const income = Math.max(0, annualTaxableIncome);
  let tax = 0;
  for (const slab of slabs) {
    const min = slab.min_income;
    const max = slab.max_income === null || slab.max_income === undefined ? Infinity : slab.max_income;
    if (income <= min) continue;
    const slabAmount = Math.min(income, max) - min;
    if (slabAmount > 0) tax += slabAmount * (slab.rate / 100);
  }

  const rebateLimit = ruleMap.rebate_87a_limit;
  const rebateAmount = ruleMap.rebate_87a_amount;
  if (rebateLimit !== undefined && income <= rebateLimit) {
    tax = Math.max(0, tax - (rebateAmount || tax));
  }

  const cessRate = ruleMap.cess_rate !== undefined ? ruleMap.cess_rate : 4;
  const cess = tax * (cessRate / 100);
  return roundMoney(tax + cess);
}

// Full annual tax liability for an employee under a given regime, given
// their annualized gross salary income and (old regime only) approved
// deductions declared for the FY.
async function calculateTaxLiability(taxRegimeId, annualGrossIncome, approvedDeductions) {
  const rules = await db.listTaxRules(taxRegimeId);
  const ruleMap = {};
  rules.forEach(r => { ruleMap[r.rule_key] = r.rule_value; });
  const standardDeduction = ruleMap.standard_deduction || 0;

  const regime = await db.getTaxRegime(taxRegimeId);
  const isOldRegime = regime && regime.code === 'old';

  let taxableIncome = annualGrossIncome - standardDeduction;
  if (isOldRegime) taxableIncome -= (approvedDeductions || 0);
  taxableIncome = Math.max(0, roundMoney(taxableIncome));

  const annualTax = await calculateTaxForRegime(taxRegimeId, taxableIncome);
  return { taxableIncome, annualTax };
}

// ---------------------------------------------------------------------------
// PROJECTIONS USED TO SPREAD THE ANNUAL TAX LIABILITY ACROSS REMAINING MONTHS
// ---------------------------------------------------------------------------

function getRemainingPayrollMonths(financialYear, payrollMonth) {
  const fyStart = new Date(financialYear.start_date + 'T00:00:00');
  const fyEnd = new Date(financialYear.end_date + 'T00:00:00');
  const { year, month } = parsePayrollMonth(payrollMonth);
  const current = new Date(Date.UTC(year, month - 1, 1));
  let count = 0;
  const cursor = new Date(Date.UTC(fyStart.getUTCFullYear(), fyStart.getUTCMonth(), 1));
  while (cursor <= fyEnd) {
    if (cursor >= current) count++;
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return Math.max(1, count);
}

async function getPriorPayrollTDS(userId, financialYearId, beforePayrollMonth) {
  const row = await db.dbGet(`
    SELECT COALESCE(SUM(pd.tds_deduction), 0) AS total
    FROM payroll_details pd
    JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    WHERE pd.user_id = ? AND pr.financial_year_id = ? AND pr.payroll_month < ?
      AND pr.status IN ('approved', 'locked', 'disbursed')
  `, [userId, financialYearId, beforePayrollMonth]);
  return Number(row.total);
}

// Projects the employee's full-FY gross salary income for tax purposes: what
// they've already earned (approved payroll months before this one) plus the
// remaining months at their current monthly CTC-derived gross rate.
async function getProjectedFYSalaryIncomeForPreview(userId, financialYear, payrollMonth, currentMonthGross) {
  const priorGross = await db.dbGet(`
    SELECT COALESCE(SUM(pd.gross_earning), 0) AS total
    FROM payroll_details pd
    JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    WHERE pd.user_id = ? AND pr.financial_year_id = ? AND pr.payroll_month < ?
      AND pr.status IN ('approved', 'locked', 'disbursed')
  `, [userId, financialYear.id, payrollMonth]);

  const remainingMonths = getRemainingPayrollMonths(financialYear, payrollMonth);
  const projectedRemaining = currentMonthGross * remainingMonths;

  const prevEmployer = await db.getPreviousEmployerIncome(userId, financialYear.id);
  const prevGross = prevEmployer ? prevEmployer.gross_income : 0;
  const prevTds = prevEmployer ? prevEmployer.tds_deducted : 0;

  return {
    projectedAnnualGross: roundMoney(Number(priorGross.total) + projectedRemaining + prevGross),
    previousEmployerTds: prevTds,
  };
}

async function getApprovedTaxDeductions(userId, financialYearId) {
  return db.getApprovedDeclarationsTotal(userId, financialYearId);
}

// Rough annualized gross salary income for an employee, used for the tax
// regime comparison/summary screens (self-service, informational only — the
// authoritative per-month figure used to actually withhold TDS is computed
// in getMonthlyTDS/calculateMonthlyPayroll from real payroll data).
async function getEmployeeAnnualGrossEstimate(userId, financialYearId) {
  const structure = await db.getActiveSalaryStructure(userId, financialYearId);
  if (!structure) return 0;
  const components = await db.getStructureComponents(structure.id);
  const annualEarnings = components
    .filter((c) => c.type === 'earning')
    .reduce((sum, c) => sum + Number(c.amount || 0), 0) * 12;
  return roundMoney(annualEarnings || Number(structure.annual_ctc || 0));
}

// Tax liability under every active regime for the FY, for the employee's
// self-service "compare regimes" screen.
async function compareTaxRegimesForEmployee(userId, financialYearId) {
  const [regimes, annualGrossIncome, approvedDeductions] = await Promise.all([
    db.listTaxRegimes(financialYearId),
    getEmployeeAnnualGrossEstimate(userId, financialYearId),
    getApprovedTaxDeductions(userId, financialYearId),
  ]);
  const comparison = [];
  for (const regime of regimes) {
    const { taxableIncome, annualTax } = await calculateTaxLiability(regime.id, annualGrossIncome, approvedDeductions);
    comparison.push({
      taxRegimeId: regime.id, name: regime.name, code: regime.code,
      annualGrossIncome, taxableIncome, annualTax,
    });
  }
  return comparison;
}

// Tax liability under the employee's currently-selected regime for the FY
// (falls back to the FY's default regime if none has been selected yet).
async function getEmployeeTaxSummary(userId, financialYearId) {
  const selected = await db.getEmployeeTaxRegime(userId, financialYearId);
  const regime = selected
    ? await db.getTaxRegime(selected.tax_regime_id)
    : await db.getDefaultTaxRegime(financialYearId);
  if (!regime) return { taxLiability: null, regime: null };
  const [annualGrossIncome, approvedDeductions] = await Promise.all([
    getEmployeeAnnualGrossEstimate(userId, financialYearId),
    getApprovedTaxDeductions(userId, financialYearId),
  ]);
  const { taxableIncome, annualTax } = await calculateTaxLiability(regime.id, annualGrossIncome, approvedDeductions);
  return { taxLiability: annualTax, taxableIncome, annualGrossIncome, regime };
}

// ---------------------------------------------------------------------------
// MONTHLY TDS
// ---------------------------------------------------------------------------

async function getMonthlyTDS(userId, financialYear, payrollMonth, currentMonthGross, taxRegimeId) {
  const { projectedAnnualGross, previousEmployerTds } = await getProjectedFYSalaryIncomeForPreview(userId, financialYear, payrollMonth, currentMonthGross);
  const approvedDeductions = await getApprovedTaxDeductions(userId, financialYear.id);
  const { taxableIncome, annualTax } = await calculateTaxLiability(taxRegimeId, projectedAnnualGross, approvedDeductions);

  const priorTds = await getPriorPayrollTDS(userId, financialYear.id, payrollMonth);
  const alreadyDeducted = roundMoney(priorTds + previousEmployerTds);
  const remainingLiability = Math.max(0, roundMoney(annualTax - alreadyDeducted));
  const remainingMonths = getRemainingPayrollMonths(financialYear, payrollMonth);
  const monthlyTds = roundMoney(remainingLiability / remainingMonths);

  return {
    taxableIncome,
    annualTaxableIncome: taxableIncome,
    annualTax,
    tdsAlreadyDeducted: alreadyDeducted,
    remainingTaxLiability: remainingLiability,
    monthlyTds,
  };
}

// ---------------------------------------------------------------------------
// SALARY STRUCTURE — CTC BREAKDOWN
// ---------------------------------------------------------------------------

// Splits an annual CTC into the standard component set (Basic, HRA,
// Allowances, PF employer contribution, etc.) using each active component's
// calculation_type/calculation_value from salary_components, unless the
// caller supplies explicit per-component overrides.
async function populateDefaultStructureComponents(structureId, annualCtc, basicSalary, overrides = {}, client) {
  const components = await db.listSalaryComponents(true);
  const monthlyCtc = annualCtc / 12;
  const monthlyBasic = basicSalary / 12;

  for (const c of components) {
    if (overrides[c.code] !== undefined) {
      await db.insertStructureComponent(structureId, c.id, roundMoney(overrides[c.code]), true, client);
      continue;
    }
    let amount = 0;
    const formulaVars = { monthlyBasic, monthlyCtc, basic: monthlyBasic, ctc: monthlyCtc, annualCtc, basicSalary };
    if (c.code === 'BASIC') {
      amount = monthlyBasic;
    } else if (c.calculation_type === 'percentage_of_basic' && c.calculation_value != null) {
      amount = monthlyBasic * (c.calculation_value / 100);
    } else if (c.calculation_type === 'percentage_of_ctc' && c.calculation_value != null) {
      amount = monthlyCtc * (c.calculation_value / 100);
    } else if (c.calculation_type === 'fixed_amount' && c.calculation_value != null) {
      amount = c.calculation_value;
    } else if (c.calculation_type === 'formula' && c.formula) {
      try {
        amount = evaluateArithmeticFormula(c.formula, formulaVars);
      } catch (e) {
        throw new Error(`Salary component "${c.code}" has an invalid formula: ${e.message}`);
      }
    } else if (c.calculation_type === 'conditional' && c.conditional_rule) {
      try {
        amount = evaluateConditionalRule(c.conditional_rule, formulaVars);
      } catch (e) {
        throw new Error(`Salary component "${c.code}" has an invalid conditional rule: ${e.message}`);
      }
    } else if (c.type === 'earning' && c.code === 'HRA') {
      amount = monthlyBasic * 0.4; // fallback: 40% of basic, non-metro default
    } else {
      continue; // no rule and no override -> component simply isn't part of this structure
    }
    await db.insertStructureComponent(structureId, c.id, roundMoney(amount), false, client);
  }
}

// Creates a new salary structure in 'draft' status. It intentionally does
// NOT touch any existing active structure — the employee's current active
// structure keeps driving payroll until an admin explicitly activates this
// draft via activateSalaryStructure(), which is the point superseding
// happens. This matches the UI's draft -> review/edit components -> activate
// workflow (a structure is editable via saveSalaryStructureComponents while
// still in draft).
async function createSalaryStructure({ userId, financialYearId, effectiveFrom, annualCtc, basicSalary, createdBy, componentOverrides }) {
  annualCtc = roundMoney(annualCtc);
  basicSalary = roundMoney(basicSalary != null ? basicSalary : annualCtc * 0.4);
  const monthlyCtc = roundMoney(annualCtc / 12);

  return db.withTx(async (tx) => {
    const info = await db.insertSalaryStructureRow({
      userId, financialYearId, effectiveFrom, annualCtc, monthlyCtc, basicSalary, status: 'draft', createdBy,
    }, tx);
    await populateDefaultStructureComponents(info.lastInsertRowid, annualCtc, basicSalary, componentOverrides || {}, tx);
    await db.logPayrollAudit('salary_structure', info.lastInsertRowid, 'created', createdBy, null, { annualCtc, basicSalary, effectiveFrom }, tx);
    return info.lastInsertRowid;
  });
}

// Activates a draft salary structure: supersedes any other currently-active
// structure for the same employee/FY, then flips this one to 'active'.
async function activateSalaryStructureFull(structureId, actorId) {
  return db.withTx(async (tx) => {
    const structure = await db.getSalaryStructureById(structureId);
    if (!structure) throw new Error('Salary structure not found');
    await db.supersedeActiveStructures(structure.user_id, structure.financial_year_id, structure.effective_from, tx);
    await db.activateSalaryStructure(structureId, tx);
    await db.logPayrollAudit('salary_structure', structureId, 'activated', actorId, null, null, tx);
  });
}

async function setSalaryStructureComponents(structureId, componentAmounts, actorId) {
  return db.withTx(async (tx) => {
    const structure = await db.getSalaryStructureById(structureId);
    if (!structure) throw new Error('Salary structure not found');
    for (const [componentId, amount] of Object.entries(componentAmounts)) {
      await db.insertStructureComponent(structureId, Number(componentId), roundMoney(amount), true, tx);
    }
    const components = await db.getStructureComponents(structureId, tx);
    const monthlyCtc = components.reduce((sum, c) => sum + (c.type === 'earning' ? c.amount : 0), 0);
    await db.logPayrollAudit('salary_structure', structureId, 'components_updated', actorId, null, componentAmounts, tx);
    return monthlyCtc;
  });
}

// A salary hike/revision: closes out the old structure, opens a new one, and
// records the delta for reporting (salary_revisions). newAnnualCtc can be
// given directly, or derived from the employee's current active CTC plus a
// hikePercentage or hikeAmount (the admin UI lets the caller use whichever
// of the three is most convenient, and only ever sends one of them).
async function giveSalaryHike({ userId, financialYearId, newAnnualCtc, newBasicSalary, hikePercentage, hikeAmount, effectiveDate, revisionType, reason, notes, approvedBy, componentOverrides, isRetroactive }) {
  return db.withTx(async (tx) => {
    const previous = await db.getActiveSalaryStructure(userId, financialYearId);
    if (newAnnualCtc == null) {
      if (!previous) throw new Error('No active salary structure found for this employee — enter the new annual CTC directly');
      if (hikePercentage != null) newAnnualCtc = Number(previous.annual_ctc) * (1 + Number(hikePercentage) / 100);
      else if (hikeAmount != null) newAnnualCtc = Number(previous.annual_ctc) + Number(hikeAmount);
      else throw new Error('Provide a hike percentage, hike amount, or new annual CTC');
    }
    newAnnualCtc = roundMoney(newAnnualCtc);
    newBasicSalary = roundMoney(newBasicSalary != null ? newBasicSalary : newAnnualCtc * 0.4);
    const newMonthlyCtc = roundMoney(newAnnualCtc / 12);

    await db.supersedeActiveStructures(userId, financialYearId, effectiveDate, tx);
    const info = await db.insertSalaryStructureRow({
      userId, financialYearId, effectiveFrom: effectiveDate, annualCtc: newAnnualCtc, monthlyCtc: newMonthlyCtc, basicSalary: newBasicSalary,
      status: 'active', createdBy: approvedBy,
    }, tx);
    await populateDefaultStructureComponents(info.lastInsertRowid, newAnnualCtc, newBasicSalary, componentOverrides || {}, tx);

    const computedHikeAmount = previous ? roundMoney(newAnnualCtc - previous.annual_ctc) : null;
    const computedHikePercentage = previous && previous.annual_ctc ? roundMoney((computedHikeAmount / previous.annual_ctc) * 100) : null;

    const revisionId = await db.insertSalaryRevision({
      userId,
      salaryStructureId: info.lastInsertRowid,
      previousAnnualCtc: previous ? previous.annual_ctc : null,
      newAnnualCtc,
      previousMonthlyCtc: previous ? previous.monthly_ctc : null,
      newMonthlyCtc,
      previousBasicSalary: previous ? previous.basic_salary : null,
      newBasicSalary,
      hikePercentage: computedHikePercentage,
      hikeAmount: computedHikeAmount,
      effectiveDate,
      revisionType: revisionType || 'annual_appraisal',
      reason,
      notes,
      isRetroactive: !!isRetroactive,
      approvedBy,
    }, tx);

    let arrearsGenerated = [];
    if (isRetroactive && previous) {
      arrearsGenerated = await generateArrearsForRetroactiveRevision({
        userId, financialYearId, effectiveDate,
        previousMonthlyCtc: Number(previous.monthly_ctc), newMonthlyCtc,
        revisionId: revisionId.lastInsertRowid, tx,
      });
    }

    await db.logPayrollAudit('salary_structure', info.lastInsertRowid, 'salary_hike', approvedBy,
      previous ? { annualCtc: previous.annual_ctc } : null, { annualCtc: newAnnualCtc, hikeAmount: computedHikeAmount, hikePercentage: computedHikePercentage }, tx);

    return { id: info.lastInsertRowid, newCtc: newAnnualCtc, hikePercentage: computedHikePercentage, hikeAmount: computedHikeAmount, arrearsGenerated };
  });
}

async function updateEmployeeCompensation(userId, financialYearId, patch, actorId) {
  const structure = await db.getActiveSalaryStructure(userId, financialYearId);
  if (!structure) throw new Error('No active salary structure found for this employee/financial year');
  return giveSalaryHike({
    userId,
    financialYearId,
    newAnnualCtc: patch.annualCtc != null ? patch.annualCtc : structure.annual_ctc,
    newBasicSalary: patch.basicSalary,
    effectiveDate: patch.effectiveDate || nowStr().slice(0, 10),
    revisionType: patch.revisionType || 'mid_year_correction',
    reason: patch.reason,
    notes: patch.notes,
    approvedBy: actorId,
    componentOverrides: patch.componentOverrides,
  });
}

// ---------------------------------------------------------------------------
// ATTENDANCE-BASED PRORATION (LOP) FOR A PAYROLL MONTH
// ---------------------------------------------------------------------------

async function getAttendanceForPayroll(userId, year, month) {
  // Prefer real attendance data (Block 2) when this employee has any
  // recorded attendance for the month — it gives an accurate LOP figure
  // driven by actual check-in/check-out and manual marking history.
  const fromAttendance = await attendance.computeAttendanceSummaryForPayroll(userId, year, month);
  if (fromAttendance) return fromAttendance;

  // No attendance records for this employee/month yet (attendance module
  // not adopted for them) — fall back to the original design: working days
  // are derived from weekends + company holidays, and LOP is intentionally
  // NOT auto-derived from timesheets or leave gaps (timesheets track
  // project hours, not attendance). It defaults to 0 unless the payroll
  // admin records it via a variable deduction, or the employee is later
  // switched onto the attendance module above.
  const totalDays = daysInMonthUTC(year, month);
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`;
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(totalDays).padStart(2, '0')}`;

  const holidays = await db.getHolidaysInRange(monthStart, monthEnd);
  const holidaySet = new Set(holidays.map(h => h.holiday_date));

  let workingDays = 0;
  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const day = new Date(dateStr + 'T00:00:00').getUTCDay();
    if (day === 0 || day === 6) continue;
    if (holidaySet.has(dateStr)) continue;
    workingDays++;
  }

  return { workingDays, paidDays: workingDays, lopDays: 0 };
}

// ---------------------------------------------------------------------------
// FULL MONTHLY PAYROLL CALCULATION FOR ONE EMPLOYEE
// ---------------------------------------------------------------------------

async function calculateMonthlyPayroll(userId, financialYear, payrollMonth, client) {
  const { year, month } = parsePayrollMonth(payrollMonth);
  const monthEndStr = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonthUTC(year, month)).padStart(2, '0')}`;

  const structure = await db.getSalaryStructureAsOf(userId, monthEndStr);
  if (!structure) {
    return { error: 'NO_SALARY_STRUCTURE', message: 'No active salary structure found for this payroll month' };
  }

  const components = await db.getStructureComponents(structure.id);
  const earning = (code) => {
    const c = components.find(x => x.code === code);
    return c ? c.amount : 0;
  };

  const basicEarning = earning('BASIC');
  const hraEarning = earning('HRA');
  const otherEarningComponents = components.filter(c => c.type === 'earning' && !['BASIC', 'HRA'].includes(c.code));
  const allowancesEarning = otherEarningComponents.reduce((sum, c) => sum + c.amount, 0);

  const { workingDays, paidDays, lopDays } = await getAttendanceForPayroll(userId, year, month);
  const prorationFactor = workingDays > 0 ? paidDays / workingDays : 1;

  const variableDeductions = await db.listVariableDeductions(userId, payrollMonth);
  const variableEarningRows = variableDeductions.filter(v => {
    const comp = components.find(c => c.component_id === v.component_id) || v;
    return v.type === 'earning';
  });

  const overtimeEarning = 0; // overtime pay-out is handled via variable_deductions with an OVERTIME earning component, if configured
  const bonusEarning = variableDeductions.filter(v => v.code === 'BONUS').reduce((s, v) => s + v.amount, 0);
  const reimbursementEarning = components.filter(c => c.type === 'reimbursement').reduce((s, c) => s + c.amount, 0);
  const otherEarning = variableDeductions.filter(v => v.code && v.code !== 'BONUS' && db_isEarningCode(v.code)).reduce((s, v) => s + v.amount, 0);

  // Arrears from retroactive salary revisions — paid out as a one-time
  // earning the next time payroll runs for this employee.
  const pendingArrears = await db.listPendingArrearsForUser(userId, client);
  const arrearsPlan = pendingArrears.map(a => ({ arrearsId: a.id, amount: a.amount }));
  const arrearsEarning = roundMoney(pendingArrears.reduce((s, a) => s + Number(a.amount), 0));

  // Approved-but-unpaid leave encashment requests — paid out the same way.
  const approvedEncashments = await db.listApprovedUnpaidEncashmentsForUser(userId, client);
  const encashmentPlan = approvedEncashments.map(e => ({ encashmentId: e.id, amount: e.amount }));
  const leaveEncashmentEarning = roundMoney(approvedEncashments.reduce((s, e) => s + Number(e.amount), 0));

  const grossEarningFull = roundMoney(basicEarning + hraEarning + allowancesEarning + reimbursementEarning);
  const grossEarning = roundMoney(grossEarningFull * prorationFactor + bonusEarning + overtimeEarning + otherEarning + arrearsEarning + leaveEncashmentEarning);

  // Fixed statutory/company deductions
  const fixedDeductions = await db.listFixedDeductions(userId, structure.financial_year_id);
  const pfEmployeeDeduction = roundMoney((fixedDeductions.find(f => f.code === 'PF_EMPLOYEE') || { amount: Math.min(basicEarning, 15000) * 0.12 }).amount * prorationFactor);
  const professionalTaxDeduction = roundMoney((fixedDeductions.find(f => f.code === 'PT') || { amount: grossEarning > 15000 ? 200 : 0 }).amount);
  const insuranceDeduction = roundMoney((fixedDeductions.find(f => f.code === 'INSURANCE') || { amount: 0 }).amount);
  const otherFixedDeduction = roundMoney(fixedDeductions.filter(f => !['PF_EMPLOYEE', 'PT', 'INSURANCE'].includes(f.code)).reduce((s, f) => s + f.amount, 0));

  const variableDeductionsTotal = roundMoney(variableDeductions.filter(v => v.code && !db_isEarningCode(v.code) && v.code !== 'BONUS').reduce((s, v) => s + v.amount, 0));

  // Loans — one EMI per active loan, split into principal/interest via the
  // reducing-balance method, capped so a loan never goes below zero balance.
  const activeLoans = await db.listActiveLoansForUser(userId, client);
  const loanPlan = [];
  let loanDeduction = 0;
  for (const loan of activeLoans) {
    const monthlyRate = (Number(loan.interest_rate_annual) || 0) / 12 / 100;
    const interestComponent = roundMoney(loan.outstanding_balance * monthlyRate);
    let emi = Number(loan.emi_amount) || 0;
    let principalComponent = roundMoney(emi - interestComponent);
    if (principalComponent > loan.outstanding_balance) {
      // final instalment — pay off exactly what's left instead of overshooting
      principalComponent = loan.outstanding_balance;
      emi = roundMoney(principalComponent + interestComponent);
    }
    const balanceAfter = roundMoney(Math.max(0, loan.outstanding_balance - principalComponent));
    loanPlan.push({ loanId: loan.id, amount: emi, principalComponent, interestComponent, balanceAfter });
    loanDeduction += emi;
  }
  loanDeduction = roundMoney(loanDeduction);

  // Salary advances — flat monthly recovery amount until the balance clears.
  const recoveringAdvances = await db.listRecoveringAdvancesForUser(userId, client);
  const advancePlan = [];
  let advanceRecoveryDeduction = 0;
  for (const advance of recoveringAdvances) {
    const recoveryAmount = Math.min(Number(advance.monthly_recovery_amount) || 0, advance.outstanding_balance);
    const balanceAfter = roundMoney(Math.max(0, advance.outstanding_balance - recoveryAmount));
    advancePlan.push({ advanceId: advance.id, amount: roundMoney(recoveryAmount), balanceAfter });
    advanceRecoveryDeduction += recoveryAmount;
  }
  advanceRecoveryDeduction = roundMoney(advanceRecoveryDeduction);

  const taxRegimeSelection = await db.getEmployeeTaxRegime(userId, structure.financial_year_id);
  const taxRegime = taxRegimeSelection
    ? await db.getTaxRegime(taxRegimeSelection.tax_regime_id)
    : await db.getDefaultTaxRegime(structure.financial_year_id);

  const annualizedGrossForTax = roundMoney((basicEarning + hraEarning + allowancesEarning) * 12);
  const tds = await getMonthlyTDS(userId, financialYear, payrollMonth, annualizedGrossForTax / 12, taxRegime.id);

  const totalDeductions = roundMoney(pfEmployeeDeduction + professionalTaxDeduction + insuranceDeduction + otherFixedDeduction + variableDeductionsTotal + tds.monthlyTds + loanDeduction + advanceRecoveryDeduction);
  const netSalary = roundMoney(grossEarning - totalDeductions);

  const exceptions = [];
  if (netSalary < 0) exceptions.push({ code: 'NEGATIVE_NET', message: 'Net salary computed as negative', severity: 'error' });
  if (!taxRegimeSelection) exceptions.push({ code: 'NO_REGIME_SELECTED', message: 'Employee has not selected a tax regime; used FY default', severity: 'warning' });
  if (lopDays > 0) exceptions.push({ code: 'LOP_APPLIED', message: `${lopDays} day(s) of loss-of-pay applied`, severity: 'info' });
  if (loanDeduction > 0) exceptions.push({ code: 'LOAN_EMI_APPLIED', message: `Loan EMI of ${loanDeduction} deducted`, severity: 'info' });
  if (advanceRecoveryDeduction > 0) exceptions.push({ code: 'ADVANCE_RECOVERY_APPLIED', message: `Salary advance recovery of ${advanceRecoveryDeduction} deducted`, severity: 'info' });
  if (arrearsEarning > 0) exceptions.push({ code: 'ARREARS_PAID', message: `Arrears of ${arrearsEarning} paid out`, severity: 'info' });
  if (leaveEncashmentEarning > 0) exceptions.push({ code: 'LEAVE_ENCASHMENT_PAID', message: `Leave encashment of ${leaveEncashmentEarning} paid out`, severity: 'info' });

  return {
    salaryStructureId: structure.id,
    basicEarning: roundMoney(basicEarning * prorationFactor),
    hraEarning: roundMoney(hraEarning * prorationFactor),
    allowancesEarning: roundMoney(allowancesEarning * prorationFactor),
    variableEarning: roundMoney(otherEarning),
    overtimeEarning: roundMoney(overtimeEarning),
    bonusEarning: roundMoney(bonusEarning),
    reimbursementEarning: roundMoney(reimbursementEarning * prorationFactor),
    otherEarning: 0,
    arrearsEarning,
    leaveEncashmentEarning,
    grossEarning,
    pfEmployeeDeduction,
    professionalTaxDeduction,
    insuranceDeduction,
    otherFixedDeduction,
    variableDeductionsTotal,
    loanDeduction,
    advanceRecoveryDeduction,
    tdsDeduction: tds.monthlyTds,
    totalDeductions,
    taxableIncome: tds.taxableIncome,
    annualTaxableIncome: tds.annualTaxableIncome,
    annualTax: tds.annualTax,
    monthlyTds: tds.monthlyTds,
    tdsAlreadyDeducted: tds.tdsAlreadyDeducted,
    remainingTaxLiability: tds.remainingTaxLiability,
    netSalary,
    workingDays,
    paidDays,
    lopDays,
    exceptions,
    loanPlan,
    advancePlan,
    arrearsPlan,
    encashmentPlan,
  };
}

function db_isEarningCode(code) {
  return ['BONUS', 'OVERTIME', 'ARREARS', 'REIMBURSEMENT'].includes(code);
}

// ---------------------------------------------------------------------------
// FULL PAYROLL RUN — ALL EMPLOYEES FOR A MONTH
// ---------------------------------------------------------------------------

async function calculatePayrollRun(financialYearId, payrollMonth, actorId) {
  const financialYear = await db.getFinancialYear(financialYearId);
  if (!financialYear) throw new Error('Financial year not found');
  await ensureStatutoryTaxRules(financialYearId);

  return db.withTx(async (tx) => {
    const run = await db.getOrCreatePayrollRun(financialYearId, payrollMonth, tx);
    if (run.status === 'locked' || run.status === 'disbursed') {
      throw new Error(`Payroll run for ${payrollMonth} is already ${run.status} and cannot be recalculated`);
    }
    await db.reversePayrollSideEffectsForRun(run.id, tx);
    await db.clearPayrollDetailsForRun(run.id, tx);

    const employees = await db.dbAll("SELECT id FROM users WHERE active = 1 AND role != 'admin'", [], tx);
    let totalGross = 0, totalDeductions = 0, totalTds = 0, totalNet = 0, calculated = 0;

    for (const emp of employees) {
      const result = await calculateMonthlyPayroll(emp.id, financialYear, payrollMonth, tx);
      if (result.error) {
        await db.addPayrollException(run.id, emp.id, result.error, result.message, 'error', tx);
        continue;
      }
      const info = await db.insertPayrollDetail({ payrollRunId: run.id, userId: emp.id, ...result }, tx);
      const payrollDetailId = info.lastInsertRowid;
      for (const ex of result.exceptions) {
        await db.addPayrollException(run.id, emp.id, ex.code, ex.message, ex.severity, tx);
      }
      for (const p of result.loanPlan) {
        await db.applyLoanRepayment(p.loanId, { amount: p.amount, principalComponent: p.principalComponent, interestComponent: p.interestComponent, balanceAfter: p.balanceAfter, payrollMonth, payrollDetailId }, tx);
      }
      for (const p of result.advancePlan) {
        await db.applyAdvanceRecovery(p.advanceId, { amount: p.amount, balanceAfter: p.balanceAfter, payrollMonth, payrollDetailId }, tx);
      }
      for (const p of result.arrearsPlan) {
        await db.markArrearsPaid(p.arrearsId, payrollDetailId, tx);
      }
      for (const p of result.encashmentPlan) {
        await db.markLeaveEncashmentPaid(p.encashmentId, payrollDetailId, tx);
      }
      totalGross += result.grossEarning;
      totalDeductions += result.totalDeductions;
      totalTds += result.tdsDeduction;
      totalNet += result.netSalary;
      calculated++;
    }

    await db.updatePayrollRunTotals(run.id, {
      totalEmployees: calculated,
      totalGross: roundMoney(totalGross),
      totalDeductions: roundMoney(totalDeductions),
      totalTds: roundMoney(totalTds),
      totalNet: roundMoney(totalNet),
    }, tx);
    await db.setPayrollRunStatus(run.id, 'calculated', actorId, tx);
    await db.logPayrollAudit('payroll_run', run.id, 'calculated', actorId, null, { totalEmployees: calculated, payrollMonth }, tx);

    return db.getPayrollRun(run.id, tx);
  });
}

async function reviewPayrollRun(payrollRunId, actorId) {
  await db.setPayrollRunStatus(payrollRunId, 'reviewed', actorId);
  await db.logPayrollAudit('payroll_run', payrollRunId, 'reviewed', actorId);
}

async function approvePayrollRun(payrollRunId, actorId) {
  return db.withTx(async (tx) => {
    const details = await db.dbAll('SELECT id FROM payroll_details WHERE payroll_run_id = ?', [payrollRunId], tx);
    for (const d of details) await db.updatePayrollDetailStatus(d.id, 'approved', actorId, tx);
    await db.setPayrollRunStatus(payrollRunId, 'approved', actorId, tx);
    await db.logPayrollAudit('payroll_run', payrollRunId, 'approved', actorId, null, null, tx);
  });
}

async function lockPayrollRun(payrollRunId, actorId) {
  await db.setPayrollRunStatus(payrollRunId, 'locked', actorId);
  await db.logPayrollAudit('payroll_run', payrollRunId, 'locked', actorId);
}

// ---------------------------------------------------------------------------
// PAYROLL ADJUSTMENTS (post-calculation correction workflow)
// ---------------------------------------------------------------------------

const ADJUSTMENT_FIELD_MAP = {
  earning: 'other_earning',
  deduction: 'other_fixed_deduction',
  tds: 'tds_deduction',
};

async function requestPayrollAdjustment(payrollDetailId, adjustmentType, amount, reason, requestedBy) {
  return db.createPayrollAdjustment({ payrollDetailId, adjustmentType, amount, reason, requestedBy });
}

async function decidePayrollAdjustment(adjustmentId, decision, actorId) {
  return db.withTx(async (tx) => {
    const adjustments = await db.dbAll('SELECT * FROM payroll_adjustments WHERE id = ?', [adjustmentId], tx);
    const adj = adjustments[0];
    if (!adj) throw new Error('Adjustment not found');
    if (adj.status !== 'pending') throw new Error('This adjustment has already been decided');

    await db.decidePayrollAdjustment(adjustmentId, decision === 'approve' ? 'approved' : 'rejected', actorId, tx);
    if (decision === 'approve') {
      const field = ADJUSTMENT_FIELD_MAP[adj.adjustment_type] || 'other_earning';
      await db.applyPayrollAdjustmentToDetail(adj.payroll_detail_id, field, adj.amount, tx);
    }
    await db.logPayrollAudit('payroll_adjustment', adjustmentId, decision, actorId, null, { amount: adj.amount }, tx);
  });
}

// ---------------------------------------------------------------------------
// PAYSLIP DATA PREPARATION (PDF byte generation lives in reports.js)
// ---------------------------------------------------------------------------

async function preparePayslipData(payrollDetailId) {
  const detail = await db.getPayrollDetail(payrollDetailId);
  if (!detail) throw new Error('Payroll detail not found');
  const run = await db.getPayrollRun(detail.payroll_run_id);
  const user = await db.findUserById(detail.user_id);
  const financialYear = await db.getFinancialYear(run.financial_year_id);
  const structure = detail.salary_structure_id ? await db.getSalaryStructureById(detail.salary_structure_id) : null;
  const components = structure ? await db.getStructureComponents(structure.id) : [];
  const settings = await db.getSettings();

  return { detail, run, user, financialYear, components, settings };
}

async function generatePayslipRecord(payrollDetailId, generatedBy, pdfPath) {
  const detail = await db.getPayrollDetail(payrollDetailId);
  if (!detail) throw new Error('Payroll detail not found');
  const run = await db.getPayrollRun(detail.payroll_run_id);
  return db.withTx(async (tx) => {
    const payslip = await db.createPayslip(payrollDetailId, detail.user_id, run.payroll_month, pdfPath, generatedBy, tx);
    await db.logPayrollAudit('payslip', payslip.id, 'generated', generatedBy, null, { payrollDetailId }, tx);
    return payslip;
  });
}

// ---------------------------------------------------------------------------
// ARREARS FROM RETROACTIVE SALARY REVISIONS
// ---------------------------------------------------------------------------

// When a revision is backdated over months whose payroll has already been
// approved/locked, this creates one arrears_payments row per already-settled
// month equal to the change in monthly CTC, prorated by that month's actual
// paid-day ratio. This is a deliberate simplification (a true component-by-
// component recompute of each historical month under the new structure
// would need each month's exact original inputs re-run) but it is the same
// approximation payroll teams commonly use for arrears — the delta is
// transparent, auditable per month via arrears_payments, and paid out
// automatically the next time payroll runs for the employee.
async function generateArrearsForRetroactiveRevision({ userId, financialYearId, effectiveDate, previousMonthlyCtc, newMonthlyCtc, revisionId, tx }) {
  const delta = roundMoney(newMonthlyCtc - (previousMonthlyCtc || 0));
  const created = [];
  if (delta === 0) return created;
  const fromMonth = effectiveDate.slice(0, 7);
  const currentMonth = nowStr().slice(0, 7);
  const settledMonths = await db.listSettledPayrollMonthsForUser(userId, financialYearId, fromMonth, currentMonth, tx);
  for (const m of settledMonths) {
    const ratio = m.working_days > 0 ? m.paid_days / m.working_days : 1;
    const amount = roundMoney(delta * ratio);
    if (amount === 0) continue;
    const info = await db.createArrearsPayment({
      userId, salaryRevisionId: revisionId, forPayrollMonth: m.payroll_month, amount,
      reason: `Arrears for retroactive salary revision effective ${effectiveDate}`,
    }, tx);
    created.push({ id: info.lastInsertRowid, forPayrollMonth: m.payroll_month, amount });
  }
  return created;
}

// ---------------------------------------------------------------------------
// GRATUITY (Payment of Gratuity Act, 1972 convention) — a compute-on-demand
// liability/estimate, not a disbursement. Actual gratuity payout happens as
// part of full & final settlement at exit (a separate module); this gives
// admins and employees a running estimate for CTC/liability visibility.
// ---------------------------------------------------------------------------

const GRATUITY_ELIGIBILITY_YEARS = 5;
const GRATUITY_STATUTORY_CAP = 2000000; // ₹20,00,000 statutory ceiling (Payment of Gratuity Act)

async function calculateGratuity(userId, financialYearId, asOfDate) {
  const user = await db.findUserById(userId);
  if (!user) throw new Error('Employee not found');
  const asOf = asOfDate || todayStr();
  const years = yearsOfService(user.joined_date, asOf);

  const fy = financialYearId ? await db.getFinancialYear(financialYearId) : await db.getActiveFinancialYear();
  const structure = fy ? await db.getSalaryStructureAsOf(userId, asOf) : null;
  let lastDrawnBasic = 0;
  if (structure) {
    const components = await db.getStructureComponents(structure.id);
    const basic = components.find(c => c.code === 'BASIC');
    lastDrawnBasic = basic ? basic.amount : 0;
  }

  const eligible = years >= GRATUITY_ELIGIBILITY_YEARS;
  const rawAmount = eligible ? roundMoney((lastDrawnBasic * 15 * years) / 26) : 0;
  const gratuityAmount = Math.min(rawAmount, GRATUITY_STATUTORY_CAP);

  return {
    userId,
    joinedDate: user.joined_date,
    asOfDate: asOf,
    yearsOfService: years,
    eligible,
    eligibilityThresholdYears: GRATUITY_ELIGIBILITY_YEARS,
    lastDrawnBasic,
    rawAmount,
    gratuityAmount: roundMoney(gratuityAmount),
    statutoryCapApplied: rawAmount > GRATUITY_STATUTORY_CAP,
  };
}

// ---------------------------------------------------------------------------
// LOANS — request / approve / disburse
// ---------------------------------------------------------------------------

async function requestLoan({ userId, principalAmount, interestRateAnnual, tenureMonths, purpose }) {
  if (!(principalAmount > 0)) throw new Error('Principal amount must be greater than zero');
  if (!(tenureMonths >= 1)) throw new Error('Tenure must be at least 1 month');
  return db.createLoan({ userId, principalAmount: roundMoney(principalAmount), interestRateAnnual: interestRateAnnual || 0, tenureMonths, purpose });
}

async function decideLoanRequest(loanId, decision, actorId) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const loan = await db.getLoan(loanId);
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'pending') throw new Error('This loan request has already been decided');
  await db.decideLoan(loanId, decision, actorId);
  await db.logPayrollAudit('loan', loanId, decision, actorId);
  return db.getLoan(loanId);
}

async function disburseLoanFull(loanId, actorId) {
  const loan = await db.getLoan(loanId);
  if (!loan) throw new Error('Loan not found');
  if (loan.status !== 'approved') throw new Error('Only an approved loan can be disbursed');
  const emi = computeEmi(loan.principal_amount, loan.interest_rate_annual, loan.tenure_months);
  return db.withTx(async (tx) => {
    await db.disburseLoan(loanId, emi, tx);
    await db.logPayrollAudit('loan', loanId, 'disbursed', actorId, null, { emiAmount: emi }, tx);
    return db.getLoan(loanId, tx);
  });
}

// ---------------------------------------------------------------------------
// SALARY ADVANCES — request / approve
// ---------------------------------------------------------------------------

async function requestSalaryAdvance({ userId, amount, reason, recoveryMonths }) {
  if (!(amount > 0)) throw new Error('Advance amount must be greater than zero');
  return db.createSalaryAdvance({ userId, amount: roundMoney(amount), reason, recoveryMonths: recoveryMonths || 1 });
}

async function decideSalaryAdvanceRequest(advanceId, decision, actorId, recoveryMonths, monthlyRecoveryAmount) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const advance = await db.getSalaryAdvance(advanceId);
  if (!advance) throw new Error('Salary advance request not found');
  if (advance.status !== 'pending') throw new Error('This advance request has already been decided');
  await db.decideSalaryAdvance(advanceId, decision, actorId, recoveryMonths, monthlyRecoveryAmount);
  await db.logPayrollAudit('salary_advance', advanceId, decision, actorId);
  return db.getSalaryAdvance(advanceId);
}

// ---------------------------------------------------------------------------
// LEAVE ENCASHMENT — request / approve
// ---------------------------------------------------------------------------

async function requestLeaveEncashment({ userId, leaveTypeId, financialYearId, days }) {
  if (!(days > 0)) throw new Error('Days to encash must be greater than zero');
  const year = (await db.getFinancialYear(financialYearId)).start_date.slice(0, 4);
  const balance = await db.dbGet('SELECT * FROM leave_balances WHERE user_id = ? AND leave_type_id = ? AND year = ?', [userId, leaveTypeId, Number(year)]);
  const available = balance ? Number(balance.total_days) - Number(balance.used_days) : 0;
  if (days > available) throw new Error(`Only ${available} day(s) available to encash for this leave type`);

  const structure = await db.getActiveSalaryStructure(userId, financialYearId);
  if (!structure) throw new Error('No active salary structure found — cannot compute encashment value');
  const components = await db.getStructureComponents(structure.id);
  const basic = components.find(c => c.code === 'BASIC');
  const monthlyBasic = basic ? basic.amount : 0;
  const perDayAmount = roundMoney(monthlyBasic / 26);
  const amount = roundMoney(perDayAmount * days);

  return db.withTx(async (tx) => {
    const info = await db.createLeaveEncashmentRequest({ userId, leaveTypeId, financialYearId, days, perDayAmount, amount }, tx);
    return { id: info.lastInsertRowid, days, perDayAmount, amount };
  });
}

async function decideLeaveEncashmentRequest(encashmentId, decision, actorId) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const enc = await db.getLeaveEncashment(encashmentId);
  if (!enc) throw new Error('Leave encashment request not found');
  if (enc.status !== 'pending') throw new Error('This encashment request has already been decided');
  return db.withTx(async (tx) => {
    await db.decideLeaveEncashment(encashmentId, decision, actorId, tx);
    if (decision === 'approved') {
      // Deduct from the leave balance immediately (payout happens on the
      // next payroll run); rejecting leaves the balance untouched.
      const year = (await db.getFinancialYear(enc.financial_year_id)).start_date.slice(0, 4);
      await db.dbRun('UPDATE leave_balances SET used_days = used_days + ? WHERE user_id = ? AND leave_type_id = ? AND year = ?',
        [enc.days, enc.user_id, enc.leave_type_id, Number(year)], tx);
    }
    await db.logPayrollAudit('leave_encashment', encashmentId, decision, actorId, null, null, tx);
    return db.getLeaveEncashment(encashmentId, tx);
  });
}

// ---------------------------------------------------------------------------
// MONTH-TO-MONTH PAYROLL COMPARISON & VARIANCE REPORT
// ---------------------------------------------------------------------------

async function comparePayrollMonths(financialYearId, monthA, monthB) {
  const [detailsA, detailsB] = await Promise.all([
    db.getPayrollDetailsByMonth(financialYearId, monthA),
    db.getPayrollDetailsByMonth(financialYearId, monthB),
  ]);
  const byUserA = new Map(detailsA.map(d => [d.user_id, d]));
  const byUserB = new Map(detailsB.map(d => [d.user_id, d]));
  const userIds = new Set([...byUserA.keys(), ...byUserB.keys()]);

  const employees = [];
  for (const userId of userIds) {
    const a = byUserA.get(userId);
    const b = byUserB.get(userId);
    employees.push({
      userId,
      userName: (a || b).user_name,
      grossA: a ? a.gross_earning : 0,
      grossB: b ? b.gross_earning : 0,
      grossDelta: roundMoney((b ? b.gross_earning : 0) - (a ? a.gross_earning : 0)),
      netA: a ? a.net_salary : 0,
      netB: b ? b.net_salary : 0,
      netDelta: roundMoney((b ? b.net_salary : 0) - (a ? a.net_salary : 0)),
      tdsA: a ? a.tds_deduction : 0,
      tdsB: b ? b.tds_deduction : 0,
      tdsDelta: roundMoney((b ? b.tds_deduction : 0) - (a ? a.tds_deduction : 0)),
      presentInA: !!a,
      presentInB: !!b,
    });
  }
  employees.sort((x, y) => x.userName.localeCompare(y.userName));

  const totals = (rows, key) => roundMoney(rows.reduce((s, r) => s + Number(r[key] || 0), 0));
  return {
    monthA, monthB,
    totals: {
      grossA: totals(detailsA, 'gross_earning'), grossB: totals(detailsB, 'gross_earning'),
      netA: totals(detailsA, 'net_salary'), netB: totals(detailsB, 'net_salary'),
      tdsA: totals(detailsA, 'tds_deduction'), tdsB: totals(detailsB, 'tds_deduction'),
      headcountA: detailsA.length, headcountB: detailsB.length,
    },
    employees,
  };
}

async function payrollVarianceReport(financialYearId, monthA, monthB, thresholdPercent) {
  const threshold = thresholdPercent != null ? Number(thresholdPercent) : 10;
  const comparison = await comparePayrollMonths(financialYearId, monthA, monthB);
  const flagged = comparison.employees
    .filter(e => e.presentInA && e.presentInB)
    .map(e => {
      const pctChange = e.netA ? roundMoney((e.netDelta / e.netA) * 100) : (e.netB ? 100 : 0);
      return { ...e, pctChange };
    })
    .filter(e => Math.abs(e.pctChange) >= threshold)
    .sort((x, y) => Math.abs(y.pctChange) - Math.abs(x.pctChange));

  const newJoiners = comparison.employees.filter(e => !e.presentInA && e.presentInB);
  const dropped = comparison.employees.filter(e => e.presentInA && !e.presentInB);

  return { monthA, monthB, thresholdPercent: threshold, flagged, newJoiners, dropped, totals: comparison.totals };
}

module.exports = {
  compareTaxRegimesForEmployee,
  getEmployeeTaxSummary,
  activateSalaryStructureFull,
  roundMoney,
  dateOnly,
  maxDate,
  minDate,
  daysInMonthUTC,
  ensureStatutoryTaxRules,
  calculateTaxForRegime,
  calculateTaxLiability,
  getRemainingPayrollMonths,
  getPriorPayrollTDS,
  getProjectedFYSalaryIncomeForPreview,
  getApprovedTaxDeductions,
  getMonthlyTDS,
  populateDefaultStructureComponents,
  createSalaryStructure,
  setSalaryStructureComponents,
  giveSalaryHike,
  updateEmployeeCompensation,
  getAttendanceForPayroll,
  calculateMonthlyPayroll,
  calculatePayrollRun,
  reviewPayrollRun,
  approvePayrollRun,
  lockPayrollRun,
  requestPayrollAdjustment,
  decidePayrollAdjustment,
  preparePayslipData,
  generatePayslipRecord,
  generateArrearsForRetroactiveRevision,
  calculateGratuity,
  requestLoan,
  decideLoanRequest,
  disburseLoanFull,
  requestSalaryAdvance,
  decideSalaryAdvanceRequest,
  requestLeaveEncashment,
  decideLeaveEncashmentRequest,
  comparePayrollMonths,
  payrollVarianceReport,
};
