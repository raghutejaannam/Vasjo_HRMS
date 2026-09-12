#!/usr/bin/env node
// scripts/migrate-sqlite-to-postgres.js
//
// One-time data migration: reads every row out of the legacy SQLite database
// (src/timesheet.db from the original project) and inserts it into the new
// PostgreSQL database (via Prisma's raw-query API) using the exact same
// column values — no data transformation, renaming, or filtering.
//
// Usage:
//   node scripts/migrate-sqlite-to-postgres.js /path/to/timesheet.db
//
// Prerequisites:
//   1. DATABASE_URL points at the target Postgres database.
//   2. The schema has already been created there (`npx prisma migrate deploy`
//      or by applying prisma/migrations/0001_init/migration.sql directly).
//   3. The target tables are empty (this script does not de-duplicate;
//      re-running it against a non-empty database will violate unique
//      constraints and is intentionally not handled automatically).
//
// The script prints a per-table row count comparison at the end so you can
// verify nothing was dropped, and wraps the whole import in a single
// transaction — if anything fails, nothing is committed.

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PrismaClient } = require('@prisma/client');

const SQLITE_PATH = process.argv[2] || path.join(__dirname, '..', '..', 'timesheet.db');

// Order matters: parents before children (matches the FK dependency graph in
// prisma/migrations/0001_init/migration.sql).
const TABLES_IN_ORDER = [
  'users',
  'sessions',
  'leave_types',
  'leave_balances',
  'projects',
  'tasks',
  'employee_projects',
  'departments',
  'timesheets',
  'timesheet_entries',
  'leave_applications',
  'approvals_log',
  'company_holidays',
  'settings',
  'notifications',
  'financial_years',
  'salary_components',
  'employee_salary_structures',
  'salary_structure_components',
  'tax_regimes',
  'tax_slabs',
  'tax_rules',
  'deduction_limits',
  'employee_tax_regime',
  'tax_declaration_sections',
  'tax_declarations',
  'tax_declaration_entries',
  'fixed_deductions',
  'variable_deductions',
  'previous_employer_income',
  'payroll_runs',
  'payroll_details',
  'payslips',
  'payroll_exceptions',
  'payroll_audit_log',
  'payroll_adjustments',
  'salary_revisions',
];

// Sequences created by `GENERATED ALWAYS AS IDENTITY` need to be advanced
// past the highest imported id, or the next INSERT from the app will collide.
const SEQUENCE_TABLES = TABLES_IN_ORDER.filter(t => !['sessions', 'timesheets', 'timesheet_entries', 'leave_applications', 'settings'].includes(t))
  .concat(['timesheet_entries']); // timesheet_entries has a serial id even though timesheets doesn't

async function main() {
  console.log(`Reading from SQLite database: ${SQLITE_PATH}`);
  const sqlite = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  const prisma = new PrismaClient();

  const sourceCounts = {};
  const destCounts = {};

  try {
    await prisma.$transaction(async (tx) => {
      for (const table of TABLES_IN_ORDER) {
        const rows = sqlite.prepare(`SELECT * FROM "${table}"`).all();
        sourceCounts[table] = rows.length;
        if (rows.length === 0) { destCounts[table] = 0; continue; }

        const columns = Object.keys(rows[0]);
        const colList = columns.map(c => `"${c}"`).join(', ');
        const overriding = columns.includes('id') ? ' OVERRIDING SYSTEM VALUE' : '';

        // Some tables (users.manager_id/delegate_id) self-reference their own
        // table, and SQLite's row order gives no guarantee a referenced row
        // was already inserted. Rather than reorder/topologically-sort rows,
        // disable this table's own FK triggers for the duration of its
        // import, then re-enable before moving to tables that depend on it.
        await tx.$executeRawUnsafe(`ALTER TABLE "${table}" DISABLE TRIGGER ALL`);
        try {
          for (const row of rows) {
            const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
            const values = columns.map(c => row[c]);
            await tx.$executeRawUnsafe(`INSERT INTO "${table}" (${colList})${overriding} VALUES (${placeholders})`, ...values);
          }
        } finally {
          await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE TRIGGER ALL`);
        }
        const countRow = await tx.$queryRawUnsafe(`SELECT COUNT(*)::int AS n FROM "${table}"`);
        destCounts[table] = countRow[0].n;
        console.log(`  ${table}: migrated ${rows.length} row(s)`);
      }

      // Advance every SERIAL/IDENTITY sequence past the max imported id so
      // the application's own inserts don't collide with migrated ids.
      for (const table of new Set(SEQUENCE_TABLES)) {
        await tx.$executeRawUnsafe(`
          SELECT setval(
            pg_get_serial_sequence('"${table}"', 'id'),
            COALESCE((SELECT MAX(id) FROM "${table}"), 1),
            (SELECT MAX(id) FROM "${table}") IS NOT NULL
          )
        `);
      }
    }, { timeout: 5 * 60 * 1000 });

    console.log('\nRow count comparison (source SQLite -> destination Postgres):');
    let mismatch = false;
    for (const table of TABLES_IN_ORDER) {
      const s = sourceCounts[table] || 0;
      const d = destCounts[table] || 0;
      const flag = s === d ? 'OK' : 'MISMATCH';
      if (s !== d) mismatch = true;
      console.log(`  ${table.padEnd(30)} ${String(s).padStart(6)} -> ${String(d).padStart(6)}  ${flag}`);
    }
    if (mismatch) {
      console.error('\nRow count mismatch detected — investigate before trusting this migration.');
      process.exitCode = 1;
    } else {
      console.log('\nAll table row counts match. Migration complete.');
    }
  } finally {
    sqlite.close();
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exitCode = 1;
});
