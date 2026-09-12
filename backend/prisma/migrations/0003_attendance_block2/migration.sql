-- 0003_attendance_block2
--
-- Additive migration only. Adds the Attendance Management module: shifts,
-- shift assignments, one attendance_records row per employee per day, and
-- correction/regularization requests. Nothing here touches existing tables
-- except adding two new company_holidays-adjacent settings keys, which are
-- written at the application layer (src/db.js updateSettings), not schema.

CREATE TABLE shifts (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  grace_period_minutes INTEGER NOT NULL DEFAULT 10,
  break_minutes INTEGER NOT NULL DEFAULT 60,
  full_day_min_minutes INTEGER NOT NULL DEFAULT 480,
  half_day_min_minutes INTEGER NOT NULL DEFAULT 240,
  is_night_shift INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE shift_assignments (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_shift_assignments_user ON shift_assignments(user_id);

CREATE TABLE attendance_records (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  shift_id INTEGER REFERENCES shifts(id),
  check_in_at TEXT,
  check_out_at TEXT,
  status TEXT NOT NULL CHECK(status IN ('present','absent','half_day','wfh','on_duty','holiday','weekly_off','leave','pending')) DEFAULT 'pending',
  worked_minutes DOUBLE PRECISION NOT NULL DEFAULT 0,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  early_leave_minutes INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL CHECK(source IN ('check_in_out','manual','regularization')) DEFAULT 'check_in_out',
  notes TEXT,
  marked_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'),
  UNIQUE(user_id, date)
);
CREATE INDEX idx_attendance_records_user ON attendance_records(user_id);
CREATE INDEX idx_attendance_records_date ON attendance_records(date);

CREATE TABLE attendance_correction_requests (
  id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  attendance_record_id INTEGER REFERENCES attendance_records(id) ON DELETE SET NULL,
  requested_check_in_at TEXT,
  requested_check_out_at TEXT,
  requested_status TEXT,
  reason TEXT,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')) DEFAULT 'pending',
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX idx_attendance_correction_user ON attendance_correction_requests(user_id);
