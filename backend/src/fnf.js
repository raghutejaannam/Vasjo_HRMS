// src/fnf.js — BLOCK 6: Full & Final Settlement
//
// Target flow (from the spec): Employee Exit -> Final Attendance -> Salary
// -> Leave Encashment -> Bonus -> Gratuity -> Reimbursements -> Loan
// Outstanding -> Advance -> Asset Recovery -> Final Settlement -> Statement.
//
// Employee Lifecycle (Block 1) hasn't been built yet, so this module owns a
// minimal resignation/exit record (employee_separations) itself rather than
// depending on an exit workflow that doesn't exist — see the migration
// comment for why that's deliberately narrow in scope.

const db = require('./db');
const payroll = require('./payroll');
const lifecycle = require('./lifecycle');

function roundMoney(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function daysBetweenInclusive(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00Z');
  const to = new Date(toStr + 'T00:00:00Z');
  return Math.round((to - from) / 86400000) + 1;
}

async function resolveFinancialYearForDate(dateStr) {
  const years = await db.listFinancialYears();
  const match = years.find(y => y.start_date <= dateStr && dateStr <= y.end_date);
  return match || await db.getActiveFinancialYear();
}

// ---------------------------------------------------------------------------
// RESIGNATION / SEPARATION
// ---------------------------------------------------------------------------

async function initiateSeparation({ userId, resignationDate, lastWorkingDate, noticePeriodRequiredDays, reason, initiatedBy }) {
  if (!resignationDate || !lastWorkingDate) throw new Error('resignationDate and lastWorkingDate are required');
  if (lastWorkingDate < resignationDate) throw new Error('lastWorkingDate cannot be before resignationDate');
  const existing = await db.getActiveSeparationForUser(userId);
  if (existing) throw new Error('This employee already has an active resignation/separation in progress');
  return db.createSeparation({ userId, resignationDate, lastWorkingDate, noticePeriodRequiredDays: noticePeriodRequiredDays || 0, reason, initiatedBy });
}

async function decideSeparationRequest(id, decision, actorId) {
  if (!['approved', 'withdrawn'].includes(decision)) throw new Error('decision must be approved or withdrawn');
  const separation = await db.getSeparation(id);
  if (!separation) throw new Error('Separation record not found');
  if (separation.status !== 'pending') throw new Error('This separation request has already been decided');
  await db.decideSeparation(id, decision, actorId);
  if (decision === 'approved') {
    await lifecycle.onSeparationApproved(separation.user_id, id, actorId);
  }
  return db.getSeparation(id);
}

// ---------------------------------------------------------------------------
// SETTLEMENT GENERATION
// ---------------------------------------------------------------------------

async function generateSettlement(employeeSeparationId, preparedBy, overrides = {}) {
  const separation = await db.getSeparation(employeeSeparationId);
  if (!separation) throw new Error('Separation record not found');
  if (separation.status !== 'approved') throw new Error('The separation must be approved before a settlement can be generated');

  const existing = await db.getFnfSettlementBySeparation(employeeSeparationId);
  if (existing && existing.status !== 'draft') {
    throw new Error(`A settlement already exists for this separation (status: ${existing.status}) — it can only be regenerated while in draft`);
  }

  const userId = separation.user_id;
  const fy = await resolveFinancialYearForDate(separation.last_working_date);
  if (!fy) throw new Error('No financial year configured for the last working date');

  const structure = await db.getActiveSalaryStructure(userId, fy.id);
  const components = structure ? await db.getStructureComponents(structure.id) : [];
  const monthlyGross = roundMoney(components.filter(c => c.type === 'earning').reduce((s, c) => s + Number(c.amount || 0), 0));
  const perDaySalary = roundMoney(monthlyGross / 26); // same /26 convention used elsewhere (leave encashment, notice recovery)

  // -- Notice period recovery -----------------------------------------
  const servedDays = Math.max(0, daysBetweenInclusive(separation.resignation_date, separation.last_working_date) - 1);
  const noticeShortfallDays = Math.max(0, separation.notice_period_required_days - servedDays);
  const noticeRecoveryAmount = roundMoney(perDaySalary * noticeShortfallDays);

  // -- Unpaid salary for the final (likely partial) month --------------
  const lastWorkingMonth = separation.last_working_date.slice(0, 7);
  const alreadyPayrolled = await db.dbGet(`
    SELECT 1 AS found FROM payroll_details pd JOIN payroll_runs pr ON pr.id = pd.payroll_run_id
    WHERE pd.user_id = ? AND pr.payroll_month = ? AND pr.status IN ('approved','locked','disbursed') LIMIT 1
  `, [userId, lastWorkingMonth]);
  let unpaidSalaryDays = 0;
  if (!alreadyPayrolled) {
    const monthStart = `${lastWorkingMonth}-01`;
    const [holidays, weeklyOffDays] = await Promise.all([db.getHolidaysInRange(monthStart, separation.last_working_date), db.getWeeklyOffDays()]);
    const holidaySet = new Set(holidays.map(h => h.holiday_date));
    const lastDay = Number(separation.last_working_date.slice(8, 10));
    for (let d = 1; d <= lastDay; d++) {
      const dateStr = `${lastWorkingMonth}-${String(d).padStart(2, '0')}`;
      const dow = new Date(dateStr + 'T00:00:00Z').getUTCDay();
      if (holidaySet.has(dateStr) || weeklyOffDays.includes(dow)) continue;
      unpaidSalaryDays++;
    }
  }
  const unpaidSalaryAmount = roundMoney(perDaySalary * unpaidSalaryDays);

  // -- Leave encashment (all remaining balance, across all leave types) -
  const year = Number(fy.start_date.slice(0, 4));
  const balances = await db.dbAll('SELECT * FROM leave_balances WHERE user_id = ? AND year = ?', [userId, year]);
  const leaveEncashmentDays = roundMoney(balances.reduce((s, b) => s + Math.max(0, Number(b.total_days) - Number(b.used_days)), 0));
  const leaveEncashmentAmount = roundMoney(perDaySalary * leaveEncashmentDays);

  // -- Gratuity ----------------------------------------------------------
  const gratuity = await payroll.calculateGratuity(userId, fy.id, separation.last_working_date);

  // -- Loan / advance recovery (full outstanding balance recovered at exit)
  const [activeLoans, recoveringAdvances] = await Promise.all([
    db.listActiveLoansForUser(userId), db.listRecoveringAdvancesForUser(userId),
  ]);
  const loanRecoveryAmount = roundMoney(activeLoans.reduce((s, l) => s + Number(l.outstanding_balance), 0));
  const advanceRecoveryAmount = roundMoney(recoveringAdvances.reduce((s, a) => s + Number(a.outstanding_balance), 0));

  // -- Manually-entered lines (bonus, reimbursements, asset recovery, other)
  const bonusAmount = roundMoney(overrides.bonusAmount || 0);
  const reimbursementsAmount = roundMoney(overrides.reimbursementsAmount || 0);
  const assetRecoveryAmount = roundMoney(overrides.assetRecoveryAmount || 0);
  const otherDeductionsAmount = roundMoney(overrides.otherDeductionsAmount || 0);
  const otherDeductionsNotes = overrides.otherDeductionsNotes || null;

  const totalEarnings = roundMoney(unpaidSalaryAmount + leaveEncashmentAmount + bonusAmount + gratuity.gratuityAmount + reimbursementsAmount);
  const totalDeductions = roundMoney(noticeRecoveryAmount + loanRecoveryAmount + advanceRecoveryAmount + assetRecoveryAmount + otherDeductionsAmount);
  const finalPayable = roundMoney(totalEarnings - totalDeductions);

  const lineItems = {
    userId, employeeSeparationId, unpaidSalaryDays, unpaidSalaryAmount, noticeRecoveryDays: noticeShortfallDays, noticeRecoveryAmount,
    leaveEncashmentDays, leaveEncashmentAmount, bonusAmount, gratuityAmount: gratuity.gratuityAmount, reimbursementsAmount,
    loanRecoveryAmount, advanceRecoveryAmount, assetRecoveryAmount, otherDeductionsAmount, otherDeductionsNotes,
    totalEarnings, totalDeductions, finalPayable, preparedBy,
  };

  if (existing) {
    await db.updateFnfSettlementLineItems(existing.id, lineItems);
    return db.getFnfSettlement(existing.id);
  }
  const info = await db.createFnfSettlement(lineItems);
  return db.getFnfSettlement(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// APPROVAL / PAYOUT WORKFLOW
// ---------------------------------------------------------------------------

async function submitSettlementForApproval(settlementId) {
  const settlement = await db.getFnfSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found');
  if (settlement.status !== 'draft') throw new Error('Only a draft settlement can be submitted for approval');
  await db.submitFnfSettlementForApproval(settlementId);
  return db.getFnfSettlement(settlementId);
}

async function decideSettlement(settlementId, decision, actorId) {
  if (!['approved', 'rejected'].includes(decision)) throw new Error('decision must be approved or rejected');
  const settlement = await db.getFnfSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found');
  if (settlement.status !== 'pending_approval') throw new Error('This settlement is not pending approval');
  await db.decideFnfSettlement(settlementId, decision === 'approved' ? 'approved' : 'draft', actorId);
  return db.getFnfSettlement(settlementId);
}

async function markSettlementPaid(settlementId, actorId) {
  const settlement = await db.getFnfSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found');
  if (settlement.status !== 'approved') throw new Error('Only an approved settlement can be marked paid');

  return db.withTx(async (tx) => {
    const [activeLoans, recoveringAdvances] = await Promise.all([
      db.listActiveLoansForUser(settlement.user_id, tx), db.listRecoveringAdvancesForUser(settlement.user_id, tx),
    ]);
    for (const loan of activeLoans) {
      await db.applyLoanRepayment(loan.id, {
        amount: loan.outstanding_balance, principalComponent: loan.outstanding_balance, interestComponent: 0,
        balanceAfter: 0, payrollMonth: 'FNF', payrollDetailId: null,
      }, tx);
    }
    for (const advance of recoveringAdvances) {
      await db.applyAdvanceRecovery(advance.id, { amount: advance.outstanding_balance, balanceAfter: 0, payrollMonth: 'FNF', payrollDetailId: null }, tx);
    }
    await db.markFnfSettlementPaid(settlementId, tx);
    await db.markSeparationExited(settlement.employee_separation_id, tx);
    await db.deactivateUser(settlement.user_id, tx);
    await lifecycle.onSettlementPaid(settlement.user_id, actorId, tx);
    return db.getFnfSettlement(settlementId, tx);
  });
}

// ---------------------------------------------------------------------------
// SETTLEMENT STATEMENT
// ---------------------------------------------------------------------------

async function getSettlementStatement(settlementId) {
  const settlement = await db.getFnfSettlement(settlementId);
  if (!settlement) throw new Error('Settlement not found');
  const [separation, user] = await Promise.all([db.getSeparation(settlement.employee_separation_id), db.findUserById(settlement.user_id)]);
  return {
    settlement,
    separation,
    employee: { name: user.name, employeeCode: user.employee_code, dept: user.dept, title: user.title, pan: user.pan },
    earnings: [
      { label: 'Unpaid Salary', days: settlement.unpaid_salary_days, amount: settlement.unpaid_salary_amount },
      { label: 'Leave Encashment', days: settlement.leave_encashment_days, amount: settlement.leave_encashment_amount },
      { label: 'Bonus', amount: settlement.bonus_amount },
      { label: 'Gratuity', amount: settlement.gratuity_amount },
      { label: 'Reimbursements', amount: settlement.reimbursements_amount },
    ],
    deductions: [
      { label: 'Notice Period Shortfall Recovery', days: settlement.notice_recovery_days, amount: settlement.notice_recovery_amount },
      { label: 'Loan Recovery', amount: settlement.loan_recovery_amount },
      { label: 'Advance Recovery', amount: settlement.advance_recovery_amount },
      { label: 'Asset Recovery', amount: settlement.asset_recovery_amount },
      { label: 'Other Deductions', amount: settlement.other_deductions_amount, notes: settlement.other_deductions_notes },
    ],
    totalEarnings: settlement.total_earnings, totalDeductions: settlement.total_deductions, finalPayable: settlement.final_payable,
  };
}

module.exports = {
  initiateSeparation,
  decideSeparationRequest,
  generateSettlement,
  submitSettlementForApproval,
  decideSettlement,
  markSettlementPaid,
  getSettlementStatement,
};
