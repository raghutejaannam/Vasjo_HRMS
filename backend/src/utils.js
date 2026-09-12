// src/utils.js — genuinely shared helpers used across the backend.
// Ported as-is from the original src/db.js / src/server.js (SQLite/custom-HTTP
// version) — logic unchanged, only relocated.

// parseInt(x) || fallback is a common trap: it silently replaces a legitimate
// 0 with the fallback, since 0 is falsy in JS. Settings like escalation_days
// or timesheet_lock_weeks can validly be 0 (e.g. "escalate immediately",
// "no grace period"), so this checks for NaN specifically instead.
function numSetting(value, fallback) {
  const n = parseFloat(value);
  return Number.isNaN(n) ? fallback : n;
}

// Produces the exact same 'YYYY-MM-DD HH:MM:SS' (UTC) text SQLite's
// datetime('now') used to produce. Stored in TEXT columns and returned
// verbatim to the frontend, so the format must not change.
function nowStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// Same format, offset by a number of days (used for escalation windows and
// other "older than N days" comparisons that used to be
// datetime('now', '-N days') in SQLite).
function nowStrOffsetDays(days) {
  const d = new Date(Date.now() + days * 86400000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function todayStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function genericCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  return [headers.join(','), ...rows.map(r => headers.map(h => csvEscape(r[h])).join(','))].join('\n');
}

function daysInYear(year) {
  return ((year % 4 === 0 && year % 100 !== 0) || year % 400 === 0) ? 366 : 365;
}

// Prorate annual leave from the employee's joining date. A missing joining
// date keeps the configured annual entitlement unchanged.
function proratedAnnualLeave(joinedDate, annualDays, year) {
  if (!joinedDate || !annualDays) return Number(annualDays || 0);
  const joined = new Date(joinedDate + 'T00:00:00');
  if (Number.isNaN(joined.getTime())) return Number(annualDays || 0);
  const start = new Date(year, 0, 1);
  const end = new Date(year, 11, 31);
  if (joined > end) return 0;
  const effectiveStart = joined > start ? joined : start;
  const eligibleDays = Math.floor((end - effectiveStart) / 86400000) + 1;
  return Math.round((annualDays * eligibleDays / daysInYear(year)) * 2) / 2;
}

function businessDaysBetween(fromStr, toStr) {
  const from = new Date(fromStr + 'T00:00:00');
  const to = new Date(toStr + 'T00:00:00');
  let count = 0;
  const d = new Date(from);
  while (d <= to) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

// Converts "HH:MM" (24-hour, what <input type="time"> sends) to minutes since
// midnight. Returns null if not a valid time string.
function parseTimeToMinutes(t) {
  if (!t || typeof t !== 'string') return null;
  const m = TIME_RE.exec(t.trim());
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// The only place that turns an in_time/out_time pair into decimal hours.
// Server-side is the source of truth — never trusts client-computed hours —
// so a tampered or buggy client can't inflate a timesheet.
function computeRowHours(inTime, outTime) {
  const inMin = parseTimeToMinutes(inTime);
  const outMin = parseTimeToMinutes(outTime);
  if (inMin === null || outMin === null) return 0;
  const diff = (outMin - inMin) / 60;
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
}

// A row counts as "provided" if the person has started filling it in at all —
// used to tell "empty placeholder row" apart from "row with a real mistake".
function rowHasContent(e) {
  return !!(e.inTime || e.outTime || (e.note && e.note.trim()));
}

function validateEntriesBasic(entries) {
  for (const e of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) {
      const err = new Error(`Invalid date: ${e.date}`);
      err.code = 'INVALID_DATE';
      throw err;
    }
    if (!rowHasContent(e)) continue; // blank row, nothing to validate
    const inMin = parseTimeToMinutes(e.inTime);
    const outMin = parseTimeToMinutes(e.outTime);
    if (inMin === null || outMin === null) {
      const err = new Error(`Both In Time and Out Time are required for ${e.date}`);
      err.code = 'INCOMPLETE_TIME_ROW';
      throw err;
    }
    if (outMin <= inMin) {
      const err = new Error(`Out Time must be after In Time on ${e.date}`);
      err.code = 'INVALID_TIME_RANGE';
      throw err;
    }
    const hours = (outMin - inMin) / 60;
    if (hours > 24) {
      const err = new Error(`That's more than 24 hours in a single entry on ${e.date}`);
      err.code = 'INVALID_HOURS';
      throw err;
    }
  }
}

function validateEntriesForSubmit(entries) {
  validateEntriesBasic(entries);
}

// ---------------------------------------------------------------------------
// SAFE ARITHMETIC FORMULA EVALUATOR — used by salary components whose
// calculation_type is 'formula' (e.g. "monthlyBasic*0.4 + 500"). This is a
// hand-rolled recursive-descent parser over +,-,*,/,(),numbers and a
// whitelisted set of variable names — never eval()/Function() on
// user-supplied text, since formulas are admin-entered but still untrusted
// input as far as code execution is concerned.
// ---------------------------------------------------------------------------

function evaluateArithmeticFormula(formula, variables = {}) {
  const src = String(formula || '').trim();
  if (!src) throw new Error('Empty formula');
  let pos = 0;

  function peek() { return src[pos]; }
  function isDigit(c) { return c >= '0' && c <= '9'; }
  function isIdentStart(c) { return /[A-Za-z_]/.test(c); }
  function isIdentChar(c) { return /[A-Za-z0-9_]/.test(c); }
  function skipWs() { while (pos < src.length && /\s/.test(src[pos])) pos++; }

  function parseNumber() {
    let start = pos;
    while (pos < src.length && (isDigit(src[pos]) || src[pos] === '.')) pos++;
    const text = src.slice(start, pos);
    if (!text || Number.isNaN(Number(text))) throw new Error(`Invalid number near "${text}" in formula`);
    return Number(text);
  }

  function parseIdentifier() {
    let start = pos;
    while (pos < src.length && isIdentChar(src[pos])) pos++;
    const name = src.slice(start, pos);
    if (!(name in variables)) throw new Error(`Unknown variable "${name}" in formula`);
    return Number(variables[name]) || 0;
  }

  function parseFactor() {
    skipWs();
    const c = peek();
    if (c === '(') {
      pos++;
      const v = parseExpr();
      skipWs();
      if (peek() !== ')') throw new Error('Missing closing parenthesis in formula');
      pos++;
      return v;
    }
    if (c === '-') { pos++; return -parseFactor(); }
    if (c === '+') { pos++; return parseFactor(); }
    if (c !== undefined && isDigit(c)) return parseNumber();
    if (c !== undefined && isIdentStart(c)) return parseIdentifier();
    throw new Error(`Unexpected character "${c}" in formula`);
  }

  function parseTerm() {
    let v = parseFactor();
    skipWs();
    while (peek() === '*' || peek() === '/') {
      const op = peek(); pos++;
      const rhs = parseFactor();
      v = op === '*' ? v * rhs : v / rhs;
      skipWs();
    }
    return v;
  }

  function parseExpr() {
    let v = parseTerm();
    skipWs();
    while (peek() === '+' || peek() === '-') {
      const op = peek(); pos++;
      const rhs = parseTerm();
      v = op === '+' ? v + rhs : v - rhs;
      skipWs();
    }
    return v;
  }

  const result = parseExpr();
  skipWs();
  if (pos !== src.length) throw new Error(`Unexpected trailing text in formula near position ${pos}`);
  if (!Number.isFinite(result)) throw new Error('Formula did not evaluate to a finite number');
  return result;
}

// Evaluates a salary component's conditional_rule JSON, e.g.
// {"variable":"monthlyBasic","operator":">","threshold":50000,"thenValue":2000,"elseValue":1000}
// operator is one of > >= < <= ==. Returns thenValue or elseValue.
function evaluateConditionalRule(ruleJson, variables = {}) {
  const rule = typeof ruleJson === 'string' ? JSON.parse(ruleJson) : ruleJson;
  const left = Number(variables[rule.variable]) || 0;
  const threshold = Number(rule.threshold) || 0;
  let matched;
  switch (rule.operator) {
    case '>': matched = left > threshold; break;
    case '>=': matched = left >= threshold; break;
    case '<': matched = left < threshold; break;
    case '<=': matched = left <= threshold; break;
    case '==': matched = left === threshold; break;
    default: throw new Error(`Unknown conditional operator "${rule.operator}"`);
  }
  return Number(matched ? rule.thenValue : rule.elseValue) || 0;
}

// Reducing-balance EMI (equated monthly instalment) for employee loans.
// annualRatePercent === 0 -> simple equal principal instalments.
function computeEmi(principal, annualRatePercent, tenureMonths) {
  principal = Number(principal) || 0;
  tenureMonths = Math.max(1, Math.round(Number(tenureMonths) || 1));
  const rate = Number(annualRatePercent) || 0;
  if (rate <= 0) return Math.round((principal / tenureMonths) * 100) / 100;
  const r = rate / 12 / 100;
  const emi = (principal * r * Math.pow(1 + r, tenureMonths)) / (Math.pow(1 + r, tenureMonths) - 1);
  return Math.round(emi * 100) / 100;
}

// Completed years of service for gratuity purposes (Payment of Gratuity
// Act, 1972 convention: a "year" with 6+ completed months counts as a full
// year of service).
function yearsOfService(joinedDateStr, asOfDateStr) {
  const joined = new Date((joinedDateStr || '') + 'T00:00:00');
  const asOf = new Date((asOfDateStr || todayStr()) + 'T00:00:00');
  if (Number.isNaN(joined.getTime()) || Number.isNaN(asOf.getTime()) || asOf < joined) return 0;
  let years = asOf.getUTCFullYear() - joined.getUTCFullYear();
  let months = asOf.getUTCMonth() - joined.getUTCMonth();
  let days = asOf.getUTCDate() - joined.getUTCDate();
  if (days < 0) months -= 1;
  if (months < 0) { years -= 1; months += 12; }
  if (months >= 6) years += 1;
  return Math.max(0, years);
}

module.exports = {
  numSetting,
  nowStr,
  nowStrOffsetDays,
  todayStr,
  csvEscape,
  genericCsv,
  daysInYear,
  proratedAnnualLeave,
  businessDaysBetween,
  parseTimeToMinutes,
  computeRowHours,
  rowHasContent,
  validateEntriesBasic,
  validateEntriesForSubmit,
  evaluateArithmeticFormula,
  evaluateConditionalRule,
  computeEmi,
  yearsOfService,
};
