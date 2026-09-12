-- 0006_leave_block3
--
-- Additive migration only. Extends the existing leave_applications /
-- leave_balances tables with a few new columns (unit, sandwich flag,
-- comp-off link, multi-level approval tracking; carried-forward days +
-- expiry) and adds three new tables: leave_policies (employee/department-
-- specific overrides of a leave type's defaults), comp_offs, and
-- leave_approvals (the per-level audit trail for multi-level approval).

ALTER TABLE leave_applications ADD COLUMN unit TEXT NOT NULL DEFAULT 'day';
ALTER TABLE leave_applications ADD COLUMN is_sandwich INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leave_applications ADD COLUMN comp_off_id INTEGER;
ALTER TABLE leave_applications ADD COLUMN current_approval_level INTEGER NOT NULL DEFAULT 1;
ALTER TABLE leave_applications ADD COLUMN required_approval_levels INTEGER NOT NULL DEFAULT 1;

ALTER TABLE leave_balances ADD COLUMN carried_forward_days DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE leave_balances ADD COLUMN carry_forward_expires_on TEXT;

CREATE TABLE leave_policies (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leave_type_id INTEGER NOT NULL REFERENCES leave_types(id) ON DELETE CASCADE,
  department_name TEXT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  annual_days DOUBLE PRECISION NOT NULL,
  accrual_method TEXT NOT NULL CHECK(accrual_method IN ('annual','monthly')) DEFAULT 'annual',
  monthly_accrual_days DOUBLE PRECISION,
  carry_forward_enabled INTEGER NOT NULL DEFAULT 0,
  max_carry_forward_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  carry_forward_expiry_months INTEGER NOT NULL DEFAULT 3,
  min_service_days_before_eligible INTEGER NOT NULL DEFAULT 0,
  allow_negative_balance INTEGER NOT NULL DEFAULT 0,
  max_negative_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  is_sandwich_leave INTEGER NOT NULL DEFAULT 0,
  unit TEXT NOT NULL CHECK(unit IN ('day','hour')) DEFAULT 'day',
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_leave_policies_type ON leave_policies(leave_type_id);

CREATE TABLE comp_offs (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  worked_date TEXT NOT NULL,
  earned_days DOUBLE PRECISION NOT NULL DEFAULT 1,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','used','expired')) DEFAULT 'pending',
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  expires_on TEXT,
  used_in_application_id TEXT REFERENCES leave_applications(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_comp_offs_user ON comp_offs(user_id);

CREATE TABLE leave_approvals (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  leave_application_id TEXT NOT NULL REFERENCES leave_applications(id) ON DELETE CASCADE,
  level INTEGER NOT NULL,
  approver_id INTEGER NOT NULL REFERENCES users(id),
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  comment TEXT,
  decided_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_leave_approvals_application ON leave_approvals(leave_application_id);
