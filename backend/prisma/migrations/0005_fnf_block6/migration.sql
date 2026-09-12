-- 0005_fnf_block6
--
-- Additive migration only. Block 6 (Full & Final Settlement) needed a
-- minimal resignation/exit record (employee_separations) since the full
-- Employee Lifecycle module (Block 1: onboarding, transfers, promotions,
-- exit workflow) hasn't been built yet — this is deliberately scoped to
-- just what F&F needs (resignation date, last working date, notice period),
-- not a general-purpose lifecycle/status-history table. If Block 1 gets
-- built later, employee_separations is a natural table for it to extend
-- rather than replace.

CREATE TABLE employee_separations (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  resignation_date TEXT NOT NULL,
  last_working_date TEXT NOT NULL,
  notice_period_required_days INTEGER NOT NULL,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','withdrawn','exited')) DEFAULT 'pending',
  initiated_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_employee_separations_user ON employee_separations(user_id);

CREATE TABLE fnf_settlements (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_separation_id INTEGER NOT NULL UNIQUE REFERENCES employee_separations(id) ON DELETE CASCADE,
  unpaid_salary_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  unpaid_salary_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  notice_recovery_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  notice_recovery_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  leave_encashment_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  leave_encashment_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  bonus_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  gratuity_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  reimbursements_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  loan_recovery_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  advance_recovery_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  asset_recovery_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  other_deductions_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  other_deductions_notes TEXT,
  total_earnings DOUBLE PRECISION NOT NULL DEFAULT 0,
  total_deductions DOUBLE PRECISION NOT NULL DEFAULT 0,
  final_payable DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('draft','pending_approval','approved','paid')) DEFAULT 'draft',
  prepared_by INTEGER NOT NULL REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_fnf_settlements_user ON fnf_settlements(user_id);
