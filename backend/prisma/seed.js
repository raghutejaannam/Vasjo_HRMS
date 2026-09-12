// prisma/seed.js — one-time (idempotent) seed data for a fresh database.
// Run with `npx prisma db seed` (configured in package.json's `prisma.seed`
// field) after migrations have been applied.
//
// Ported from the original seedIfEmpty()/seedDefaultSalaryComponents()/
// seedDefaultTaxRules() functions that used to run automatically on every
// server boot in the SQLite version. Moved here — an explicit, standard
// Prisma seeding step — rather than an automatic startup side effect, which
// is more appropriate for a real Postgres-backed deployment (see the note
// at the top of src/db.js).

const db = require('../src/db');
const auth = require('../src/auth');
const payroll = require('../src/payroll');

async function main() {
  console.log('Seeding database...');

  // ---- Departments -------------------------------------------------------
  const deptNames = ['Engineering', 'Sales', 'Human Resources', 'Finance'];
  for (const name of deptNames) {
    await db.dbRun('INSERT INTO departments (name) VALUES (?) ON CONFLICT (name) DO NOTHING', [name]);
  }

  // ---- Leave types --------------------------------------------------------
  const leaveTypeDefs = [
    ['Annual Leave', 18, 5],
    ['Sick Leave', 10, 0],
    ['Casual Leave', 6, 0],
    ['Maternity/Paternity Leave', 90, 0],
  ];
  for (const [name, annual, carry] of leaveTypeDefs) {
    const existing = await db.dbGet('SELECT id FROM leave_types WHERE name = ?', [name]);
    if (!existing) await db.createLeaveType(name, annual, carry);
  }

  // ---- Company holidays ----------------------------------------------------
  const year = new Date().getFullYear();
  const holidayDefs = [
    [`${year}-01-26`, 'Republic Day'],
    [`${year}-08-15`, 'Independence Day'],
    [`${year}-10-02`, 'Gandhi Jayanti'],
  ];
  for (const [date, name] of holidayDefs) {
    const existing = await db.dbGet('SELECT id FROM company_holidays WHERE holiday_date = ?', [date]);
    if (!existing) await db.addHoliday(date, name, false);
  }

  // ---- Projects & tasks ----------------------------------------------------
  let project = await db.dbGet("SELECT * FROM projects WHERE name = 'Internal Tools'");
  if (!project) {
    const id = await db.createProject('Internal Tools', 'INT-001');
    project = await db.dbGet('SELECT * FROM projects WHERE id = ?', [id]);
    for (const taskName of ['Development', 'Code Review', 'Testing', 'Deployment']) {
      await db.createTask(project.id, taskName);
    }
  }

  // ---- Users ---------------------------------------------------------------
  let admin = await db.findUserByEmail('admin@vasjo.com');
  if (!admin) {
    const pw = auth.hashPassword('admin123');
    const info = await db.dbInsert(`
      INSERT INTO users (name, email, password_hash, password_salt, role, title, dept, joined_date, must_reset_password)
      VALUES (?, ?, ?, ?, 'admin', 'HR Administrator', 'Human Resources', ?, 0)
    `, ['Asha Administrator', 'admin@vasjo.com', pw.hash, pw.salt, `${year}-01-01`]);
    admin = await db.findUserById(info.lastInsertRowid);
    console.log('  Created admin@vasjo.com / admin123 (change this password immediately in production)');
  }

  let manager = await db.findUserByEmail('manager@vasjo.com');
  if (!manager) {
    const pw = auth.hashPassword('manager123');
    const info = await db.dbInsert(`
      INSERT INTO users (name, email, password_hash, password_salt, role, title, dept, manager_id, joined_date, must_reset_password)
      VALUES (?, ?, ?, ?, 'manager', 'Engineering Manager', 'Engineering', ?, ?, 0)
    `, ['Manoj Manager', 'manager@vasjo.com', pw.hash, pw.salt, admin.id, `${year}-01-01`]);
    manager = await db.findUserById(info.lastInsertRowid);
    console.log('  Created manager@vasjo.com / manager123 (change this password immediately in production)');
  }

  let employee = await db.findUserByEmail('employee@vasjo.com');
  if (!employee) {
    const pw = auth.hashPassword('employee123');
    const info = await db.dbInsert(`
      INSERT INTO users (name, email, password_hash, password_salt, role, title, dept, manager_id, joined_date, must_reset_password, employee_code)
      VALUES (?, ?, ?, ?, 'employee', 'Software Engineer', 'Engineering', ?, ?, 0, 'EMP-001')
    `, ['Priya Employee', 'employee@vasjo.com', pw.hash, pw.salt, manager.id, `${year}-01-15`]);
    employee = await db.findUserById(info.lastInsertRowid);
    console.log('  Created employee@vasjo.com / employee123 (change this password immediately in production)');
  }

  for (const user of [admin, manager, employee]) {
    await db.dbRun('INSERT INTO employee_projects (user_id, project_id) VALUES (?, ?) ON CONFLICT DO NOTHING', [user.id, project.id]);
    const types = await db.listLeaveTypes(true);
    for (const t of types) {
      await db.ensureLeaveBalance(user.id, t, year, user.joined_date);
    }
  }

  // ---- Financial year + statutory tax rules ---------------------------------
  let fy = await db.getActiveFinancialYear();
  if (!fy) {
    const fyId = await db.createFinancialYear(`FY ${year}-${String(year + 1).slice(2)}`, `${year}-04-01`, `${year + 1}-03-31`);
    await db.setActiveFinancialYear(fyId);
    fy = await db.getFinancialYear(fyId);
  }
  await payroll.ensureStatutoryTaxRules(fy.id);

  // ---- Salary components (master list) --------------------------------------
  const componentDefs = [
    ['BASIC', 'Basic Salary', 'earning', 'fixed', null, null, 1],
    ['HRA', 'House Rent Allowance', 'earning', 'percentage_of_basic', 40, 2],
    ['SPECIAL_ALLOWANCE', 'Special Allowance', 'earning', null, null, 3],
    ['TRANSPORT_ALLOWANCE', 'Transport Allowance', 'earning', 'fixed_amount', 1600, 4],
    ['MEDICAL_ALLOWANCE', 'Medical Allowance', 'earning', 'fixed_amount', 1250, 5],
    ['PF_EMPLOYER', 'Employer PF Contribution', 'earning', 'percentage_of_basic', 12, 6],
    ['BONUS', 'Performance Bonus', 'earning', null, null, 7],
    ['OVERTIME', 'Overtime Pay', 'earning', null, null, 8],
    ['ARREARS', 'Arrears', 'earning', null, null, 9],
    ['REIMBURSEMENT', 'Reimbursement', 'reimbursement', null, null, 10],
    ['PF_EMPLOYEE', 'Employee PF Contribution', 'deduction', 'percentage_of_basic', 12, 11],
    ['PT', 'Professional Tax', 'deduction', null, null, 12],
    ['INSURANCE', 'Group Health Insurance', 'deduction', null, null, 13],
    ['LOAN_RECOVERY', 'Loan Recovery', 'deduction', null, null, 14],
    ['TDS', 'Income Tax (TDS)', 'tax', null, null, 15],
    ['GRATUITY', 'Gratuity Accrual', 'earning', 'percentage_of_basic', 4.81, 16],
  ];
  for (const [code, name, type, calcType, calcValue, order] of componentDefs) {
    const existing = await db.getSalaryComponentByCode(code);
    if (!existing) {
      await db.createSalaryComponent({
        code, name, type, isTaxable: type !== 'reimbursement', isFixed: calcType !== null,
        calculationType: calcType, calculationValue: calcValue, displayOrder: order,
      });
    }
  }

  // ---- Tax declaration sections (Chapter VI-A, old regime) -------------------
  const sectionDefs = [
    ['80C', 'Section 80C', 'PF, ELSS, life insurance, principal repayment on home loan, etc.', 150000, 1, 'old'],
    ['80CCD1B', 'Section 80CCD(1B)', 'Additional NPS contribution', 50000, 2, 'old'],
    ['80D', 'Section 80D', 'Medical insurance premium', 25000, 3, 'old'],
    ['80E', 'Section 80E', 'Interest on education loan', null, 4, 'old'],
    ['80G', 'Section 80G', 'Donations to approved charities', null, 5, 'old'],
    ['24B', 'Section 24(b)', 'Interest on home loan', 200000, 6, 'old'],
    ['HRA_EXEMPTION', 'HRA Exemption', 'House rent paid, for HRA exemption calculation', null, 7, 'old'],
    ['LTA', 'LTA', 'Leave Travel Allowance claims', null, 8, 'old'],
    ['80TTA', 'Section 80TTA', 'Interest on savings account', 10000, 9, 'old'],
    ['NPS_EMPLOYER', 'Section 80CCD(2)', 'Employer NPS contribution', null, 10, 'both'],
  ];
  for (const [code, name, desc, maxLimit, order, regime] of sectionDefs) {
    const existing = await db.dbGet('SELECT id FROM tax_declaration_sections WHERE financial_year_id = ? AND section_code = ?', [fy.id, code]);
    if (!existing) {
      await db.insertTaxDeclarationSection({ financialYearId: fy.id, sectionCode: code, sectionName: name, description: desc, maxLimit, displayOrder: order, applicableRegime: regime });
    }
  }

  console.log('Seed complete.');
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(async () => { await db.prisma.$disconnect(); });
