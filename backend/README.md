# Vasjo Timesheet Portal — Backend (PostgreSQL + Prisma + Express)

This is the migrated backend: same product (timesheets, leave, approvals,
projects, payroll/tax/payslips), same API contract, running on PostgreSQL via
Prisma and Express instead of SQLite via a hand-rolled `http.createServer`
router. The frontend was **not** touched and needs no changes — every route
path, request shape, response shape, status code, and error `code` string is
preserved.

## What changed vs. the original

- **Database:** SQLite (`node:sqlite` / better-sqlite3-style API) → PostgreSQL.
- **Schema/migrations:** hand-written `CREATE TABLE IF NOT EXISTS` calls on
  every boot → Prisma schema (`prisma/schema.prisma`) + a versioned migration
  (`prisma/migrations/0001_init/migration.sql`).
- **HTTP layer:** a single ~1,400-line `if (pathname === ... && method === ...)`
  router inside `http.createServer` → Express routes in `src/server.js`.
- **Data access:** synchronous SQL calls → async calls through Prisma Client's
  parameterized `$queryRawUnsafe` / `$executeRawUnsafe` / `$transaction`
  (wrapped by `dbGet`/`dbAll`/`dbRun`/`dbInsert`/`withTx` in `src/db.js`). See
  the note at the top of `src/db.js` for why raw parameterized SQL was used
  instead of hand-porting every query to the Prisma query-builder API — in
  short, it's the safest way to carry over already-correct payroll/tax logic
  unchanged during an engine swap.
- **File split** (per the migration brief): `src/db.js` (data access only),
  `src/payroll.js` (all payroll/tax/CTC calculations), `src/reports.js`
  (report aggregation, CSV, and the payslip PDF builder), `src/auth.js`
  (sessions, passwords, CSRF, role checks), `src/utils.js` (generic helpers).
- **Seeding:** the automatic "create demo data if the DB is empty" behavior
  that used to run on every server boot now lives in `prisma/seed.js`, run
  explicitly via `npx prisma db seed` — a boot-time side effect that creates
  data is not appropriate for a real Postgres deployment.
- **Transactions:** operations that touch multiple tables and need to succeed
  or fail together (leave approval + balance update, timesheet save,
  applying for leave, a full payroll run calculation, payslip generation,
  bulk approve/reject, salary revisions, tax declaration submission) are now
  wrapped in real PostgreSQL transactions via `db.withTx()`. The original had
  no transactions at all (SQLite, single connection, best-effort sequential
  writes); this is a net reliability improvement with no behavior change to
  the API surface.

## What did *not* change

- Every route path and HTTP method.
- Every request body / query param shape.
- Every response JSON shape — including field names and the fact that
  boolean-ish flags (`active`, `read`, `escalated`, etc.) are still `0`/`1`
  integers, and every date/timestamp field is still a plain
  `'YYYY-MM-DD'` / `'YYYY-MM-DD HH:MM:SS'` string (not a native Postgres
  timestamp, which node-postgres would otherwise serialize differently).
- All business rules: leave overlap/blackout/balance checks, timesheet
  locking, escalation, CTC → component breakdown, old vs. new tax regime
  slabs, TDS projection/spreading across remaining FY months, payroll run
  status workflow (`draft → calculated → reviewed → approved → locked`),
  payslip generation.
- Error responses: business-rule violations still come back as
  `{ error, code }` with the same `code` strings (`OVERLAP`,
  `INSUFFICIENT_BALANCE`, `PERIOD_LOCKED`, `ALREADY_APPROVED`, etc.).

## One thing that's a re-implementation, not a port

The original hand-rolled payslip PDF writer (in the old `src/server.js`) was
not available to transcribe byte-for-byte during this migration. The new PDF
builder in `src/reports.js` is a faithful re-implementation — same
dependency-free approach (no PDF library), same fields, a comparable
single-page layout — but not guaranteed pixel-identical. If exact visual
parity matters, diff a sample payslip from both backends and adjust the
coordinates in `reports.buildPayslipPdf`.

## Setup

```bash
cp .env.example .env
# edit .env with your PostgreSQL connection string

npm install
npx prisma generate
npx prisma migrate deploy      # applies prisma/migrations/0001_init
npx prisma db seed             # optional: demo users + reference data
npm start                       # listens on PORT (default 3001)
```

Seeded demo accounts (from `prisma/seed.js`, only created if they don't
already exist): `admin@vasjo.com` / `admin123`,
`manager@vasjo.com` / `manager123`, `employee@vasjo.com` / `employee123`.
**Change these in any environment that isn't a throwaway sandbox** —
`must_reset_password` isn't set on them by default because they're meant for
first login during development, not a security control.

## Migrating data from the old SQLite database

If you have a live `timesheet.db` from the original deployment:

```bash
# 1. Apply the schema to an empty target database (see Setup above).
# 2. Run the migration script against it:
node scripts/migrate-sqlite-to-postgres.js /path/to/timesheet.db
```

The script copies every row from every table as-is (no transformation),
wraps the whole import in one Postgres transaction, advances every identity
sequence past the highest imported id, and prints a source-vs-destination
row count comparison so you can confirm nothing was dropped. It is safe to
run against a fresh/empty database only — it doesn't de-duplicate against
existing rows.

## Testing

```bash
npm test
```

`tests/regression.test.js` boots the real Express app on an ephemeral port
and drives it with plain HTTP requests (the same style the original
project's `src/test.js` used), covering auth, CSRF, timesheets, leave
overlap/balance rules, role-based access control, settings, and a full
payroll run (salary structure → tax regime → calculate → approve → payslip
PDF). Point `DATABASE_URL` at a disposable database with the schema applied
and seed data loaded before running — these tests read and write real data.

**Note on this sandbox's own testing:** every file in this backend was
exercised against a real, locally-installed PostgreSQL 16 instance during
development — schema creation, seeding, all the flows above, plus the actual
`scripts/migrate-sqlite-to-postgres.js` run against the real
`timesheet.db` that shipped with the original project (all 36 table row
counts matched exactly afterward). That testing caught and fixed three real
bugs before delivery: a `payroll_details` INSERT with one too few
placeholders, two read-after-write-in-the-same-transaction bugs where a
freshly-committed-but-not-yet-visible row was read through a separate
connection instead of the transaction's own connection, and two migration
script issues (`GENERATED ALWAYS AS IDENTITY` rejecting explicit ids without
`OVERRIDING SYSTEM VALUE`, and a self-referencing foreign key on `users`
needing its triggers temporarily disabled during bulk import). One caveat:
this sandbox's network policy blocks the domain Prisma's CLI normally uses
to download its query engine binary, so the *actual* `@prisma/client`
package's `generate` step could not be run here — testing above used a
drop-in replacement backed by `pg` that implements the same
`$queryRawUnsafe`/`$executeRawUnsafe`/`$transaction` surface, which validated
every SQL statement and all business logic, but you should still run
`npx prisma generate` yourself in an environment with normal internet access
before deploying, and re-run `npm test` there as a final confirmation.

## Project layout

```
prisma/
  schema.prisma                    Prisma schema (source of truth for `prisma generate`/`migrate`)
  migrations/0001_init/migration.sql   Hand-written initial migration (exact DDL, incl. CHECK constraints)
  seed.js                          Demo users + reference data (run via `npx prisma db seed`)
src/
  db.js         Data access layer (Prisma raw-query helpers + CRUD)
  auth.js       Sessions, password hashing, CSRF, role checks
  payroll.js    Payroll/tax/CTC calculation engine
  reports.js    Report aggregation, CSV export, payslip PDF builder
  utils.js      Generic helpers (dates, CSV escaping, timesheet validation)
  server.js     Express app + all routes
scripts/
  migrate-sqlite-to-postgres.js     One-time data migration from the old database
tests/
  regression.test.js               End-to-end API test suite
```
