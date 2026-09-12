-- 0002_payroll_block4_extensions
--
-- Additive migration only (no drops, no renames, no data loss) supporting:
--   * formula / conditional salary component calculation types
--   * employee loans + payroll-integrated repayment
--   * salary advances + payroll-integrated recovery
--   * leave encashment payout via payroll
--   * arrears payment generation from retroactive salary revisions
--
-- Safe to run against a database that already has 0001_init applied.

ALTER TABLE salary_components ADD COLUMN formula TEXT;
ALTER TABLE salary_components ADD COLUMN conditional_rule TEXT;

ALTER TABLE salary_revisions ADD COLUMN is_retroactive INTEGER NOT NULL DEFAULT 0;

ALTER TABLE payroll_details ADD COLUMN loan_deduction DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE payroll_details ADD COLUMN advance_recovery_deduction DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE payroll_details ADD COLUMN arrears_earning DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE payroll_details ADD COLUMN leave_encashment_earning DOUBLE PRECISION NOT NULL DEFAULT 0;

CREATE TABLE loans (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  principal_amount DOUBLE PRECISION NOT NULL,
  interest_rate_annual DOUBLE PRECISION NOT NULL DEFAULT 0,
  tenure_months INTEGER NOT NULL,
  emi_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  outstanding_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  purpose TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','active','closed','cancelled')) DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  disbursed_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_loans_user ON loans(user_id);

CREATE TABLE loan_repayments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  payroll_detail_id INTEGER REFERENCES payroll_details(id) ON DELETE SET NULL,
  payroll_month TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  principal_component DOUBLE PRECISION NOT NULL DEFAULT 0,
  interest_component DOUBLE PRECISION NOT NULL DEFAULT 0,
  balance_after DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_loan_repayments_loan ON loan_repayments(loan_id);

CREATE TABLE salary_advances (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','recovering','closed')) DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  recovery_months INTEGER NOT NULL DEFAULT 1,
  monthly_recovery_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  outstanding_balance DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_salary_advances_user ON salary_advances(user_id);

CREATE TABLE advance_recoveries (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  advance_id INTEGER NOT NULL REFERENCES salary_advances(id) ON DELETE CASCADE,
  payroll_detail_id INTEGER REFERENCES payroll_details(id) ON DELETE SET NULL,
  payroll_month TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  balance_after DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_advance_recoveries_advance ON advance_recoveries(advance_id);

CREATE TABLE leave_encashments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  financial_year_id INTEGER NOT NULL REFERENCES financial_years(id),
  days DOUBLE PRECISION NOT NULL,
  per_day_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','paid')) DEFAULT 'pending',
  requested_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  payroll_detail_id INTEGER REFERENCES payroll_details(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_leave_encashments_user ON leave_encashments(user_id);

CREATE TABLE arrears_payments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  salary_revision_id INTEGER REFERENCES salary_revisions(id) ON DELETE SET NULL,
  for_payroll_month TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','paid')) DEFAULT 'pending',
  payroll_detail_id INTEGER REFERENCES payroll_details(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_arrears_payments_user ON arrears_payments(user_id);
