# Vasjo Technologies HCM Portal

Full-stack employee timesheet, leave, attendance, payroll, compliance, and HR
management application.

The project contains:

- A React/Vite frontend in [`frontend/`](./frontend/)
- An Express/Prisma/PostgreSQL backend in [`backend/`](./backend/)
- Three consolidated Prisma migrations in
  [`backend/prisma/migrations/`](./backend/prisma/migrations/)

## Feature overview

### Authentication and access control

- Email/password login and logout
- Session cookies and CSRF protection
- Password changes and administrator password reset
- Active session listing, revocation, and logout-all
- Role-based access for employees, managers, and administrators
- Tenant memberships, permissions, roles, audit events, and feature flags

### Employee and organization management

- Employee profiles and profile updates
- Departments, managers, delegates, employee codes, and locations
- Organization tree, positions, job families, job grades, and cost centers
- Employee lifecycle history and organization assignments
- Onboarding and offboarding checklists
- Probation start, extension, confirmation, and status transitions
- Employee documents and expiry tracking
- Exit interviews and separation workflows

### Timesheets and projects

- Weekly timesheet creation and editing
- Daily entries, notes, projects, tasks, and work modes
- Draft, pending, approved, rejected, and correction states
- Manager/admin approval and bulk approval
- Escalation and correction workflows
- Project assignments and active/inactive project management

### Leave management

- Leave types and annual balances
- Leave applications, cancellation, approval, rejection, and bulk decisions
- Half-day and hour-based leave
- Department and employee-specific leave policies
- Monthly accrual and year-end carry-forward
- Sandwich leave rules and eligibility waiting periods
- Comp-off requests, approval, expiry, and redemption
- Multi-level leave approvals

### Attendance

- Shift definitions and employee shift assignments
- Check-in and check-out
- Late minutes, break deductions, and automatic attendance status
- Manual attendance marking
- Weekly offs, holidays, monthly calendars, and team views
- Attendance correction requests and approval

### Payroll

- Financial years and payroll runs
- Salary components and employee salary structures
- Formula and conditional salary components
- Tax regimes, slabs, rules, declarations, and proof workflows
- Fixed and variable deductions
- Loans, EMI calculation, and repayments
- Salary advances and payroll recovery
- Salary revisions and arrears
- Leave encashment
- Payslips, payroll exceptions, audit logs, and adjustments
- Payroll dashboard, comparison, variance, and employee reports

### Compliance and full-and-final settlement

- PF, ESI, professional tax, statutory wage, Form 16, and Form 24Q reports
- Employer statutory settings
- Employee separation and notice-period workflows
- Unpaid salary, gratuity, leave encashment, loan/advance recovery
- Full-and-final settlement approval and payment completion

### Enterprise platform

- Recruitment requisitions, candidates, interviews, offers, and conversion
- Performance cycles, goals, reviews, feedback, calibration, and PIPs
- Learning courses, enrollments, certifications, and skills
- Benefits, dependents, and enrollments
- Expense claims, expense lines, approvals, and reimbursement state
- Asset inventory, assignments, and returns
- HR service desk tickets and notes
- Integration connections, sync jobs, webhooks, and vendor adapter boundaries
- Saved reports, analytics, notifications, documents, and workflows
- AI assistant history, document extraction, and payroll anomaly review

## Project structure

```text
.
├── README.md
├── backend/
│   ├── .env                         # Local secrets/configuration; do not commit
│   ├── package.json
│   ├── prisma/
│   │   ├── schema.prisma            # PostgreSQL/Prisma source of truth
│   │   ├── seed.js                  # Development and baseline data
│   │   └── migrations/              # Three ordered migrations
│   ├── scripts/
│   │   └── migrate-sqlite-to-postgres.js
│   ├── src/
│   │   ├── server.js                # Express application and API routes
│   │   ├── db.js                    # Prisma, SQL helpers, transactions, data access
│   │   ├── services.js              # Consolidated domain services
│   └── tests/                       # Unit and regression tests
└── frontend/
    ├── package.json
    ├── vite.config.js               # Vite and /api development proxy
    └── src/
        ├── api.js                   # All frontend-to-backend API calls
        ├── App.jsx                  # Application shell and routing
        ├── components.jsx           # Shared UI components and auth context
        ├── pages.jsx                # Core timesheet, leave, payroll, and admin pages
        ├── advancedPages.jsx        # Platform and advanced HR pages
        ├── enterprisePages.jsx      # Enterprise pages
        ├── main.jsx                 # React entry point
        └── styles.css                # Application styles
```

## Runtime requirements

- Node.js 20 or newer
- npm
- PostgreSQL 14 or newer
- A PostgreSQL database named `vasjo_db`

The current development configuration expects PostgreSQL at
`localhost:5000`. Change `DATABASE_URL` in `backend/.env` if your PostgreSQL
server uses another host or port.

## Configuration

Create `backend/.env` from the following shape. Never commit real passwords,
tokens, encryption keys, or cloud credentials.

```dotenv
NODE_ENV=development
PORT=3000
DATABASE_URL="postgresql://USER:PASSWORD@localhost:5000/vasjo_db?schema=public"
CORS_ORIGIN=http://localhost:5173

DEFAULT_ADMIN_EMAIL=admin@vasjo.in
DEFAULT_ADMIN_PASSWORD=change-this-password

STORAGE_DRIVER=local
STORAGE_ROOT=./private-storage
MAX_FILE_BYTES=52428800
```

Optional integration settings are documented by the existing
[`backend/.env`](./backend/.env) template and include Redis, S3-compatible
storage, Google/Microsoft OAuth, ClamAV, and application encryption settings.

## Installation

From the project root:

```powershell
cd C:\path\to\claude

cd backend
npm.cmd install

cd ..\frontend
npm.cmd install
```

On systems where PowerShell blocks `npm.ps1`, use `npm.cmd` as shown above.

## Database setup

The migration history is consolidated into three migrations:

1. `0001_core_modules`
2. `0002_enterprise_foundation`
3. `0003_platform_and_status`

For a new database:

```powershell
cd C:\path\to\claude\backend
npm.cmd run prisma:generate
npm.cmd run prisma:migrate
npm.cmd run prisma:seed
```

The seed command creates baseline tenant, role, permission, settings, leave,
and development user data. Use the configured development administrator
credentials only in a local environment and change them before deployment.

### Existing databases

The migration directory was intentionally consolidated. A database that
already recorded the former migration names must be backed up and
re-baselined before deploying the new three-migration history. Do not delete
the Prisma migration table or run destructive reset commands against
production data without a verified backup and an explicit migration plan.

## Running the application

Start the backend:

```powershell
cd C:\path\to\claude\backend
npm.cmd start
```

The API listens on `http://localhost:3000` by default.

Start the frontend in a second terminal:

```powershell
cd C:\path\to\claude\frontend
npm.cmd run dev
```

The frontend runs on `http://localhost:5173`. Vite proxies `/api` requests to
`http://localhost:3000` by default. To use another backend URL:

```powershell
$env:VITE_API_PROXY_TARGET="http://localhost:3000"
npm.cmd run dev
```

For a production frontend bundle:

```powershell
cd C:\path\to\claude\frontend
npm.cmd run build
npm.cmd run preview
```

## Backend commands

Run these from `backend/`:

```powershell
npm.cmd start                  # Start the API
npm.cmd run dev                # Start the API with Node watch mode
npm.cmd run prisma:generate   # Generate Prisma Client
npm.cmd run prisma:migrate    # Deploy committed migrations
npm.cmd run prisma:seed       # Seed baseline data
npm.cmd exec prisma migrate status
npm.cmd run migrate:from-sqlite
npm.cmd test                   # Unit and regression tests
```

Useful direct Prisma commands:

```powershell
npm.cmd exec prisma validate
npm.cmd exec prisma format
npm.cmd exec prisma migrate status
```

## Frontend commands

Run these from `frontend/`:

```powershell
npm.cmd run dev
npm.cmd run build
npm.cmd run preview
```

## Testing and validation

Recommended validation order:

```powershell
cd C:\path\to\claude\backend
npm.cmd exec prisma validate
npm.cmd run prisma:generate
npm.cmd run prisma:migrate
npm.cmd run prisma:seed
npm.cmd test

cd ..\frontend
npm.cmd run build
```

The backend test suite uses Node's built-in test runner and is intentionally
kept in two files:

- [`backend/tests/unit.test.js`](./backend/tests/unit.test.js) contains the
  attendance, compliance, full-and-final settlement, leave, lifecycle, and
  payroll domain tests.
- [`backend/tests/regression.test.js`](./backend/tests/regression.test.js)
  contains the Express/API regression tests and frontend-compatible request
  flows.

Together these files contain the complete suite: 131 tests in total, including
shared password, integration-adapter, file-validation, and storage-hash
coverage.

Database-backed tests, migrations, seed, login, and full API flows require
PostgreSQL to be running and reachable through `DATABASE_URL`.

## API and data contracts

- The frontend API boundary is centralized in
  [`frontend/src/api.js`](./frontend/src/api.js).
- Express routes are registered in
  [`backend/src/server.js`](./backend/src/server.js).
- Database access and request transactions are in
  [`backend/src/db.js`](./backend/src/db.js).
- Domain behavior is consolidated in
  [`backend/src/services.js`](./backend/src/services.js).
- Prisma models and database field mappings are in
  [`backend/prisma/schema.prisma`](./backend/prisma/schema.prisma).
- Dates remain API-compatible text values (`YYYY-MM-DD` and
  `YYYY-MM-DD HH:MM:SS`) where required by the existing frontend contract.
- PostgreSQL numeric columns are represented with appropriate Prisma numeric
  types; identifiers and request query parameters are validated/coerced at
  the backend boundary.

## Security and deployment notes

- Replace all development secrets before deployment.
- Use HTTPS in production.
- Set a strong `APP_ENCRYPTION_KEY` and JWT/session secrets.
- Use a managed PostgreSQL instance with backups.
- Configure `STORAGE_DRIVER=s3` for durable production document storage.
- Restrict CORS to the deployed frontend origin.
- Review `npm audit` output before production deployment.
- Do not expose `.env`, `private-storage`, database credentials, or generated
  local files in source control.
