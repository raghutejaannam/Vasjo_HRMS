// src/reports.js — report aggregation, CSV export, and the payslip PDF
// builder. Ported from the reporting section of src/db.js and the
// hand-rolled PDF writer that used to live in src/server.js.
//
// NOTE on the PDF builder: the original server.js built payslip PDFs with a
// hand-written, dependency-free PDF byte writer (raw content stream +
// manual xref table). That exact drawing-command sequence was not
// available to re-transcribe verbatim during this migration, so the
// version below is a faithful re-implementation — same payslip fields and a
// comparable single-page layout, produced with the same
// no-external-dependency approach — rather than a byte-for-byte port. If
// pixel-identical output matters (e.g. for a template already distributed
// to employees), diff a sample payslip from the old and new backends and
// adjust the coordinates below.

const db = require('./db');
const { csvEscape, genericCsv } = require('./utils');

// ---------------------------------------------------------------------------
// CSV EXPORTS
// ---------------------------------------------------------------------------

function timesheetsToCsv(rows) {
  const header = ['id', 'user_name', 'week_start', 'status', 'total_hours', 'overtime_hours', 'submitted_at', 'decided_at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map(h => csvEscape(r[h])).join(','));
  }
  return lines.join('\n');
}

function leaveToCsv(rows) {
  const header = ['id', 'user_name', 'from_date', 'to_date', 'days', 'status', 'reason', 'applied_at', 'decided_at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map(h => csvEscape(r[h])).join(','));
  }
  return lines.join('\n');
}

function payrollDetailsToCsv(rows) {
  const header = ['user_name', 'employee_code', 'basic_earning', 'hra_earning', 'allowances_earning', 'gross_earning',
    'pf_employee_deduction', 'professional_tax_deduction', 'tds_deduction', 'total_deductions', 'net_salary', 'status'];
  const lines = [header.join(',')];
  for (const r of rows) lines.push(header.map(h => csvEscape(r[h])).join(','));
  return lines.join('\n');
}

function reportRowsToCsv(rows) {
  return genericCsv(rows);
}

// ---------------------------------------------------------------------------
// REPORT AGGREGATIONS
// ---------------------------------------------------------------------------

async function reportProjectHours(from, to) {
  // The UI expects one row per project + employee with an `hours` field.
  // The previous PostgreSQL port grouped only by project and returned
  // `timesheet_count`, which made the report render blank/incorrect data.
  return db.dbAll(`
    SELECT p.name AS project_name, u.name AS user_name,
      COALESCE(SUM(te.hours), 0) AS hours
    FROM timesheet_entries te
    JOIN timesheets t ON t.id = te.timesheet_id AND t.status = 'approved'
    JOIN users u ON u.id = t.user_id
    LEFT JOIN projects p ON p.id = te.project_id
    WHERE te.entry_date BETWEEN ? AND ?
    GROUP BY p.id, p.name, u.id, u.name
    ORDER BY hours DESC, u.name, p.name
  `, [from, to]);
}

async function reportEmployeeUtilization(from, to, managerScope) {
  let where = "WHERE u.active = 1 AND t.status = 'approved' AND t.week_start BETWEEN ? AND ?";
  let params = [from, to];
  if (managerScope && managerScope.length) {
    where += ` AND u.manager_id IN (${managerScope.map(() => '?').join(',')})`;
    params = [...params, ...managerScope];
  }

  const rows = await db.dbAll(`
    SELECT u.name AS user_name, u.dept,
      COALESCE(SUM(t.total_hours), 0) AS total_hours,
      COALESCE(SUM(t.overtime_hours), 0) AS overtime_hours,
      COUNT(t.id) AS weeks_submitted
    FROM users u
    JOIN timesheets t ON t.user_id = u.id
    ${where}
    GROUP BY u.id, u.name, u.dept
    ORDER BY total_hours DESC
  `, params);

  // Calculate utilization against expected working hours in the selected
  // calendar range. This keeps the report meaningful for partial months.
  const settings = await db.getSettings();
  const hoursPerDay = Number(settings.standard_hours_per_day) || 8;
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  let workingDays = 0;
  if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && start <= end) {
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.getDay();
      if (day !== 0 && day !== 6) workingDays++;
    }
  }
  const expectedHours = Math.max(workingDays * hoursPerDay, 1);
  return rows.map((row) => ({
    ...row,
    utilization_pct: Math.round((Number(row.total_hours || 0) / expectedHours) * 10000) / 100,
  }));
}

async function reportLeaveUsage(year, managerScope) {
  let where = 'WHERE lb.year = ?';
  let params = [year];
  if (managerScope && managerScope.length) {
    where += ` AND u.manager_id IN (${managerScope.map(() => '?').join(',')})`;
    params = [...params, ...managerScope];
  }

  return db.dbAll(`
    SELECT u.name AS user_name, lt.name AS type_name,
      lb.total_days, lb.used_days,
      COALESCE((
        SELECT SUM(la.days)
        FROM leave_applications la
        WHERE la.user_id = lb.user_id
          AND la.leave_type_id = lb.leave_type_id
          AND la.status = 'pending'
          AND substr(la.from_date, 1, 4) = CAST(lb.year AS TEXT)
      ), 0) AS pending_days,
      (lb.total_days - lb.used_days) AS remaining_days
    FROM leave_balances lb
    JOIN users u ON u.id = lb.user_id
    JOIN leave_types lt ON lt.id = lb.leave_type_id
    ${where}
    ORDER BY u.name, lt.name
  `, params);
}

async function reportTimesheetCompliance(from, to, managerScope) {
  let where = 'WHERE u.active = 1';
  let params = [];
  if (managerScope && managerScope.length) {
    where += ` AND u.manager_id IN (${managerScope.map(() => '?').join(',')})`;
    params = managerScope;
  }

  // Compliance is a per-employee report. The UI needs email + a status for
  // the selected week/range, not aggregate counts.
  return db.dbAll(`
    SELECT u.name AS user_name, u.email,
      COALESCE(
        (
          SELECT t.status
          FROM timesheets t
          WHERE t.user_id = u.id
            AND t.week_start BETWEEN ? AND ?
          ORDER BY t.week_start DESC
          LIMIT 1
        ),
        'not submitted'
      ) AS status
    FROM users u
    ${where}
    ORDER BY u.name
  `, [from, to, ...params]);
}

async function reportPendingApprovals(managerScope) {
  let tsWhere = "WHERE t.status = 'pending'";
  let lvWhere = "WHERE l.status = 'pending'";
  let params = [];
  if (managerScope && managerScope.length) {
    const placeholders = managerScope.map(() => '?').join(',');
    tsWhere += ` AND u.manager_id IN (${placeholders})`;
    lvWhere += ` AND u.manager_id IN (${placeholders})`;
    params = managerScope;
  }

  const timesheets = await db.dbAll(`
    SELECT t.id, u.name AS user_name, m.name AS manager_name,
      t.week_start, t.submitted_at, t.escalated
    FROM timesheets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN users m ON m.id = u.manager_id
    ${tsWhere}
    ORDER BY t.submitted_at
  `, params);

  const leave = await db.dbAll(`
    SELECT l.id, u.name AS user_name, m.name AS manager_name,
      l.from_date, l.to_date, l.applied_at, l.escalated
    FROM leave_applications l
    JOIN users u ON u.id = l.user_id
    LEFT JOIN users m ON m.id = u.manager_id
    ${lvWhere}
    ORDER BY l.applied_at
  `, params);

  const now = Date.now();
  const daysSince = (ts) => (ts
    ? Math.max(0, Math.floor((now - new Date(String(ts).replace(' ', 'T') + 'Z').getTime()) / 86400000))
    : 0);
  timesheets.forEach((t) => { t.days_pending = daysSince(t.submitted_at); });
  leave.forEach((l) => { l.days_pending = daysSince(l.applied_at); });
  return { timesheets, leave };
}

async function reportPayrollSummary(payrollRunId) {
  const run = await db.getPayrollRun(payrollRunId);
  const details = await db.listPayrollDetails(payrollRunId);
  return { run, details };
}

// ---------------------------------------------------------------------------
// MINIMAL, DEPENDENCY-FREE PDF WRITER (Helvetica text + simple lines/rects)
// ---------------------------------------------------------------------------

class PdfDoc {
  constructor(widthPt = 595, heightPt = 842) {
    this.width = widthPt;
    this.height = heightPt;
    this.content = [];
  }

  text(x, y, str, { size = 10, bold = false, align = 'left' } = {}) {
    const font = bold ? '/F2' : '/F1';
    const escaped = pdfEscape(str);
    let xPos = x;
    const strLen = String(str == null ? '' : str).length;
    if (align === 'right') xPos = x - strLen * size * 0.5;
    else if (align === 'center') xPos = x - (strLen * size * 0.5) / 2;
    this.content.push(`BT ${font} ${size} Tf ${xPos.toFixed(2)} ${(this.height - y).toFixed(2)} Td (${escaped}) Tj ET`);
  }

  line(x1, y1, x2, y2, width = 0.6) {
    this.content.push(`${width} w ${x1.toFixed(2)} ${(this.height - y1).toFixed(2)} m ${x2.toFixed(2)} ${(this.height - y2).toFixed(2)} l S`);
  }

  rect(x, y, w, h, { fill = false, stroke = true } = {}) {
    const op = fill && stroke ? 'B' : fill ? 'f' : 'S';
    this.content.push(`${x.toFixed(2)} ${(this.height - y - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${op}`);
  }

  build() {
    const streamText = this.content.join('\n');
    const streamLen = Buffer.byteLength(streamText, 'utf8');

    const objs = [];
    objs.push('<< /Type /Catalog /Pages 2 0 R >>'); // 1
    objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'); // 2
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${this.width} ${this.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`); // 3
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'); // 4
    objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'); // 5
    objs.push(`<< /Length ${streamLen} >>\nstream\n${streamText}\nendstream`); // 6

    let out = '%PDF-1.4\n';
    const offsets = [0];
    for (let i = 0; i < objs.length; i++) {
      offsets.push(Buffer.byteLength(out, 'utf8'));
      out += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
    }
    const xrefStart = Buffer.byteLength(out, 'utf8');
    out += `xref\n0 ${objs.length + 1}\n`;
    out += '0000000000 65535 f \n';
    for (let i = 1; i <= objs.length; i++) {
      out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }
}

function pdfEscape(str) {
  return String(str == null ? '' : str).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function moneyPdf(value) {
  const n = Number(value) || 0;
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function datePdf(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

function monthLabelPdf(payrollMonth) {
  const [y, m] = payrollMonth.split('-').map(Number);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${months[m - 1]} ${y}`;
}

// data: { detail, run, user, financialYear, components, settings } — see
// payroll.preparePayslipData().
function buildPayslipPdf(data) {
  const { detail, run, user, settings } = data;
  const doc = new PdfDoc();
  const companyName = (settings && settings.company_name) || 'Vasjo Technologies';

  doc.text(40, 50, companyName, { size: 16, bold: true });
  doc.text(40, 68, 'Payslip', { size: 11 });
  doc.text(555, 50, monthLabelPdf(run.payroll_month), { size: 11, align: 'right' });
  doc.line(40, 80, 555, 80);

  doc.text(40, 105, 'Employee Name:', { size: 9, bold: true });
  doc.text(160, 105, user.name, { size: 9 });
  doc.text(320, 105, 'Employee Code:', { size: 9, bold: true });
  doc.text(430, 105, user.employee_code || '-', { size: 9 });

  doc.text(40, 122, 'Department:', { size: 9, bold: true });
  doc.text(160, 122, user.dept || '-', { size: 9 });
  doc.text(320, 122, 'PAN:', { size: 9, bold: true });
  doc.text(430, 122, user.pan || '-', { size: 9 });

  doc.text(40, 139, 'Bank Account:', { size: 9, bold: true });
  doc.text(160, 139, user.bank_account_no || '-', { size: 9 });
  doc.text(320, 139, 'UAN:', { size: 9, bold: true });
  doc.text(430, 139, user.uan || '-', { size: 9 });

  doc.line(40, 155, 555, 155);

  let y = 180;
  doc.text(40, y, 'Earnings', { size: 10, bold: true });
  doc.text(320, y, 'Deductions', { size: 10, bold: true });
  y += 20;

  const earningsRows = [
    ['Basic', detail.basic_earning],
    ['HRA', detail.hra_earning],
    ['Allowances', detail.allowances_earning],
    ['Variable Pay', detail.variable_earning],
    ['Overtime', detail.overtime_earning],
    ['Bonus', detail.bonus_earning],
    ['Reimbursements', detail.reimbursement_earning],
    ['Other Earnings', detail.other_earning],
  ].filter(r => Number(r[1]) > 0);

  const deductionRows = [
    ['Provident Fund', detail.pf_employee_deduction],
    ['Professional Tax', detail.professional_tax_deduction],
    ['Insurance', detail.insurance_deduction],
    ['Other Deductions', detail.other_fixed_deduction],
    ['Variable Deductions', detail.variable_deductions_total],
    ['Income Tax (TDS)', detail.tds_deduction],
  ].filter(r => Number(r[1]) > 0);

  const rowCount = Math.max(earningsRows.length, deductionRows.length);
  for (let i = 0; i < rowCount; i++) {
    if (earningsRows[i]) {
      doc.text(40, y, earningsRows[i][0], { size: 9 });
      doc.text(300, y, moneyPdf(earningsRows[i][1]), { size: 9, align: 'right' });
    }
    if (deductionRows[i]) {
      doc.text(320, y, deductionRows[i][0], { size: 9 });
      doc.text(555, y, moneyPdf(deductionRows[i][1]), { size: 9, align: 'right' });
    }
    y += 16;
  }

  y += 10;
  doc.line(40, y, 555, y);
  y += 20;
  doc.text(40, y, 'Gross Earnings', { size: 9, bold: true });
  doc.text(300, y, moneyPdf(detail.gross_earning), { size: 9, bold: true, align: 'right' });
  doc.text(320, y, 'Total Deductions', { size: 9, bold: true });
  doc.text(555, y, moneyPdf(detail.total_deductions), { size: 9, bold: true, align: 'right' });

  y += 30;
  doc.rect(40, y - 14, 515, 26);
  doc.text(50, y + 4, 'Net Salary', { size: 11, bold: true });
  doc.text(545, y + 4, `Rs. ${moneyPdf(detail.net_salary)}`, { size: 11, bold: true, align: 'right' });

  y += 45;
  doc.text(40, y, `Paid Days: ${detail.paid_days} / ${detail.working_days}  |  Loss of Pay Days: ${detail.lop_days}`, { size: 8 });
  y += 30;
  doc.text(40, y, 'This is a system-generated payslip and does not require a signature.', { size: 7 });

  return doc.build();
}

module.exports = {
  timesheetsToCsv,
  leaveToCsv,
  payrollDetailsToCsv,
  genericCsv,
  reportRowsToCsv,
  reportProjectHours,
  reportEmployeeUtilization,
  reportLeaveUsage,
  reportTimesheetCompliance,
  reportPendingApprovals,
  reportPayrollSummary,
  buildPayslipPdf,
  moneyPdf,
  datePdf,
  monthLabelPdf,
};
