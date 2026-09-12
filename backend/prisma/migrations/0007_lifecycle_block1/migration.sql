-- 0007_lifecycle_block1
--
-- Additive migration only. Adds one column to users (lifecycle_status) and
-- six new tables. employee_lifecycle_events is deliberately a single
-- append-only timeline covering employment history, department/designation/
-- manager/location changes, promotions, probation milestones, and status
-- changes — one table instead of five near-identical ones. Resignation/exit
-- itself is already tracked by employee_separations (Block 6); this
-- migration adds exit_interviews and offboarding checklist tasks as the
-- pieces of Block 1 that specifically attach to that.

ALTER TABLE users ADD COLUMN lifecycle_status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE employee_lifecycle_events (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'joined','department_transfer','designation_change','manager_change','location_change',
    'promotion','probation_started','probation_confirmed','probation_extended','status_change','resigned','exited'
  )),
  previous_value TEXT,
  new_value TEXT,
  effective_date TEXT NOT NULL,
  notes TEXT,
  recorded_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_lifecycle_events_user ON employee_lifecycle_events(user_id);

CREATE TABLE probation_records (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_date TEXT NOT NULL,
  expected_end_date TEXT NOT NULL,
  actual_confirmation_date TEXT,
  status TEXT NOT NULL CHECK(status IN ('on_probation','confirmed','extended')) DEFAULT 'on_probation',
  extended_to_date TEXT,
  notes TEXT,
  confirmed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_probation_records_user ON probation_records(user_id);

CREATE TABLE employee_documents (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL,
  file_path TEXT,
  issue_date TEXT,
  expiry_date TEXT,
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_employee_documents_user ON employee_documents(user_id);
CREATE INDEX idx_employee_documents_expiry ON employee_documents(expiry_date);

CREATE TABLE checklist_template_items (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('onboarding','offboarding')),
  label TEXT NOT NULL,
  description TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE employee_checklist_tasks (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employee_separation_id INTEGER REFERENCES employee_separations(id) ON DELETE CASCADE,
  template_item_id INTEGER REFERENCES checklist_template_items(id),
  type TEXT NOT NULL CHECK(type IN ('onboarding','offboarding')),
  label TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','completed','skipped')) DEFAULT 'pending',
  completed_by INTEGER REFERENCES users(id),
  completed_at TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_checklist_tasks_user ON employee_checklist_tasks(user_id);

CREATE TABLE exit_interviews (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  employee_separation_id INTEGER NOT NULL UNIQUE REFERENCES employee_separations(id) ON DELETE CASCADE,
  conducted_by INTEGER NOT NULL REFERENCES users(id),
  conducted_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  reason_for_leaving TEXT,
  feedback TEXT,
  would_rehire INTEGER,
  rating INTEGER,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

-- A small, sensible default checklist so the feature isn't empty out of the box.
INSERT INTO checklist_template_items (type, label, description, display_order) VALUES
  ('onboarding', 'Collect signed offer letter', 'Countersigned copy on file', 1),
  ('onboarding', 'Collect ID & address proof', 'PAN, Aadhar or equivalent', 2),
  ('onboarding', 'Set up payroll bank details', 'Bank account and IFSC captured', 3),
  ('onboarding', 'Provision system access', 'Email, tools, building access', 4),
  ('onboarding', 'Assign onboarding buddy / manager intro', NULL, 5),
  ('offboarding', 'Knowledge transfer completed', NULL, 1),
  ('offboarding', 'Return company assets', 'Laptop, ID card, access cards', 2),
  ('offboarding', 'Revoke system access', NULL, 3),
  ('offboarding', 'Exit interview conducted', NULL, 4),
  ('offboarding', 'Full & final settlement processed', NULL, 5);
