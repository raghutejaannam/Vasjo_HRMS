-- 0001_init: PostgreSQL schema for the Vasjo Technologies Timesheet/Leave/Payroll backend.
-- Direct translation of the original SQLite schema (src/db.js). Only the DDL
-- dialect changed (AUTOINCREMENT -> SERIAL/IDENTITY, REAL -> DOUBLE PRECISION,
-- datetime('now') defaults -> to_char(now(),...) producing the exact same
-- 'YYYY-MM-DD HH24:MI:SS' text format the application already relies on).
-- No table, column, or CHECK constraint was dropped.

-- ---------------------------------------------------------------------------
-- CORE / AUTH
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('employee','manager','admin')),
  title TEXT,
  dept TEXT,
  manager_id INTEGER REFERENCES users(id),
  delegate_id INTEGER REFERENCES users(id),
  phone TEXT,
  joined_date TEXT,
  must_reset_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  avatar_color TEXT NOT NULL DEFAULT '#C08A2E',
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  employee_code TEXT,
  location TEXT,
  gender TEXT,
  uan TEXT,
  pf_number TEXT,
  pan TEXT,
  bank_account_no TEXT,
  bank_name TEXT,
  employee_group TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  csrf_token TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  expires_at TEXT NOT NULL
);

CREATE TABLE leave_types (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_annual_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  max_carry_forward_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE leave_balances (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  total_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  used_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  UNIQUE(user_id, leave_type_id, year)
);

CREATE TABLE timesheets (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','pending','approved','rejected')) DEFAULT 'draft',
  total_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  submitted_at TEXT,
  decided_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  last_comment TEXT,
  correction_status TEXT,
  correction_reason TEXT,
  correction_requested_at TEXT,
  escalated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, week_start)
);

CREATE TABLE projects (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE tasks (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE employee_projects (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  UNIQUE(user_id, project_id)
);

CREATE TABLE departments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE timesheet_entries (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  timesheet_id TEXT NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  hours DOUBLE PRECISION NOT NULL DEFAULT 0,
  note TEXT,
  project_id INTEGER REFERENCES projects(id),
  task_id INTEGER REFERENCES tasks(id),
  work_mode TEXT,
  in_time TEXT,
  out_time TEXT
);

CREATE TABLE leave_applications (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  days DOUBLE PRECISION NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')) DEFAULT 'pending',
  applied_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  decided_at TEXT,
  decided_by INTEGER REFERENCES users(id),
  last_comment TEXT,
  escalated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE approvals_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('timesheet','leave')),
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('submitted','approved','rejected','cancelled','correction_requested','correction_approved','correction_rejected')),
  actor_id INTEGER NOT NULL REFERENCES users(id),
  acted_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  notes TEXT
);

CREATE TABLE company_holidays (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  holiday_date TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  blackout INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE notifications (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- ---------------------------------------------------------------------------
-- PAYROLL MODULE
-- ---------------------------------------------------------------------------

CREATE TABLE financial_years (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE salary_components (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('earning','deduction','reimbursement','tax')),
  category TEXT,
  is_taxable INTEGER NOT NULL DEFAULT 1,
  is_fixed INTEGER NOT NULL DEFAULT 1,
  calculation_type TEXT,
  calculation_value DOUBLE PRECISION,
  display_order INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE employee_salary_structures (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  annual_ctc DOUBLE PRECISION NOT NULL,
  monthly_ctc DOUBLE PRECISION NOT NULL,
  basic_salary DOUBLE PRECISION NOT NULL,
  offer_letter_path TEXT,
  offer_letter_uploaded_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','active','superseded')) DEFAULT 'draft',
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, financial_year_id, effective_from)
);

CREATE TABLE salary_structure_components (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  salary_structure_id INTEGER NOT NULL REFERENCES employee_salary_structures(id) ON DELETE CASCADE,
  component_id INTEGER NOT NULL REFERENCES salary_components(id),
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_override INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(salary_structure_id, component_id)
);

CREATE TABLE tax_regimes (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(financial_year_id, code)
);

CREATE TABLE tax_slabs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_regime_id INTEGER NOT NULL REFERENCES tax_regimes(id) ON DELETE CASCADE,
  min_income DOUBLE PRECISION NOT NULL,
  max_income DOUBLE PRECISION,
  rate DOUBLE PRECISION NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tax_rules (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_regime_id INTEGER NOT NULL REFERENCES tax_regimes(id) ON DELETE CASCADE,
  rule_key TEXT NOT NULL,
  rule_value DOUBLE PRECISION NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('amount','percentage','boolean')),
  description TEXT,
  UNIQUE(tax_regime_id, rule_key)
);

CREATE TABLE deduction_limits (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  section_code TEXT NOT NULL,
  section_name TEXT NOT NULL,
  limit_amount DOUBLE PRECISION NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  UNIQUE(financial_year_id, section_code)
);

CREATE TABLE employee_tax_regime (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  tax_regime_id INTEGER NOT NULL REFERENCES tax_regimes(id),
  selected_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  selected_by INTEGER NOT NULL REFERENCES users(id),
  UNIQUE(user_id, financial_year_id)
);

CREATE TABLE tax_declaration_sections (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  section_code TEXT NOT NULL,
  section_name TEXT NOT NULL,
  description TEXT,
  max_limit DOUBLE PRECISION,
  is_active INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  applicable_regime TEXT NOT NULL DEFAULT 'old',
  UNIQUE(financial_year_id, section_code)
);

CREATE TABLE tax_declarations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  section_id INTEGER NOT NULL REFERENCES tax_declaration_sections(id),
  declared_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  eligible_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('draft','submitted','verified','rejected')) DEFAULT 'draft',
  submitted_at TEXT,
  verified_by INTEGER REFERENCES users(id),
  verified_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE tax_declaration_entries (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tax_declaration_id INTEGER NOT NULL REFERENCES tax_declarations(id) ON DELETE CASCADE,
  investment_type TEXT,
  provider_name TEXT,
  amount DOUBLE PRECISION NOT NULL,
  investment_date TEXT,
  financial_year TEXT,
  supporting_doc_path TEXT,
  status TEXT NOT NULL CHECK(status IN ('declared','proof_uploaded','approved','rejected','correction_requested')) DEFAULT 'declared',
  approved_amount DOUBLE PRECISION,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  rejection_reason TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE fixed_deductions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  component_id INTEGER NOT NULL REFERENCES salary_components(id),
  amount DOUBLE PRECISION NOT NULL,
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE variable_deductions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payroll_month TEXT NOT NULL,
  component_id INTEGER NOT NULL REFERENCES salary_components(id),
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, payroll_month, component_id)
);

CREATE TABLE previous_employer_income (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  previous_employer_name TEXT,
  gross_income DOUBLE PRECISION NOT NULL DEFAULT 0,
  tds_deducted DOUBLE PRECISION NOT NULL DEFAULT 0,
  professional_tax_paid DOUBLE PRECISION NOT NULL DEFAULT 0,
  joining_date_current_org TEXT,
  document_path TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, financial_year_id)
);

CREATE TABLE payroll_runs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  payroll_month TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','calculated','reviewed','approved','locked','disbursed')) DEFAULT 'draft',
  total_employees INTEGER NOT NULL DEFAULT 0,
  total_gross DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_deductions DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_tds DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_net DOUBLE PRECISION NOT NULL DEFAULT 0,
  calculated_by INTEGER REFERENCES users(id),
  calculated_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  locked_by INTEGER REFERENCES users(id),
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(financial_year_id, payroll_month)
);

CREATE TABLE payroll_details (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salary_structure_id INTEGER REFERENCES employee_salary_structures(id),

  basic_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  hra_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  allowances_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  variable_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  overtime_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  reimbursement_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  other_earning DOUBLE PRECISION NOT NULL DEFAULT 0,
  gross_earning DOUBLE PRECISION NOT NULL DEFAULT 0,

  pf_employee_deduction DOUBLE PRECISION NOT NULL DEFAULT 0,
  professional_tax_deduction DOUBLE PRECISION NOT NULL DEFAULT 0,
  insurance_deduction DOUBLE PRECISION NOT NULL DEFAULT 0,
  other_fixed_deduction DOUBLE PRECISION NOT NULL DEFAULT 0,
  variable_deductions_total DOUBLE PRECISION NOT NULL DEFAULT 0,
  tds_deduction DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_deductions DOUBLE PRECISION NOT NULL DEFAULT 0,

  taxable_income DOUBLE PRECISION NOT NULL DEFAULT 0,
  annual_taxable_income DOUBLE PRECISION NOT NULL DEFAULT 0,
  annual_tax DOUBLE PRECISION NOT NULL DEFAULT 0,
  monthly_tds DOUBLE PRECISION NOT NULL DEFAULT 0,
  tds_already_deducted DOUBLE PRECISION NOT NULL DEFAULT 0,
  remaining_tax_liability DOUBLE PRECISION NOT NULL DEFAULT 0,

  net_salary DOUBLE PRECISION NOT NULL DEFAULT 0,

  working_days INTEGER NOT NULL DEFAULT 0,
  paid_days INTEGER NOT NULL DEFAULT 0,
  lop_days INTEGER NOT NULL DEFAULT 0,

  status TEXT NOT NULL CHECK(status IN ('calculated','reviewed','approved','adjusted')) DEFAULT 'calculated',
  exception_flags TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  reviewed_at TEXT,
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,

  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(payroll_run_id, user_id)
);

CREATE TABLE payslips (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_detail_id INTEGER NOT NULL REFERENCES payroll_details(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payroll_month TEXT NOT NULL,
  pdf_path TEXT,
  generated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  generated_by INTEGER NOT NULL REFERENCES users(id),
  downloaded_at TEXT,
  downloaded_by INTEGER REFERENCES users(id),
  UNIQUE(payroll_detail_id)
);

CREATE TABLE payroll_exceptions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  exception_code TEXT NOT NULL,
  exception_message TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning','error','info')),
  is_resolved INTEGER NOT NULL DEFAULT 0,
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT,
  resolution_notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE payroll_audit_log (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor_id INTEGER NOT NULL REFERENCES users(id),
  old_values TEXT,
  new_values TEXT,
  acted_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE payroll_adjustments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  payroll_detail_id INTEGER NOT NULL REFERENCES payroll_details(id) ON DELETE CASCADE,
  adjustment_type TEXT NOT NULL CHECK(adjustment_type IN ('earning','deduction','tds','net')),
  component_id INTEGER REFERENCES salary_components(id),
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT NOT NULL,
  requested_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE salary_revisions (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salary_structure_id INTEGER REFERENCES employee_salary_structures(id) ON DELETE SET NULL,
  previous_annual_ctc DOUBLE PRECISION,
  new_annual_ctc DOUBLE PRECISION NOT NULL,
  previous_monthly_ctc DOUBLE PRECISION,
  new_monthly_ctc DOUBLE PRECISION NOT NULL,
  previous_basic_salary DOUBLE PRECISION,
  new_basic_salary DOUBLE PRECISION,
  hike_percentage DOUBLE PRECISION,
  hike_amount DOUBLE PRECISION,
  effective_date TEXT NOT NULL,
  revision_type TEXT NOT NULL CHECK(revision_type IN ('new_joining','annual_appraisal','mid_year_correction','promotion','market_adjustment','other')),
  reason TEXT,
  notes TEXT,
  approved_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_salary_revisions_user ON salary_revisions(user_id);
CREATE INDEX idx_salary_revisions_effective ON salary_revisions(effective_date);
