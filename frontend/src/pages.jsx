import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import * as api from "./api.js";
import {
  useAuth, useModal, useToast, AuditToggle, ResetPasswordButton,
  PageHead, Card, StatCard, Stamp, EmptyRow, BarChart, Field,
  PageLoading, PayrollStagePath,
  WEEKDAYS, MONTH_NAMES, initials, fmtDate, fmtDateTime, stampClass,
  fmtMoney, fmtMoneyDec, mondayOf, weekDates, toISODate, addWeeks,
  leaveTypeName, debounce,
} from "./components.jsx";

// ============================================================
// LOGIN SCREEN
// ============================================================
export function LoginScreen({ onLoggedIn }) {
  const { doLogin } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [clock, setClock] = useState("—");

  useEffect(() => {
    const tick = () => setClock(new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    tick();
    const h = setInterval(tick, 1000);
    return () => clearInterval(h);
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { mustReset } = await doLogin(email, password);
      onLoggedIn(mustReset);
    } catch (err) {
      setError(err.message || "Invalid email or password. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div id="login-screen">
      <div className="login-hero">
        <span className="hero-orb o1" aria-hidden="true" />
        <span className="hero-orb o2" aria-hidden="true" />
        <span className="hero-orb o3" aria-hidden="true" />
        <div className="brand-mark">
          <div className="vasjo-mark">
            <span className="pix p1" /><span className="pix p2" /><span className="pix p3" />
            <span className="pix p4" /><span className="pix p5" /><span className="pix p6" />
            <div className="stroke-a" /><div className="stroke-b" /><div className="arrowhead" />
            <span className="node n1" /><span className="node n2" /><span className="node n3" />
          </div>
          <div className="vasjo-word">
            <span className="word-main"><span className="vas">VAS</span><span className="jo">JO</span></span>
            <span className="word-sub">TECHNOLOGIES</span>
          </div>
        </div>
        <div className="hero-copy">
          <div className="eyebrow">HRMS · Payroll · ERP</div>
          <h1>Every hour, every rupee, accounted for.</h1>
          <p>Timesheets, leave, approvals, and payroll — run from one calm, precise workspace built for teams who'd rather trust the record than chase it down.</p>
        </div>
        <div className="hero-foot">
          <span>Vasjo Technologies</span>
          <span>{clock}</span>
        </div>
      </div>
      <div className="login-panel">
        <div className="login-box">
          <h2>Sign in</h2>
          <div className="sub">Enter your work email and password.</div>
          <div className={`login-error${error ? " show" : ""}`}>{error || "Invalid email or password. Please try again."}</div>
          <form onSubmit={onSubmit}>
            <Field label="Email">
              <input type="email" placeholder="you@company.com" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="Password">
              <input type="password" placeholder="••••••••" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy}>Sign in</button>
          </form>
          <div className="subtle-note" style={{ textAlign: "center", marginTop: "1rem" }}>Forgot your password? Ask your manager or admin to reset it for you.</div>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// FORCED PASSWORD RESET SCREEN
// ============================================================
export function ForcedResetScreen({ onDone }) {
  const { completeForcedReset } = useAuth();
  const { showToast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    try {
      await completeForcedReset(current, next);
      showToast("Password set — welcome in!");
      onDone();
    } catch (err) {
      setError(err.message || "Could not update password");
    }
  }

  return (
    <div style={{ display: "flex", minHeight: "100vh", alignItems: "center", justifyContent: "center", background: "var(--paper)" }}>
      <div className="login-box" style={{ maxWidth: "24rem" }}>
        <h2>Choose a new password</h2>
        <div className="sub">Your administrator set a temporary password. Please set your own before continuing.</div>
        <div className={`login-error${error ? " show" : ""}`}>{error}</div>
        <form onSubmit={onSubmit}>
          <Field label="Temporary password">
            <input type="password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password">
            <input type="password" placeholder="At least 8 characters" required minLength={8} value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-primary btn-block">Continue</button>
        </form>
      </div>
    </div>
  );
}

// ============================================================
// DASHBOARD
// ============================================================
export function DashboardPage({ navTo }) {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const { showError } = useToast();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ timesheets: myTs }, { leave: myLeave }, { balances }, settings, types] = await Promise.all([
          api.getMyTimesheets(), api.getMyLeaveApplications(), api.getLeaveBalances(), api.getSettings(), api.getLeaveTypes(),
        ]);
        let teamPending = null;
        if (user.role === "manager" || user.role === "admin") {
          const [{ timesheets: allPendingTs }, { leave: allPendingLv }] = await Promise.all([
            api.getPendingTimesheets(), api.getPendingLeaveApplications(),
          ]);
          teamPending = { ts: allPendingTs.length, lv: allPendingLv.length };
        }
        let trend = null;
        try { trend = (await api.getMyTrend(8)).trend; } catch (e) { /* skip chart */ }
        let teamSummary = null;
        if (user.role === "manager" || user.role === "admin") {
          try { teamSummary = (await api.getTeamSummary()).summary; } catch (e) { /* skip */ }
        }
        if (!cancelled) setData({ myTs, myLeave, balances, settings, types, teamPending, trend, teamSummary });
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [user.role]);

  if (!data) return <PageLoading />;

  const { myTs, myLeave, balances, settings, types, teamPending, trend, teamSummary } = data;
  const pendingTs = myTs.filter((t) => t.status === "pending").length;
  const pendingLeave = myLeave.filter((l) => l.status === "pending").length;
  const annual = balances.find((b) => b.type_name === "Casual Leave");
  const annualRemaining = annual ? annual.total_days - annual.used_days : "—";

  const currentWeekStart = toISODate(mondayOf(toISODate(new Date())));
  const hasCurrentWeek = myTs.some((t) => t.week_start === currentWeekStart && t.status !== "draft");
  const today = new Date().getDay();
  const showReminder = !hasCurrentWeek && today >= 4 && user.role !== "admin";

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";

  return (
    <>
      <div className="dashboard-hero">
        <PageHead eyebrow={`${timeGreeting} · Overview`} title={`Welcome back, ${user.name.split(" ")[0]}`} sub="Here's where things stand this week." />
      </div>

      {showReminder ? (
        <div className="card" style={{ borderColor: "var(--amber)", background: "var(--amber-soft)", marginBottom: "1.1rem" }}>
          <strong>Reminder:</strong> you haven't submitted a timesheet for this week yet.
          <a href="#" style={{ color: "var(--teal)", textDecoration: "underline", marginLeft: "0.4rem" }} onClick={(e) => { e.preventDefault(); navTo("timesheet-entry"); }}>Submit now →</a>
        </div>
      ) : null}

      <div className="stat-grid">
        <StatCard label="Most recent week logged" value={`${myTs.length ? myTs[0].total_hours : 0}h`} foot={`of ${(parseFloat(settings.standard_hours_per_day) || 8) * 5}h expected`} />
        <StatCard label="Timesheets pending" value={pendingTs} foot="awaiting approval" tone="amber" />
        <StatCard label="Leave balance" value={annualRemaining} foot="annual days remaining" />
        <StatCard label="Leave requests pending" value={pendingLeave} foot="in review" tone={pendingLeave ? "amber" : undefined} />
        {teamPending ? (
          <StatCard label="Team approvals waiting" value={teamPending.ts + teamPending.lv} foot={`${teamPending.ts} timesheets · ${teamPending.lv} leave requests`} tone="amber" />
        ) : null}
      </div>

      <div className="two-col">
        <Card title="Recent timesheets">
          <table>
            <thead><tr><th>Week of</th><th>Hours</th><th>Status</th></tr></thead>
            <tbody>
              {myTs.length ? myTs.slice(0, 6).map((t) => (
                <tr key={t.id}>
                  <td className="mono">{fmtDate(t.week_start)}</td>
                  <td className="mono">{t.total_hours}h</td>
                  <td><Stamp status={t.status} /></td>
                </tr>
              )) : <EmptyRow colSpan={3}>No timesheets submitted yet.</EmptyRow>}
            </tbody>
          </table>
        </Card>
        <Card title="Upcoming leave">
          {myLeave.filter((l) => l.status !== "rejected" && l.status !== "cancelled").length === 0 ? (
            <div style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No leave scheduled.</div>
          ) : myLeave.filter((l) => l.status !== "rejected" && l.status !== "cancelled").slice(0, 6).map((l) => (
            <div className="approval-item" key={l.id}>
              <div className="who">
                <div>
                  <div className="name">{leaveTypeName(l.leave_type_id, types)}</div>
                  <div className="meta">{fmtDate(l.from_date)} → {fmtDate(l.to_date)}</div>
                </div>
              </div>
              <Stamp status={l.status} />
            </div>
          ))}
        </Card>
      </div>

      <div className="two-col" style={{ marginTop: "1.1rem" }}>
        {trend ? (
          <Card title="Your hours — last 8 weeks">
            <BarChart rows={trend.map((t) => ({ label: t.week_start.slice(5), total_hours: t.total_hours }))} labelKey="label" valueKey="total_hours" unit="h" />
          </Card>
        ) : null}
        {teamSummary ? (
          <Card title="Team hours — last 8 weeks (approved)">
            <BarChart rows={teamSummary.map((s) => ({ label: s.user_name, total_hours: s.total_hours }))} labelKey="label" valueKey="total_hours" unit="h" />
          </Card>
        ) : null}
      </div>
    </>
  );
}

// ============================================================
// CALENDAR
// ============================================================
export function CalendarPage() {
  const { user } = useAuth();
  const { showError } = useToast();
  const isManagerish = user.role === "manager" || user.role === "admin";
  const [mode, setMode] = useState("mine");
  const [month, setMonth] = useState(new Date().getMonth());
  const [year, setYear] = useState(new Date().getFullYear());
  const [state, setState] = useState(null); // { holidays, leave, timesheets, types }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const leavePromise = mode === "team" ? api.getTeamLeaveApplications() : api.getMyLeaveApplications();
        const [{ leave }, { holidays }, { timesheets }, types] = await Promise.all([
          leavePromise, api.getHolidays(), api.getMyTimesheetsPaged(1, 100), api.getLeaveTypes(),
        ]);
        if (!cancelled) setState({ leave, holidays, timesheets, types });
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [mode]);

  function prevMonth() { setMonth((m) => { if (m === 0) { setYear((y) => y - 1); return 11; } return m - 1; }); }
  function nextMonth() { setMonth((m) => { if (m === 11) { setYear((y) => y + 1); return 0; } return m + 1; }); }

  const cells = useMemo(() => {
    if (!state) return null;
    const { holidays, leave, timesheets, types } = state;
    const holidayByDate = {};
    holidays.forEach((h) => { holidayByDate[h.holiday_date] = h; });
    const tsByWeekStart = {};
    timesheets.forEach((t) => { tsByWeekStart[t.week_start] = t.status; });
    const relevant = leave.filter((l) => l.status !== "rejected" && l.status !== "cancelled");

    const first = new Date(year, month, 1);
    const startOffset = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const out = [];
    for (let i = 0; i < startOffset; i++) out.push({ blank: true, key: `b${i}` });
    for (let day = 1; day <= daysInMonth; day++) {
      const dateObj = new Date(year, month, day);
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
      const holiday = holidayByDate[dateStr];
      const weekStart = toISODate(mondayOf(dateStr));
      const tsStatus = tsByWeekStart[weekStart];
      const matches = relevant.filter((l) => dateStr >= l.from_date && dateStr <= l.to_date);
      let cls = "cal-cell in-month";
      if (isWeekend) cls += " weekend-cell";
      if (tsStatus) cls += ` ts-${tsStatus}`;
      let marker = null;
      if (holiday) {
        cls += " has-holiday";
        marker = <div className="cal-holiday-tag" title={holiday.name}>🎉</div>;
      } else if (mode === "team" && matches.length) {
        cls += " team-cal-cell";
        marker = (
          <div className="initials-row">
            {matches.slice(0, 4).map((m, i) => (
              <span key={i} className={`init-chip${m.status === "pending" ? " pending" : ""}`} title={`${m.user_name} — ${leaveTypeName(m.leave_type_id, types)}`}>{initials(m.user_name)}</span>
            ))}
          </div>
        );
      } else if (matches.length) {
        cls += matches[0].status === "approved" ? " has-leave" : " has-pending";
      }
      out.push({ key: dateStr, day, cls, title: holiday ? holiday.name : "", marker });
    }
    return out;
  }, [state, month, year, mode]);

  return (
    <>
      <PageHead eyebrow="Time" title="Calendar" sub="Working days, holidays, leave, and your timesheet status at a glance." />
      <Card>
        {isManagerish ? (
          <div className="tabs" style={{ marginBottom: "0.8rem" }}>
            <button className={`tab-btn${mode === "mine" ? " active" : ""}`} onClick={() => setMode("mine")}>My Calendar</button>
            <button className={`tab-btn${mode === "team" ? " active" : ""}`} onClick={() => setMode("team")}>Team Calendar</button>
          </div>
        ) : null}
        <div className="cal-head">
          <button className="icon-btn" onClick={prevMonth}>‹</button>
          <div className="month-label">{MONTH_NAMES[month]} {year}</div>
          <button className="icon-btn" onClick={nextMonth}>›</button>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((d) => <div className="cal-dow" key={d}>{d}</div>)}
          {cells ? cells.map((c) => c.blank ? <div className="cal-cell" key={c.key} /> : (
            <div className={c.cls} title={c.title} key={c.key}>{c.day}{c.marker}</div>
          )) : null}
        </div>
        <div className="cal-legend">
          <span><span className="legend-dot holiday" /> Holiday</span>
          <span><span className="legend-dot leave-approved" /> Leave approved</span>
          <span><span className="legend-dot leave-pending" /> Leave pending</span>
          <span><span className="legend-bar approved" /> Timesheet approved</span>
        </div>
      </Card>
    </>
  );
}

// ============================================================
// TIMESHEET ENTRY
// ============================================================
function computeRowHours(inTime, outTime) {
  if (!inTime || !outTime) return 0;
  const [ih, im] = inTime.split(":").map(Number);
  const [oh, om] = outTime.split(":").map(Number);
  const diff = (oh * 60 + om - (ih * 60 + im)) / 60;
  return diff > 0 ? Math.round(diff * 100) / 100 : 0;
}
function rowError(row) {
  if (!row.inTime && !row.outTime && !row.note.trim()) return null;
  if (!row.inTime || !row.outTime) return "Enter both In and Out time";
  if (computeRowHours(row.inTime, row.outTime) <= 0) return "Out time must be after In time";
  return null;
}
function defaultOutTime(inTime, standardHours) {
  const [h, m] = inTime.split(":").map(Number);
  const total = h * 60 + m + standardHours * 60;
  const oh = Math.floor(total / 60) % 24;
  const om = total % 60;
  return `${String(oh).padStart(2, "0")}:${String(om).padStart(2, "0")}`;
}

export function TimesheetEntryPage({ navTo }) {
  const { showToast, showError } = useToast();
  const { openModal, closeModal } = useModal();
  const [weekOffset, setWeekOffset] = useState(0);
  const [loaded, setLoaded] = useState(null); // { existing, dayRows, holidayByDate, standardHours, days }
  const [saving, setSaving] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const monday = useMemo(() => addWeeks(mondayOf(toISODate(new Date())), weekOffset), [weekOffset]);
  const days = useMemo(() => weekDates(monday), [monday]);
  const weekStartStr = toISODate(monday);
  const weekEndStr = toISODate(days[6]);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    (async () => {
      try {
        const settings = await api.getSettings();
        const standardHours = parseFloat(settings.standard_hours_per_day) || 8;
        const [{ timesheet: existing, entries: existingEntries }, { holidays }] = await Promise.all([
          api.getTimesheetByWeek(weekStartStr), api.getHolidays(),
        ]);
        const holidayByDate = {};
        holidays.forEach((h) => { holidayByDate[h.holiday_date] = h; });
        const entriesByDate = {};
        existingEntries.forEach((e) => {
          if (!entriesByDate[e.entry_date]) entriesByDate[e.entry_date] = [];
          entriesByDate[e.entry_date].push({ inTime: e.in_time || "", outTime: e.out_time || "", note: e.note || "" });
        });
        const dayRows = {};
        days.forEach((d) => {
          const dateStr = toISODate(d);
          const holiday = holidayByDate[dateStr];
          if (holiday) { dayRows[dateStr] = []; return; }
          if (entriesByDate[dateStr]) { dayRows[dateStr] = entriesByDate[dateStr].map((r) => ({ ...r })); return; }
          const isWeekend = d.getDay() === 0 || d.getDay() === 6;
          if (isWeekend || existing) {
            dayRows[dateStr] = [];
          } else {
            dayRows[dateStr] = [{ inTime: "09:00", outTime: defaultOutTime("09:00", standardHours), note: "" }];
          }
        });
        if (!cancelled) setLoaded({ existing, holidays, holidayByDate, standardHours, dayRows });
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [weekStartStr, reloadKey]);

  const [rowsVersion, setRowsVersion] = useState(0);
  function mutateRows(fn) {
    setLoaded((prev) => {
      if (!prev) return prev;
      fn(prev.dayRows);
      return { ...prev, dayRows: { ...prev.dayRows } };
    });
    setRowsVersion((v) => v + 1);
  }

  if (!loaded) return <PageLoading />;

  const { existing, holidays, holidayByDate, standardHours, dayRows } = loaded;
  const isApproved = existing && existing.status === "approved";
  const isLocked = isApproved;
  const correctionRequested = existing && existing.correction_status === "requested";

  function dayTotal(dateStr) {
    return (dayRows[dateStr] || []).reduce((s, r) => s + computeRowHours(r.inTime, r.outTime), 0);
  }
  function weekTotal() {
    return Object.keys(dayRows).reduce((s, d) => s + dayTotal(d), 0);
  }
  const holidaysThisWeek = holidays.filter((h) => h.holiday_date >= weekStartStr && h.holiday_date <= weekEndStr);
  const overtime = Object.keys(dayRows).reduce((s, d) => s + Math.max(0, dayTotal(d) - standardHours), 0);

  function addRow(dateStr) {
    mutateRows((rows) => { rows[dateStr] = [...(rows[dateStr] || []), { inTime: "", outTime: "", note: "" }]; });
  }
  function deleteRow(dateStr, idx) {
    mutateRows((rows) => { rows[dateStr] = rows[dateStr].filter((_, i) => i !== idx); });
  }
  function updateField(dateStr, idx, field, value) {
    mutateRows((rows) => { rows[dateStr] = rows[dateStr].map((r, i) => (i === idx ? { ...r, [field]: value } : r)); });
  }

  function collectEntries() {
    const entries = [];
    Object.keys(dayRows).forEach((dateStr) => {
      const rows = dayRows[dateStr];
      if (!rows.length) { entries.push({ date: dateStr, inTime: "", outTime: "", note: "" }); return; }
      rows.forEach((r) => entries.push({ date: dateStr, inTime: r.inTime, outTime: r.outTime, note: r.note.trim() }));
    });
    return entries;
  }
  function hasRowErrors() {
    return Object.keys(dayRows).some((d) => (dayRows[d] || []).some((r) => rowError(r)));
  }

  async function saveDraft() {
    if (hasRowErrors()) { showToast("Fix the highlighted time entries before saving", true); return; }
    setSaving(true);
    try {
      const entries = collectEntries();
      await api.saveTimesheet(entries[0].date, entries, false);
      showToast("Saved as draft");
    } catch (err) { showError(err); } finally { setSaving(false); }
  }

  async function doSubmit() {
    setSaving(true);
    try {
      const entries = collectEntries();
      const { id } = await api.saveTimesheet(entries[0].date, entries, true);
      showToast(`Timesheet ${id} submitted for approval`);
      navTo("timesheet-history");
    } catch (err) { showError(err); setSaving(false); }
  }

  function onSubmitClick() {
    if (hasRowErrors()) { showToast("Fix the highlighted time entries before submitting", true); return; }
    const weekday0h = Object.keys(dayRows).filter((dateStr) => {
      const day = new Date(dateStr + "T00:00:00").getDay();
      if (day === 0 || day === 6) return false;
      return dayTotal(dateStr) === 0;
    });
    if (weekday0h.length) {
      const list = weekday0h.map((d) => fmtDate(d)).join(", ");
      if (!window.confirm(`These weekdays have no time logged: ${list}.\n\nIf they're covered by a holiday or approved leave this is fine — otherwise, submit anyway?`)) return;
    }
    doSubmit();
  }

  function openCorrectionModal() {
    let reason = "";
    let error = "";
    const render = () => (
      <>
        <p className="subtle-note" style={{ marginTop: 0 }}>Explain what needs to change. Your manager will review and, if approved, unlock this timesheet for editing.</p>
        <div className="field">
          <textarea placeholder="e.g. Forgot to log Friday's hours" onChange={(e) => { reason = e.target.value; }} />
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
      </>
    );
    openModal("Request a correction", render(), (
      <>
        <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          const r = reason.trim();
          if (!r) { showToast("Please explain what needs to be corrected.", true); return; }
          try {
            await api.requestTimesheetCorrection(existing.id, r);
            closeModal();
            showToast("Correction request sent to your manager");
            setLoaded(null);
            setReloadKey((k) => k + 1);
          } catch (err) { showError(err); }
        }}>Send request</button>
      </>
    ));
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="eyebrow">Time</div>
          <h1>Submit Timesheet</h1>
          <div className="week-nav">
            <button onClick={() => setWeekOffset((w) => w - 1)} title="Previous week">‹</button>
            <span className="week-label">Week of {monday.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</span>
            <button onClick={() => weekOffset < 0 && setWeekOffset((w) => w + 1)} disabled={weekOffset >= 0} title="Next week">›</button>
          </div>
        </div>
      </div>

      {existing ? (
        <div className="status-pill-row">
          <Stamp status={existing.status} />
          {existing.last_comment ? <span className="subtle-note" style={{ margin: 0 }}>Manager note: "{existing.last_comment}"</span> : null}
          {correctionRequested ? <span className="subtle-note" style={{ margin: 0, color: "var(--amber)" }}>Correction request pending manager review</span> : null}
        </div>
      ) : null}

      {days.map((d, i) => {
        const dateStr = toISODate(d);
        const isWeekend = i >= 5;
        const holiday = holidayByDate[dateStr];
        const dateLabel = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
        if (holiday) {
          return (
            <div className="day-accordion holiday-day-flat" key={dateStr}>
              <div className="day-accordion-title">
                <span className="dow">{WEEKDAYS[i]}</span>
                <span className="date">{dateLabel}</span>
                <span className="holiday-label">🎉 {holiday.name}</span>
              </div>
              <span className="day-total zero">Holiday</span>
            </div>
          );
        }
        const total = dayTotal(dateStr);
        const rows = dayRows[dateStr] || [];
        const hasContent = rows.length > 0;
        return (
          <details className="day-accordion" open={!isWeekend || hasContent} key={dateStr}>
            <summary>
              <div className={`day-accordion-title${isWeekend ? " weekend" : ""}`}>
                <span className="dow">{WEEKDAYS[i]}</span>
                <span className="date">{dateLabel}</span>
              </div>
              <div className="day-accordion-meta">
                <span className={`day-total${total > 0 ? "" : " zero"}`}>{total > 0 ? total.toFixed(2) + "h" : "0h"}</span>
                <span className="accordion-chevron">▾</span>
              </div>
            </summary>
            <div className="day-accordion-body">
              {rows.length === 0 ? <p className="subtle-note" style={{ margin: "0 0 0.6rem" }}>No time logged yet.</p> : rows.map((row, idx) => {
                const hours = computeRowHours(row.inTime, row.outTime);
                const err = rowError(row);
                return (
                  <div className="time-entry-row" key={idx}>
                    <div className="field-inline">
                      <label>In</label>
                      <input type="time" className={err ? "row-error" : ""} value={row.inTime} disabled={isLocked}
                        onChange={(e) => updateField(dateStr, idx, "inTime", e.target.value)} />
                    </div>
                    <div className="field-inline">
                      <label>Out</label>
                      <input type="time" className={err ? "row-error" : ""} value={row.outTime} disabled={isLocked}
                        onChange={(e) => updateField(dateStr, idx, "outTime", e.target.value)} />
                    </div>
                    <div className="row-note-wrap">
                      <label>Note</label>
                      <input type="text" className="row-note" placeholder="Optional" value={row.note} disabled={isLocked}
                        onChange={(e) => updateField(dateStr, idx, "note", e.target.value)} />
                    </div>
                    <div className="row-hours-wrap"><span className={`row-hours${hours > 0 ? " has-value" : ""}`}>{hours > 0 ? hours.toFixed(2) + "h" : "—"}</span></div>
                    <div className="row-delete-wrap">
                      <button type="button" className="row-delete-btn" title="Remove row" disabled={isLocked} onClick={() => deleteRow(dateStr, idx)}>✕</button>
                    </div>
                    {err ? <div className="row-error-text">{err}</div> : null}
                  </div>
                );
              })}
              {!isLocked ? <button type="button" className="add-row-btn" onClick={() => addRow(dateStr)}>+ Add Row</button> : null}
            </div>
          </details>
        );
      })}

      <div className="card" style={{ marginTop: "1rem" }}>
        <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginBottom: "0.8rem" }}>
          <div><span className="text-dim">Week total:</span> <strong className="mono">{weekTotal().toFixed(2)}h</strong></div>
          <div><span className="text-dim">Overtime:</span> <strong className="mono">{overtime.toFixed(2)}h</strong></div>
          {holidaysThisWeek.length ? <div><span className="text-dim">Holidays this week:</span> {holidaysThisWeek.map((h) => h.name).join(", ")}</div> : null}
        </div>
        <div className="form-actions">
          {isApproved && !correctionRequested ? (
            <button className="btn btn-ghost" onClick={openCorrectionModal}>Request a correction</button>
          ) : null}
          {!isLocked ? (
            <>
              <button className="btn btn-ghost" disabled={saving} onClick={saveDraft}>Save as draft</button>
              <button className="btn btn-primary" disabled={saving} onClick={onSubmitClick}>Submit for approval</button>
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

// ============================================================
// TIMESHEET HISTORY
// ============================================================
export function TimesheetHistoryPage() {
  const { showError } = useToast();
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { timesheets, total } = await api.getMyTimesheetsPaged(1, page * 10);
        if (!cancelled) setData({ timesheets, total });
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [page]);

  return (
    <>
      <PageHead eyebrow="Time" title="Timesheet History" sub="Your past submissions and their approval status."
        actions={<a className="btn btn-ghost btn-sm" href={api.timesheetsCsvUrl()} download>Export CSV</a>} />
      <Card>
        <table>
          <thead><tr><th>ID</th><th>Week of</th><th>Total Hours</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {!data ? <EmptyRow colSpan={5}>Loading…</EmptyRow> : data.timesheets.length === 0 ? (
              <EmptyRow colSpan={5}>No timesheets yet — submit your first one from the Submit Timesheet page.</EmptyRow>
            ) : data.timesheets.map((t) => (
              <tr key={t.id}>
                <td className="mono">{t.id}</td>
                <td className="mono">{fmtDate(t.week_start)}</td>
                <td className="mono">{t.total_hours}h</td>
                <td><Stamp status={t.status} /></td>
                <td><AuditToggle entityType="timesheet" entityId={t.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.timesheets.length < data.total ? (
          <div className="load-more-row"><button className="btn btn-ghost btn-sm" onClick={() => setPage((p) => p + 1)}>Load more</button></div>
        ) : null}
      </Card>
    </>
  );
}

// ============================================================
// LEAVE APPLICATION
// ============================================================
export function LeaveApplicationPage({ navTo }) {
  const { showToast, showError } = useToast();
  const [types, setTypes] = useState(null);
  const [balances, setBalances] = useState(null);
  const [leaveTypeId, setLeaveTypeId] = useState(null);
  const [duration, setDuration] = useState("full");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [t, { balances: b }] = await Promise.all([api.getLeaveTypes(), api.getLeaveBalances()]);
        setTypes(t);
        setBalances(b);
        if (t.length) setLeaveTypeId(t[0].id);
      } catch (err) { showError(err); }
    })();
  }, []);

  async function submit() {
    if (!from) { showToast("Please select a start date", true); return; }
    setBusy(true);
    try {
      const { id } = await api.applyForLeave({ leaveTypeId: parseInt(leaveTypeId, 10), from, to: to || from, reason: reason.trim(), halfDay: duration === "half" });
      showToast(`Leave request ${id} submitted`);
      navTo("leave-history");
    } catch (err) { showError(err); setBusy(false); }
  }

  return (
    <>
      <PageHead eyebrow="Leave" title="Apply for Leave" sub="Balances update automatically once your request is approved. Weekends don't count toward the day total." />
      <div className="balance-grid" style={{ marginBottom: "1.1rem" }}>
        {types ? types.map((t) => {
          const b = (balances || []).find((x) => x.leave_type_id === t.id) || { total_days: 0, used_days: 0, pending_days: 0 };
          return (
            <div className="balance-chip" key={t.id}>
              <div className="n">{b.total_days - b.used_days}</div>
              <div className="lbl">{t.name} left</div>
              {b.pending_days > 0 ? <div className="lbl" style={{ color: "var(--amber)" }}>{b.pending_days} pending</div> : null}
            </div>
          );
        }) : null}
      </div>
      <Card title="New request">
        <div className="form-grid">
          <Field label="Leave type">
            <select value={leaveTypeId || ""} onChange={(e) => setLeaveTypeId(e.target.value)}>
              {(types || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          <Field label="Duration">
            <select value={duration} onChange={(e) => setDuration(e.target.value)}>
              <option value="full">Full day(s)</option>
              <option value="half">Half day</option>
            </select>
          </Field>
          <Field label="From"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
          <div className="field full">
            <label>Reason</label>
            <input type="text" placeholder="Brief reason for leave" value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
        <div className="form-actions">
          <button className="btn btn-primary" disabled={busy} onClick={submit}>Submit request</button>
        </div>
      </Card>
    </>
  );
}

// ============================================================
// LEAVE HISTORY
// ============================================================
export function LeaveHistoryPage({ navTo }) {
  const { showToast, showError } = useToast();
  const [data, setData] = useState(null);
  const [types, setTypes] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ leave }, t] = await Promise.all([api.getMyLeaveApplications(), api.getLeaveTypes()]);
        if (!cancelled) { setData(leave); setTypes(t); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function cancel(id) {
    if (!window.confirm("Cancel this leave request?")) return;
    try {
      await api.cancelLeaveApplication(id);
      showToast("Leave request cancelled");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  return (
    <>
      <PageHead eyebrow="Leave" title="Leave History"
        sub={<>Track your requests. See <a href="#" style={{ color: "var(--teal)", textDecoration: "underline" }} onClick={(e) => { e.preventDefault(); navTo("calendar"); }}>Calendar</a> for the month-at-a-glance view.</>}
        actions={<a className="btn btn-ghost btn-sm" href={api.leaveCsvUrl()} download>Export CSV</a>} />
      <Card>
        <table>
          <thead><tr><th>ID</th><th>Type</th><th>Dates</th><th>Days</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {!data ? <EmptyRow colSpan={6}>Loading…</EmptyRow> : data.length === 0 ? (
              <EmptyRow colSpan={6}>No leave requests yet.</EmptyRow>
            ) : data.map((l) => (
              <tr key={l.id}>
                <td className="mono">{l.id}</td>
                <td>{leaveTypeName(l.leave_type_id, types)}</td>
                <td className="mono">{fmtDate(l.from_date)} → {fmtDate(l.to_date)}</td>
                <td className="mono">{l.days}</td>
                <td><Stamp status={l.status} /></td>
                <td>{["pending", "approved"].includes(l.status) ? <button className="btn btn-ghost btn-sm" onClick={() => cancel(l.id)}>Cancel</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// APPROVALS
// ============================================================
export function ApprovalsPage() {
  const { showToast, showError } = useToast();
  const { promptComment } = useModal();
  const [tab, setTab] = useState("ts");
  const [data, setData] = useState(null);
  const [types, setTypes] = useState(null);
  const [selectedTs, setSelectedTs] = useState({});
  const [selectedLv, setSelectedLv] = useState({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ timesheets: pendingTs }, { leave: pendingLv }, { requests: corrections }, t] = await Promise.all([
          api.getPendingTimesheets(), api.getPendingLeaveApplications(), api.getCorrectionRequests(), api.getLeaveTypes(),
        ]);
        if (!cancelled) { setData({ pendingTs, pendingLv, corrections }); setTypes(t); setSelectedTs({}); setSelectedLv({}); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  function reload() { setReloadKey((k) => k + 1); }

  async function decideOne(kind, id, action) {
    const comment = await promptComment(`${action === "approve" ? "Approve" : "Reject"} ${id}`, action === "reject");
    if (comment === null) return;
    try {
      if (kind === "ts") await api.decideTimesheet(id, action, comment);
      else await api.decideLeaveApplication(id, action, comment);
      showToast(`${id} ${action}d${kind === "lv" && action === "approve" ? " — balance updated" : ""}`);
      reload();
    } catch (err) { showError(err); }
  }
  async function decideCorrection(id, action) {
    const comment = await promptComment(action === "approve" ? `Approve correction on ${id} — this unlocks it for editing` : `Decline correction request on ${id}`, action === "reject");
    if (comment === null) return;
    try {
      await api.decideTimesheetCorrection(id, action, comment);
      showToast(action === "approve" ? `Correction approved — ${id} is now editable` : "Correction request declined");
      reload();
    } catch (err) { showError(err); }
  }
  async function bulkDecide(kind, action) {
    const selected = kind === "ts" ? selectedTs : selectedLv;
    const ids = Object.keys(selected).filter((k) => selected[k]);
    if (!ids.length) return;
    const comment = await promptComment(`${action === "approve" ? "Approve" : "Reject"} ${ids.length} item(s)`, action === "reject");
    if (comment === null) return;
    try {
      if (kind === "ts") await api.bulkDecideTimesheets(ids, action, comment);
      else await api.bulkDecideLeaveApplications(ids, action, comment);
      showToast(`${ids.length} item(s) ${action}d`);
      reload();
    } catch (err) { showError(err); }
  }

  if (!data) return <PageLoading />;
  const { pendingTs, pendingLv, corrections } = data;
  const tsCount = Object.values(selectedTs).filter(Boolean).length;
  const lvCount = Object.values(selectedLv).filter(Boolean).length;

  return (
    <>
      <PageHead eyebrow="Team" title="Approvals" sub="Review and act on pending timesheets, leave requests, and correction requests. Select multiple to approve or reject together." />
      <div className="tabs">
        <button className={`tab-btn${tab === "ts" ? " active" : ""}`} onClick={() => setTab("ts")}>Timesheets ({pendingTs.length})</button>
        <button className={`tab-btn${tab === "lv" ? " active" : ""}`} onClick={() => setTab("lv")}>Leave ({pendingLv.length})</button>
        <button className={`tab-btn${tab === "cr" ? " active" : ""}`} onClick={() => setTab("cr")}>Corrections ({corrections.length})</button>
      </div>

      {tab === "ts" ? (
        <div>
          <div className={`bulk-bar${tsCount ? " show" : ""}`}>
            <span><span>{tsCount}</span> selected</span>
            <div className="bulk-actions">
              <button className="btn btn-sm btn-primary" onClick={() => bulkDecide("ts", "approve")}>Approve selected</button>
              <button className="btn btn-sm btn-ghost" onClick={() => bulkDecide("ts", "reject")}>Reject selected</button>
            </div>
          </div>
          {pendingTs.length === 0 ? <div className="card" style={{ color: "var(--text-dim)", fontSize: "0.88rem" }}>Nothing pending — all timesheets are up to date.</div> : pendingTs.map((t) => (
            <div className="approval-item" key={t.id}>
              <div className="who">
                <input type="checkbox" className="select-check" checked={!!selectedTs[t.id]} onChange={(e) => setSelectedTs((s) => ({ ...s, [t.id]: e.target.checked }))} />
                <div className="user-avatar" style={{ width: 34, height: 34, fontSize: "0.72rem" }}>{initials(t.user_name)}</div>
                <div>
                  <div className="name">{t.user_name} — {t.id}</div>
                  <div className="meta">Week of {fmtDate(t.week_start)} · {t.total_hours}h</div>
                </div>
              </div>
              <div className="approval-actions">
                <button className="icon-btn approve" title="Approve" onClick={() => decideOne("ts", t.id, "approve")}>✓</button>
                <button className="icon-btn reject" title="Reject" onClick={() => decideOne("ts", t.id, "reject")}>✕</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "lv" ? (
        <div>
          <div className={`bulk-bar${lvCount ? " show" : ""}`}>
            <span><span>{lvCount}</span> selected</span>
            <div className="bulk-actions">
              <button className="btn btn-sm btn-primary" onClick={() => bulkDecide("lv", "approve")}>Approve selected</button>
              <button className="btn btn-sm btn-ghost" onClick={() => bulkDecide("lv", "reject")}>Reject selected</button>
            </div>
          </div>
          {pendingLv.length === 0 ? <div className="card" style={{ color: "var(--text-dim)", fontSize: "0.88rem" }}>Nothing pending — all leave requests are resolved.</div> : pendingLv.map((l) => (
            <div className="approval-item" key={l.id}>
              <div className="who">
                <input type="checkbox" className="select-check" checked={!!selectedLv[l.id]} onChange={(e) => setSelectedLv((s) => ({ ...s, [l.id]: e.target.checked }))} />
                <div className="user-avatar" style={{ width: 34, height: 34, fontSize: "0.72rem" }}>{initials(l.user_name)}</div>
                <div>
                  <div className="name">{l.user_name} — {leaveTypeName(l.leave_type_id, types)}</div>
                  <div className="meta">{fmtDate(l.from_date)} → {fmtDate(l.to_date)} · {l.days}d · "{l.reason || "No reason given"}"</div>
                </div>
              </div>
              <div className="approval-actions">
                <button className="icon-btn approve" title="Approve" onClick={() => decideOne("lv", l.id, "approve")}>✓</button>
                <button className="icon-btn reject" title="Reject" onClick={() => decideOne("lv", l.id, "reject")}>✕</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {tab === "cr" ? (
        <div>
          {corrections.length === 0 ? <div className="card" style={{ color: "var(--text-dim)", fontSize: "0.88rem" }}>No correction requests pending.</div> : corrections.map((t) => (
            <div className="approval-item" key={t.id}>
              <div className="who">
                <div className="user-avatar" style={{ width: 34, height: 34, fontSize: "0.72rem" }}>{initials(t.user_name)}</div>
                <div>
                  <div className="name">{t.user_name} — {t.id}</div>
                  <div className="meta">Week of {fmtDate(t.week_start)} · Approved timesheet, requested {fmtDateTime(t.correction_requested_at)}</div>
                  <div className="meta" style={{ fontStyle: "italic" }}>"{t.correction_reason}"</div>
                </div>
              </div>
              <div className="approval-actions">
                <button className="icon-btn approve" title="Approve — unlocks for editing" onClick={() => decideCorrection(t.id, "approve")}>✓</button>
                <button className="icon-btn reject" title="Decline" onClick={() => decideCorrection(t.id, "reject")}>✕</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

// ============================================================
// TEAM TIMESHEETS
// ============================================================
export function TeamTimesheetsPage() {
  const { showError } = useToast();
  const [teamUsers, setTeamUsers] = useState(null);
  const [employeeId, setEmployeeId] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const pageSize = 25;

  useEffect(() => {
    (async () => {
      try { setTeamUsers((await api.getUsersFlat()).users); } catch (err) { showError(err); }
    })();
  }, []);

  const load = useCallback(async (reset) => {
    try {
      const p = reset ? 1 : page;
      const { timesheets, total: t } = await api.getAllTimesheets({ page: p, pageSize, employeeId: employeeId || undefined, status: status || undefined });
      setRows((prev) => (reset ? timesheets : prev.concat(timesheets)));
      setTotal(t);
      if (reset) setPage(1);
    } catch (err) { showError(err); }
  }, [page, employeeId, status]);

  useEffect(() => { load(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <PageHead eyebrow="Team" title="Team Timesheets" sub="Submitted and approved hours across your team, including overtime and work mode." />
      <div className="report-controls">
        <Field label="Employee">
          <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
            <option value="">All</option>
            {(teamUsers || []).filter((u) => u.role !== "admin").map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            <option value="draft">Draft</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </Field>
        <button className="btn btn-ghost btn-sm" onClick={() => load(true)}>Apply filters</button>
      </div>
      <Card>
        <table>
          <thead><tr><th>Employee</th><th>ID</th><th>Week of</th><th>Hours</th><th>Overtime</th><th>Status</th></tr></thead>
          <tbody>
            {rows.length === 0 ? <EmptyRow colSpan={6}>No timesheets match these filters.</EmptyRow> : rows.map((t) => (
              <tr key={t.id}>
                <td>{t.user_name}</td>
                <td className="mono">{t.id}</td>
                <td className="mono">{fmtDate(t.week_start)}</td>
                <td className="mono">{t.total_hours}h</td>
                <td className={`mono${t.overtime_hours > 0 ? " overtime-value" : ""}`}>{t.overtime_hours > 0 ? t.overtime_hours + "h" : "—"}</td>
                <td><Stamp status={t.status} />{t.escalated ? <span className="escalated-tag"> ⚠ overdue</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length < total ? (
          <div className="load-more-row"><button className="btn btn-ghost btn-sm" onClick={() => { setPage((p) => p + 1); load(false); }}>Load more</button></div>
        ) : null}
      </Card>
    </>
  );
}

// ============================================================
// REPORTS
// ============================================================
export function ReportsPage() {
  const { showError } = useToast();
  const [rtab, setRtab] = useState("project");

  const [rpFrom, setRpFrom] = useState(toISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [rpTo, setRpTo] = useState(toISODate(new Date()));
  const [rpRows, setRpRows] = useState(null);

  const [ruFrom, setRuFrom] = useState(toISODate(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [ruTo, setRuTo] = useState(toISODate(new Date()));
  const [ruRows, setRuRows] = useState(null);

  const [rlYear, setRlYear] = useState(new Date().getFullYear());
  const [rlRows, setRlRows] = useState(null);

  const [rcWeek, setRcWeek] = useState(toISODate(mondayOf(toISODate(new Date()))));
  const [rcRows, setRcRows] = useState(null);

  const [pendingRows, setPendingRows] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const { timesheets, leave } = await api.getPendingApprovalsReport();
        const rows = [...timesheets.map((t) => ({ ...t, kind: "Timesheet" })), ...leave.map((l) => ({ ...l, kind: "Leave" }))]
          .sort((a, b) => b.days_pending - a.days_pending);
        setPendingRows(rows);
      } catch (err) { showError(err); }
    })();
  }, []);

  async function runProject() { try { setRpRows((await api.getProjectHoursReport(rpFrom, rpTo)).rows); } catch (err) { showError(err); } }
  async function runUtilization() { try { setRuRows((await api.getUtilizationReport(ruFrom, ruTo)).rows); } catch (err) { showError(err); } }
  async function runLeave() { try { setRlRows((await api.getLeaveUsageReport(rlYear)).rows); } catch (err) { showError(err); } }
  async function runCompliance() { try { setRcRows((await api.getComplianceReport(rcWeek)).rows); } catch (err) { showError(err); } }

  return (
    <>
      <PageHead eyebrow="Team" title="Reports" sub="Project hours, utilization, leave usage, compliance, and overdue approvals." />
      <div className="tabs">
        <button className={`tab-btn${rtab === "project" ? " active" : ""}`} onClick={() => setRtab("project")}>Project Hours</button>
        <button className={`tab-btn${rtab === "utilization" ? " active" : ""}`} onClick={() => setRtab("utilization")}>Utilization</button>
        <button className={`tab-btn${rtab === "leave" ? " active" : ""}`} onClick={() => setRtab("leave")}>Leave Usage</button>
        <button className={`tab-btn${rtab === "compliance" ? " active" : ""}`} onClick={() => setRtab("compliance")}>Compliance</button>
        <button className={`tab-btn${rtab === "pending" ? " active" : ""}`} onClick={() => setRtab("pending")}>Pending &amp; Overdue</button>
      </div>

      {rtab === "project" ? (
        <div>
          <div className="report-controls">
            <Field label="From"><input type="date" value={rpFrom} onChange={(e) => setRpFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" value={rpTo} onChange={(e) => setRpTo(e.target.value)} /></Field>
            <button className="btn btn-ghost btn-sm" onClick={runProject}>Run</button>
            <a className="btn btn-ghost btn-sm" href={api.projectHoursCsvUrl(rpFrom, rpTo)} download>Export CSV</a>
          </div>
          <Card>
            {!rpRows ? "Pick a date range and click Run." : rpRows.length ? (
              <table>
                <thead><tr><th>Project</th><th>Employee</th><th>Hours</th></tr></thead>
                <tbody>{rpRows.map((r, i) => <tr key={i}><td>{r.project_name || "Unassigned"}</td><td>{r.user_name}</td><td className="mono">{r.hours}h</td></tr>)}</tbody>
              </table>
            ) : <div style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No approved hours logged in this range.</div>}
          </Card>
        </div>
      ) : null}

      {rtab === "utilization" ? (
        <div>
          <div className="report-controls">
            <Field label="From"><input type="date" value={ruFrom} onChange={(e) => setRuFrom(e.target.value)} /></Field>
            <Field label="To"><input type="date" value={ruTo} onChange={(e) => setRuTo(e.target.value)} /></Field>
            <button className="btn btn-ghost btn-sm" onClick={runUtilization}>Run</button>
            <a className="btn btn-ghost btn-sm" href={api.utilizationCsvUrl(ruFrom, ruTo)} download>Export CSV</a>
          </div>
          <Card>
            {!ruRows ? "Pick a date range and click Run." : ruRows.length ? ruRows.map((r, i) => (
              <div className="util-bar-row" key={i}>
                <div className="bar-label">{r.user_name}</div>
                <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.min(100, r.utilization_pct)}%` }} /></div>
                <div className="bar-value">{r.utilization_pct}%</div>
              </div>
            )) : <div style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No data for this range.</div>}
          </Card>
        </div>
      ) : null}

      {rtab === "leave" ? (
        <div>
          <div className="report-controls">
            <Field label="Year"><input type="number" value={rlYear} onChange={(e) => setRlYear(e.target.value)} /></Field>
            <button className="btn btn-ghost btn-sm" onClick={runLeave}>Run</button>
            <a className="btn btn-ghost btn-sm" href={api.leaveUsageCsvUrl(rlYear)} download>Export CSV</a>
          </div>
          <Card>
            {!rlRows ? "Pick a year and click Run." : rlRows.length ? (
              <table>
                <thead><tr><th>Employee</th><th>Leave Type</th><th>Total</th><th>Used</th><th>Pending</th><th>Remaining</th></tr></thead>
                <tbody>{rlRows.map((r, i) => <tr key={i}><td>{r.user_name}</td><td>{r.type_name}</td><td className="mono">{r.total_days}</td><td className="mono">{r.used_days}</td><td className="mono">{r.pending_days}</td><td className="mono">{r.total_days - r.used_days}</td></tr>)}</tbody>
              </table>
            ) : <div style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No leave balance data for this year.</div>}
          </Card>
        </div>
      ) : null}

      {rtab === "compliance" ? (
        <div>
          <div className="report-controls">
            <Field label="Week starting (Monday)"><input type="date" value={rcWeek} onChange={(e) => setRcWeek(e.target.value)} /></Field>
            <button className="btn btn-ghost btn-sm" onClick={runCompliance}>Run</button>
            <a className="btn btn-ghost btn-sm" href={api.complianceCsvUrl(rcWeek)} download>Export CSV</a>
          </div>
          <Card>
            {!rcRows ? "Pick a week and click Run." : rcRows.length ? (
              <table>
                <thead><tr><th>Employee</th><th>Email</th><th>Status</th></tr></thead>
                <tbody>{rcRows.map((r, i) => <tr key={i}><td>{r.user_name}</td><td className="mono">{r.email}</td><td><span className="stamp rejected">{r.status || "not submitted"}</span></td></tr>)}</tbody>
              </table>
            ) : <div style={{ color: "var(--teal)", fontSize: "0.85rem" }}>Everyone submitted for this week. 🎉</div>}
          </Card>
        </div>
      ) : null}

      {rtab === "pending" ? (
        <Card>
          {!pendingRows ? "Loading…" : pendingRows.length ? (
            <table>
              <thead><tr><th>Type</th><th>ID</th><th>Employee</th><th>Manager</th><th>Days Pending</th><th></th></tr></thead>
              <tbody>{pendingRows.map((r, i) => (
                <tr key={i}>
                  <td>{r.kind}</td><td className="mono">{r.id}</td><td>{r.user_name}</td><td>{r.manager_name || "—"}</td><td className="mono">{r.days_pending}</td>
                  <td>{r.escalated ? <span className="escalated-tag">⚠ escalated</span> : null}</td>
                </tr>
              ))}</tbody>
            </table>
          ) : <div style={{ color: "var(--teal)", fontSize: "0.85rem" }}>Nothing pending. 🎉</div>}
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// PROFILE
// ============================================================
const AVATAR_COLORS = ["#2F6F5E", "#C08A2E", "#B4483F", "#3D6B6B", "#5B5FA6", "#8A5B3D"];

export function ProfilePage() {
  const { user, setUser } = useAuth();
  const { showToast, showError } = useToast();
  const [departments, setDepartments] = useState([]);
  const [form, setForm] = useState(null);
  const [color, setColor] = useState(user.avatar_color);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwError, setPwError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { user: u } = await api.me();
        setUser(u);
        setColor(u.avatar_color);
        setForm({
          name: u.name || "", email: u.email || "", employeeCode: u.employee_code || "", phone: u.phone || "",
          location: u.location || "", gender: u.gender || "", uan: u.uan || "", pfNumber: u.pf_number || "",
          pan: u.pan || "", bankAccountNo: u.bank_account_no || "", bankName: u.bank_name || "",
          employeeGroup: u.employee_group || "", dept: u.dept || "",
          emergencyContactName: u.emergency_contact_name || "", emergencyContactPhone: u.emergency_contact_phone || "",
        });
        const { departments: d } = await api.getDepartments();
        setDepartments(d);
      } catch (err) { showError(err); }
    })();
  }, []);

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  async function saveProfile() {
    setSaving(true);
    try {
      if (!form.name.trim() || !form.email.trim()) throw new Error("Name and email are required");
      const payload = { ...form, name: form.name.trim(), email: form.email.trim(), avatarColor: color, pan: form.pan.trim().toUpperCase() };
      const updated = await api.updateMe(payload);
      setUser(updated.user || { ...user, ...payload, avatar_color: color });
      showToast("Profile updated");
    } catch (err) { showError(err); } finally { setSaving(false); }
  }

  async function saveEmergencyContact() {
    try {
      const updated = await api.updateMe({ emergencyContactName: form.emergencyContactName, emergencyContactPhone: form.emergencyContactPhone });
      if (updated.user) setUser(updated.user);
      showToast("Emergency contact saved");
    } catch (err) { showError(err); }
  }

  async function savePassword() {
    setPwError("");
    if (!pwCurrent || !pwNew) { setPwError("Both fields are required."); return; }
    try {
      await api.changePassword(pwCurrent, pwNew);
      showToast("Password updated");
      setPwCurrent(""); setPwNew("");
    } catch (err) { setPwError(err.message); }
  }

  if (!form) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Account" title="My Profile" />
      <Card>
        <div className="profile-head">
          <div className="profile-avatar" style={{ background: color || "#C08A2E" }}>{initials(user.name)}</div>
          <div><h2>{user.name || ""}</h2><span className="role-tag">{user.title || user.role || ""}</span></div>
        </div>
        <Field label="Avatar color">
          <div style={{ display: "flex", gap: ".5rem" }}>
            {AVATAR_COLORS.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)}
                style={{ width: 28, height: 28, borderRadius: "50%", background: c, border: `2px solid ${c === color ? "var(--ink)" : "transparent"}` }} />
            ))}
          </div>
        </Field>
        <div className="form-grid" style={{ marginTop: "1rem" }}>
          <Field label="Full name"><input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Email"><input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
          <Field label="Employee ID"><input type="text" placeholder="e.g. VJT-2461" value={form.employeeCode} onChange={(e) => set("employeeCode", e.target.value)} /></Field>
          <Field label="Phone"><input type="text" value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
          <Field label="Location"><input type="text" placeholder="e.g. Remote / Hyderabad" value={form.location} onChange={(e) => set("location", e.target.value)} /></Field>
          <Field label="Gender">
            <select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
              <option value="">— Select —</option><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option>
            </select>
          </Field>
          <Field label="UAN"><input type="text" value={form.uan} onChange={(e) => set("uan", e.target.value)} /></Field>
          <Field label="PF Number"><input type="text" value={form.pfNumber} onChange={(e) => set("pfNumber", e.target.value)} /></Field>
          <Field label="PAN"><input type="text" style={{ textTransform: "uppercase" }} value={form.pan} onChange={(e) => set("pan", e.target.value)} /></Field>
          <Field label="Bank A/C No."><input type="text" value={form.bankAccountNo} onChange={(e) => set("bankAccountNo", e.target.value)} /></Field>
          <Field label="Bank Name"><input type="text" value={form.bankName} onChange={(e) => set("bankName", e.target.value)} /></Field>
          <Field label="Employee Group"><input type="text" placeholder="e.g. IT-WB" value={form.employeeGroup} onChange={(e) => set("employeeGroup", e.target.value)} /></Field>
          <Field label="Department">
            <select value={form.dept} onChange={(e) => set("dept", e.target.value)}>
              {departments.map((d) => <option key={d.id || d.name} value={d.name}>{d.name}</option>)}
            </select>
          </Field>
          <Field label="Designation"><input type="text" value={user.title || ""} disabled /></Field>
          <Field label="Date of Joining"><input type="text" value={fmtDate(user.joined_date)} disabled /></Field>
          <Field label="Reporting Manager"><input type="text" value={user.manager_name || "—"} disabled /></Field>
        </div>
        <div className="form-actions"><button className="btn btn-primary" disabled={saving} onClick={saveProfile}>Save changes</button></div>
      </Card>
      <Card title="Emergency contact">
        <div className="form-grid">
          <Field label="Contact name"><input type="text" value={form.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} /></Field>
          <Field label="Contact phone"><input type="text" value={form.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} /></Field>
        </div>
        <div className="form-actions"><button className="btn btn-ghost" onClick={saveEmergencyContact}>Save emergency contact</button></div>
      </Card>
      <Card title="Change password">
        <div className="form-grid">
          <Field label="Current password"><input type="password" value={pwCurrent} onChange={(e) => setPwCurrent(e.target.value)} /></Field>
          <Field label="New password"><input type="password" placeholder="At least 8 characters" value={pwNew} onChange={(e) => setPwNew(e.target.value)} /></Field>
        </div>
        {pwError ? <div className="inline-error">{pwError}</div> : null}
        <div className="form-actions"><button className="btn btn-ghost" onClick={savePassword}>Update password</button></div>
      </Card>
    </>
  );
}

// ============================================================
// MY TEAM (manager-only account management)
// ============================================================
export function TeamPage() {
  const { showError } = useToast();
  const [members, setMembers] = useState(null);

  useEffect(() => {
    (async () => { try { setMembers((await api.getTeamMembers()).members); } catch (err) { showError(err); } })();
  }, []);

  return (
    <>
      <PageHead eyebrow="Team" title="My Team" sub="Your direct reports. Reset a password here to issue a temporary one you can share directly." />
      <Card>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Title</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {!members ? <EmptyRow colSpan={5}>Loading…</EmptyRow> : members.length === 0 ? (
              <EmptyRow colSpan={5}>No one reports to you yet.</EmptyRow>
            ) : members.map((m) => (
              <tr key={m.id}>
                <td>{m.name}</td>
                <td className="mono">{m.email}</td>
                <td>{m.title || "—"}</td>
                <td>{m.active ? <span className="stamp approved">active</span> : <span className="stamp rejected">inactive</span>}{m.must_reset_password ? <span className="stamp pending"> pending reset</span> : null}</td>
                <td><ResetPasswordButton userId={m.id} userName={m.name} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// ADMIN — User & System Admin
// ============================================================
function EmployeeRow({ u, onOpenDetails, onViewComp, onGiveHike }) {
  const annualCtc = u.annual_ctc ? `₹${Number(u.annual_ctc).toLocaleString("en-IN")}` : <span style={{ color: "var(--text-dim)" }}>—</span>;
  const monthlyCtc = u.monthly_ctc ? `₹${Number(u.monthly_ctc).toLocaleString("en-IN")}` : <span style={{ color: "var(--text-dim)" }}>—</span>;
  const salaryBadge = u.salary_status === "active" ? <span className="stamp approved">active</span>
    : u.salary_status === "draft" ? <span className="stamp warning">draft</span>
    : <span style={{ color: "var(--text-dim)", fontSize: "0.8rem" }}>No salary</span>;
  return (
    <tr>
      <td><a href="#" style={{ fontWeight: 600, color: "var(--teal)", textDecoration: "underline", textUnderlineOffset: "3px" }} onClick={(e) => { e.preventDefault(); onOpenDetails(u.id); }}>{u.name}</a></td>
      <td className="mono" style={{ fontSize: "0.82rem" }}>{u.email}</td>
      <td>{u.dept || "—"}</td>
      <td style={{ fontSize: "0.85rem" }}>{u.title || "—"}</td>
      <td style={{ fontSize: "0.85rem" }}>{u.manager_name || "—"}</td>
      <td style={{ fontSize: "0.85rem" }}>{u.joined_date || "—"}</td>
      <td style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{annualCtc}</td>
      <td style={{ whiteSpace: "nowrap" }}>{monthlyCtc}</td>
      <td>{salaryBadge}</td>
      <td>{u.active ? <span className="stamp approved">active</span> : <span className="stamp rejected">inactive</span>}</td>
      <td><button className="btn btn-ghost btn-sm" title="View Compensation" onClick={() => onViewComp(u.id)}>Comp</button></td>
      <td><button className="btn btn-ghost btn-sm" title="Give Salary Hike" onClick={() => onGiveHike(u.id, u.name)}>Hike</button></td>
      <td><ResetPasswordButton userId={u.id} userName={u.name} /></td>
    </tr>
  );
}

function EmployeeDetailsModalBody({ userId, onSaved }) {
  const { showError } = useToast();
  const { closeModal } = useModal();
  const [u, setU] = useState(null);
  const [managers, setManagers] = useState([]);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const emp = await api.getUser(userId);
        const { users: mgrs } = await api.getUsersFlat();
        setU(emp);
        setManagers(mgrs);
        setForm({
          name: emp.name || "", email: emp.email || "", employeeCode: emp.employee_code || "", location: emp.location || "",
          gender: emp.gender || "", uan: emp.uan || "", pfNumber: emp.pf_number || "", pan: emp.pan || "",
          bankAccountNo: emp.bank_account_no || "", bankName: emp.bank_name || "", employeeGroup: emp.employee_group || "",
          phone: emp.phone || "", title: emp.title || "", dept: emp.dept || "", joinedDate: emp.joined_date || "",
          role: emp.role, active: emp.active ? "1" : "0", managerId: emp.manager_id || "", delegateId: emp.delegate_id || "",
          emergencyContactName: emp.emergency_contact_name || "", emergencyContactPhone: emp.emergency_contact_phone || "",
        });
      } catch (err) { showError(err); }
    })();
  }, [userId]);

  function set(field, value) { setForm((f) => ({ ...f, [field]: value })); }

  async function update() {
    setSaving(true);
    try {
      const name = form.name.trim(), email = form.email.trim();
      if (!name || !email) throw new Error("Name and email are required");
      await api.updateUser(userId, {
        name, email,
        employeeCode: form.employeeCode.trim() || null, location: form.location.trim() || null, gender: form.gender || null,
        uan: form.uan.trim() || null, pfNumber: form.pfNumber.trim() || null, pan: form.pan.trim().toUpperCase() || null,
        bankAccountNo: form.bankAccountNo.trim() || null, bankName: form.bankName.trim() || null, employeeGroup: form.employeeGroup.trim() || null,
        phone: form.phone.trim() || null, title: form.title.trim() || null, dept: form.dept.trim() || null, joinedDate: form.joinedDate || null,
        role: form.role, active: form.active === "1", managerId: form.managerId || null, delegateId: form.delegateId || null,
        emergencyContactName: form.emergencyContactName.trim() || null, emergencyContactPhone: form.emergencyContactPhone.trim() || null,
      });
      closeModal();
      onSaved();
    } catch (err) { showError(err); } finally { setSaving(false); }
  }

  if (!u || !form) return <div style={{ padding: "1rem 0", color: "var(--text-dim)" }}>Loading…</div>;

  return (
    <>
      <div className="form-grid">
        <Field label="Full name"><input type="text" value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
        <Field label="Email"><input type="email" value={form.email} onChange={(e) => set("email", e.target.value)} /></Field>
        <Field label="Employee ID"><input type="text" value={form.employeeCode} onChange={(e) => set("employeeCode", e.target.value)} /></Field>
        <Field label="Location"><input type="text" value={form.location} onChange={(e) => set("location", e.target.value)} /></Field>
        <Field label="Gender">
          <select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
            <option value="">— Select —</option><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option>
          </select>
        </Field>
        <Field label="UAN"><input type="text" value={form.uan} onChange={(e) => set("uan", e.target.value)} /></Field>
        <Field label="PF Number"><input type="text" value={form.pfNumber} onChange={(e) => set("pfNumber", e.target.value)} /></Field>
        <Field label="PAN"><input type="text" value={form.pan} onChange={(e) => set("pan", e.target.value)} /></Field>
        <Field label="Bank A/C No."><input type="text" value={form.bankAccountNo} onChange={(e) => set("bankAccountNo", e.target.value)} /></Field>
        <Field label="Bank Name"><input type="text" value={form.bankName} onChange={(e) => set("bankName", e.target.value)} /></Field>
        <Field label="Employee Group"><input type="text" value={form.employeeGroup} onChange={(e) => set("employeeGroup", e.target.value)} /></Field>
        <Field label="Phone"><input type="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} /></Field>
        <Field label="Designation / Title"><input type="text" value={form.title} onChange={(e) => set("title", e.target.value)} /></Field>
        <Field label="Department"><input type="text" value={form.dept} onChange={(e) => set("dept", e.target.value)} /></Field>
        <Field label="Date of Joining"><input type="date" value={form.joinedDate} onChange={(e) => set("joinedDate", e.target.value)} /></Field>
        <Field label="Role">
          <select value={form.role} onChange={(e) => set("role", e.target.value)}>
            <option value="employee">Employee</option><option value="manager">Manager</option><option value="admin">Admin</option>
          </select>
        </Field>
        <Field label="Status">
          <select value={form.active} onChange={(e) => set("active", e.target.value)}>
            <option value="1">Active</option><option value="0">Inactive</option>
          </select>
        </Field>
        <Field label="Reporting Manager">
          <select value={form.managerId} onChange={(e) => set("managerId", e.target.value)}>
            <option value="">— None —</option>
            {managers.filter((m) => Number(m.id) !== Number(u.id)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Approval Delegate">
          <select value={form.delegateId} onChange={(e) => set("delegateId", e.target.value)}>
            <option value="">— None —</option>
            {managers.filter((m) => Number(m.id) !== Number(u.id) && m.role !== "employee").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </Field>
        <Field label="Emergency Contact Name"><input type="text" value={form.emergencyContactName} onChange={(e) => set("emergencyContactName", e.target.value)} /></Field>
        <Field label="Emergency Contact Phone"><input type="tel" value={form.emergencyContactPhone} onChange={(e) => set("emergencyContactPhone", e.target.value)} /></Field>
      </div>
      <div style={{ marginTop: "1rem", padding: "0.8rem", border: "1px solid var(--border)", borderRadius: 8, background: "var(--paper-dim)" }}>
        <strong>Payroll</strong><br />
        Annual CTC: {u.annual_ctc ? `₹${Number(u.annual_ctc).toLocaleString("en-IN")}` : "—"} &nbsp;|&nbsp;
        Monthly CTC: {u.monthly_ctc ? `₹${Number(u.monthly_ctc).toLocaleString("en-IN")}` : "—"} &nbsp;|&nbsp;
        Salary status: {u.salary_status || "—"}
      </div>
      <p className="subtle-note" style={{ marginBottom: 0 }}>Review the information. If nothing needs changing, click Close. Click Update to save changes.</p>
      <div className="form-actions">
        <button className="btn btn-ghost" onClick={closeModal}>Close</button>
        <button className="btn btn-primary" disabled={saving} onClick={update}>Update</button>
      </div>
    </>
  );
}

function HikeModalBody({ userId, empName, currentCtc, onApplied }) {
  const { showToast, showError } = useToast();
  const [pct, setPct] = useState("");
  const [amt, setAmt] = useState("");
  const [newCtc, setNewCtc] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");

  const preview = useMemo(() => {
    const p = parseFloat(pct) || 0, a = parseFloat(amt) || 0, nc = parseFloat(newCtc) || 0;
    if (nc > 0) return { newCtc: nc, hikeAmt: nc - currentCtc, hikePct: currentCtc ? ((nc - currentCtc) / currentCtc * 100).toFixed(1) : 0 };
    if (p > 0) return { newCtc: Math.round(currentCtc * (1 + p / 100)), hikeAmt: Math.round(currentCtc * p / 100), hikePct: p };
    if (a > 0) return { newCtc: currentCtc + a, hikeAmt: a, hikePct: currentCtc ? (a / currentCtc * 100).toFixed(1) : 0 };
    return null;
  }, [pct, amt, newCtc, currentCtc]);

  async function confirmHike() {
    const p = parseFloat(pct) || undefined, a = parseFloat(amt) || undefined, nc = parseFloat(newCtc) || undefined;
    if (!p && !a && !nc) { showToast("Enter a hike percentage, amount, or new CTC", true); return; }
    if (!date) { showToast("Effective date is required", true); return; }
    try {
      const result = await api.giveEmployeeHike(userId, { hikePercentage: p, hikeAmount: a, newAnnualCtc: nc, effectiveDate: date, reason: reason.trim() });
      showToast(`Hike applied: New CTC ₹${Number(result.newCtc).toLocaleString("en-IN")} (${result.hikePercentage}% hike)`);
      onApplied();
    } catch (err) { showError(err); }
  }

  return (
    <>
      <div style={{ marginBottom: "1rem" }}>
        <div className="subtle-note">Employee: <strong>{empName}</strong></div>
        <div className="subtle-note">Current Annual CTC: <strong>₹{Number(currentCtc).toLocaleString("en-IN")}</strong></div>
      </div>
      <div className="form-grid">
        <Field label="Hike Percentage (%)"><input type="number" step="0.1" min="0" placeholder="e.g. 10" value={pct} onChange={(e) => { setPct(e.target.value); setAmt(""); setNewCtc(""); }} /></Field>
        <Field label="OR Fixed Amount (₹)"><input type="number" step="1" min="0" placeholder="e.g. 50000" value={amt} onChange={(e) => { setAmt(e.target.value); setPct(""); setNewCtc(""); }} /></Field>
        <Field label="OR New Annual CTC (₹)"><input type="number" step="1" min="0" placeholder="e.g. 1200000" value={newCtc} onChange={(e) => { setNewCtc(e.target.value); setPct(""); setAmt(""); }} /></Field>
        <Field label="Effective Date"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <div className="field full"><label>Reason</label><textarea rows={2} placeholder="e.g. Annual appraisal, promotion..." value={reason} onChange={(e) => setReason(e.target.value)} /></div>
      </div>
      {preview ? (
        <div style={{ background: "var(--bg-dim)", padding: "0.8rem", borderRadius: 8, margin: "0.8rem 0" }}>
          <strong>Preview:</strong> New CTC: ₹{Number(preview.newCtc).toLocaleString("en-IN")} (Hike: {preview.hikePct}% / ₹{Number(preview.hikeAmt).toLocaleString("en-IN")})
        </div>
      ) : null}
      <div className="form-actions"><button className="btn btn-primary" onClick={confirmHike}>Confirm &amp; Apply</button></div>
    </>
  );
}

function CompensationDetail({ userId, onGiveHike }) {
  const { showError } = useToast();
  const [comp, setComp] = useState(null);
  const [revisions, setRevisions] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c, r] = await Promise.all([api.getEmployeeCompensation(userId), api.getEmployeeSalaryRevisions(userId)]);
        if (!cancelled) { setComp(c); setRevisions(r.revisions); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (!comp) return <div style={{ color: "var(--text-dim)" }}>Loading…</div>;
  const s = comp.activeStructure || {};
  const annual = s.annual_ctc || 0, monthly = s.monthly_ctc || 0, basic = s.basic_salary || 0;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBottom: "1rem" }}>
        <div>
          <div className="subtle-note">Employee</div>
          <div style={{ fontWeight: 600 }}>{comp.user.name}</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>{comp.user.email}</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>{comp.user.dept || "No department"} · {comp.user.title || "No title"}</div>
          <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>Joined: {comp.user.joined_date || "Not set"}</div>
        </div>
        <div>
          <div className="subtle-note">Current CTC</div>
          {annual ? (
            <>
              <div style={{ fontSize: "1.3rem", fontWeight: 700, color: "var(--accent)" }}>₹{Number(annual).toLocaleString("en-IN")}/year</div>
              <div style={{ fontSize: "0.9rem" }}>₹{Number(monthly).toLocaleString("en-IN")}/month</div>
              <div style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>Basic: ₹{Number(basic).toLocaleString("en-IN")} · Effective: {s.effective_from || "—"}</div>
            </>
          ) : <div style={{ color: "var(--text-dim)" }}>No salary structure assigned</div>}
        </div>
      </div>
      {comp.components.length ? (
        <div style={{ marginBottom: "1rem" }}>
          <div className="subtle-note" style={{ marginBottom: "0.4rem" }}>Salary Components</div>
          <table>
            <thead><tr><th>Component</th><th>Type</th><th>Category</th><th>Annual</th><th>Monthly</th><th>Taxable</th></tr></thead>
            <tbody>{comp.components.map((cp, i) => (
              <tr key={i}><td>{cp.component_name}</td><td><span className="badge-role">{cp.type}</span></td><td>{cp.category || "—"}</td>
                <td>₹{Number(cp.amount).toLocaleString("en-IN")}</td><td>₹{Math.round(cp.amount / 12).toLocaleString("en-IN")}</td><td>{cp.is_taxable ? "Yes" : "No"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      {revisions && revisions.length ? (
        <div style={{ marginBottom: "1rem" }}>
          <div className="subtle-note" style={{ marginBottom: "0.4rem" }}>Salary Revision History</div>
          <table>
            <thead><tr><th>Date</th><th>Type</th><th>Previous CTC</th><th>New CTC</th><th>Hike</th><th>Approved By</th></tr></thead>
            <tbody>{revisions.map((r, i) => (
              <tr key={i}><td>{r.effective_date}</td><td><span className="badge-role">{r.revision_type}</span></td>
                <td>{r.previous_annual_ctc ? "₹" + Number(r.previous_annual_ctc).toLocaleString("en-IN") : "—"}</td>
                <td style={{ fontWeight: 600 }}>₹{Number(r.new_annual_ctc).toLocaleString("en-IN")}</td>
                <td>{r.hike_percentage ? r.hike_percentage + "%" : r.hike_amount ? "₹" + Number(r.hike_amount).toLocaleString("en-IN") : "—"}</td>
                <td>{r.actor_name || "—"}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : null}
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button className="btn btn-primary btn-sm" onClick={() => onGiveHike(comp.user.id, comp.user.name, annual)}>Give Hike</button>
      </div>
    </>
  );
}

export function AdminPage() {
  const { showToast, showError } = useToast();
  const { openModal, closeModal } = useModal();

  // Directory state
  const [empPage, setEmpPage] = useState(1);
  const [empSearch, setEmpSearch] = useState("");
  const [empDept, setEmpDept] = useState("");
  const [empStatus, setEmpStatus] = useState("");
  const [empSortBy, setEmpSortBy] = useState("name");
  const [empDir, setEmpDir] = useState(null); // { items, total }
  const [depts, setDepts] = useState([]);

  const [types, setTypes] = useState([]);
  const [holidays, setHolidays] = useState([]);
  const [settings, setSettings] = useState(null);
  const [projects, setProjects] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [departments, setDepartments] = useState([]);

  const [showAddUser, setShowAddUser] = useState(false);
  const [newUser, setNewUser] = useState({ name: "", email: "", role: "employee", title: "", dept: "", joinedDate: new Date().toISOString().slice(0, 10), password: "" });

  const [compUserId, setCompUserId] = useState(null);

  const [reloadKey, setReloadKey] = useState(0);
  function reload() { setReloadKey((k) => k + 1); }

  const loadDirectory = useCallback(async () => {
    try {
      const result = await api.getAdminEmployees({ page: empPage, pageSize: 50, search: empSearch, department: empDept, status: empStatus, sortBy: empSortBy, sortDir: "asc" });
      setEmpDir(result);
    } catch (err) { showError(err); }
  }, [empPage, empSearch, empDept, empStatus, empSortBy]);

  useEffect(() => { loadDirectory(); }, [loadDirectory, reloadKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Do not make the entire admin page depend on one auxiliary request.
      // After the SQLite -> PostgreSQL migration, a single broken subsystem
      // could previously leave `settings` null forever and show only a loader.
      const jobs = [
        ["departments", api.getAdminDepartments()],
        ["leave types", api.getLeaveTypes()],
        ["holidays", api.getHolidays()],
        ["settings", api.getSettings()],
        ["projects", api.getProjects(true)],
        ["tasks", api.getTasks(true)],
        ["all departments", api.getDepartments(true)],
      ];
      const results = await Promise.allSettled(jobs.map(([, promise]) => promise));
      if (cancelled) return;

      const failed = [];
      const value = (index, label) => {
        const result = results[index];
        if (result.status === "fulfilled") return result.value;
        failed.push(`${label}: ${result.reason?.message || "request failed"}`);
        return null;
      };

      const adminDepartments = value(0, jobs[0][0]);
      const leaveTypes = value(1, jobs[1][0]);
      const holidayResult = value(2, jobs[2][0]);
      const systemSettings = value(3, jobs[3][0]);
      const projectResult = value(4, jobs[4][0]);
      const taskResult = value(5, jobs[5][0]);
      const allDepartmentResult = value(6, jobs[6][0]);

      if (adminDepartments) setDepts(adminDepartments.departments || []);
      if (leaveTypes) setTypes(leaveTypes);
      if (holidayResult) setHolidays(holidayResult.holidays || []);
      setSettings(systemSettings || {});
      if (projectResult) setProjects(projectResult.projects || []);
      if (taskResult) setTasks(taskResult.tasks || []);
      if (allDepartmentResult) setDepartments(allDepartmentResult.departments || []);

      if (failed.length) showError(new Error(`Admin data: ${failed.join("; ")}`));
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  const debouncedSearch = useMemo(() => debounce((v) => { setEmpPage(1); setEmpSearch(v); }, 300), []);

  function openEmployeeDetails(userId) {
    openModal(`Employee`, <EmployeeDetailsModalBody userId={userId} onSaved={() => { showToast("Employee information updated"); reload(); }} />, null);
  }
  function openGiveHikeFor(userId, empName, currentCtc) {
    openModal(`Give Salary Hike — ${empName}`, <HikeModalBody userId={userId} empName={empName} currentCtc={currentCtc || 0} onApplied={() => { closeModal(); reload(); }} />, null);
  }
  async function openGiveHikeById(userId, empName) {
    try {
      const comp = await api.getEmployeeCompensation(userId);
      openGiveHikeFor(userId, empName, comp.activeStructure ? comp.activeStructure.annual_ctc : 0);
    } catch (err) { showError(err); }
  }
  function openCompensation(userId) { setCompUserId(userId); }

  async function createUser() {
    if (!newUser.name.trim() || !newUser.email.trim()) { showToast("Name and email are required", true); return; }
    try {
      await api.createUser({ ...newUser, name: newUser.name.trim(), email: newUser.email.trim(), dept: newUser.dept.trim(), title: newUser.title.trim(), password: newUser.password.trim() || undefined, joinedDate: newUser.joinedDate || undefined });
      showToast(`User ${newUser.name} created`);
      setShowAddUser(false);
      setNewUser({ name: "", email: "", role: "employee", title: "", dept: "", joinedDate: new Date().toISOString().slice(0, 10), password: "" });
      reload();
    } catch (err) { showError(err); }
  }

  function openImportCsv() {
    let csv = "";
    openModal("Import users from CSV", (
      <>
        <p className="subtle-note" style={{ marginTop: 0 }}>Paste CSV with columns: name, email, role, dept, title. Only name and email are required.</p>
        <div className="field"><textarea style={{ minHeight: "8rem" }} placeholder={"name,email,role,dept\nJane Doe,jane@company.com,employee,Sales"} onChange={(e) => { csv = e.target.value; }} /></div>
      </>
    ), (
      <>
        <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          if (!csv.trim()) { showToast("Paste CSV content first", true); return; }
          try {
            const result = await api.importUsersCsv(csv.trim());
            closeModal();
            showToast(`Imported ${result.created} user(s), skipped ${result.skipped}`);
            reload();
          } catch (err) { showError(err); }
        }}>Import</button>
      </>
    ));
  }

  function openAddProject() {
    let name = "", code = "";
    openModal("Add project", (
      <>
        <Field label="Project name"><input type="text" onChange={(e) => { name = e.target.value; }} /></Field>
        <Field label="Code (optional)"><input type="text" placeholder="e.g. CLI-ACME" onChange={(e) => { code = e.target.value; }} /></Field>
      </>
    ), (
      <>
        <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          if (!name.trim()) { showToast("Project name is required", true); return; }
          try { await api.addProject({ name: name.trim(), code: code.trim() }); closeModal(); showToast("Project added"); reload(); } catch (err) { showError(err); }
        }}>Add</button>
      </>
    ));
  }

  function openAddTask(projectId, projectName) {
    let name = "";
    openModal(`Add task — ${projectName}`, (
      <Field label="Task name"><input type="text" placeholder="e.g. Development" onChange={(e) => { name = e.target.value; }} /></Field>
    ), (
      <>
        <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          if (!name.trim()) { showToast("Task name is required", true); return; }
          try { await api.addTask(projectId, name.trim()); closeModal(); showToast("Task added"); reload(); } catch (err) { showError(err); }
        }}>Add</button>
      </>
    ));
  }

  async function toggleProject(p) {
    try { await api.toggleProject(p.id, p.active ? 0 : 1); showToast(p.active ? "Project deactivated" : "Project activated"); reload(); } catch (err) { showError(err); }
  }

  async function openManageAssignments(project) {
    try {
      const [{ items: allUsers }, { members }] = await Promise.all([api.getUsers(100), api.getProjectAssignments(project.id)]);
      const assignedIds = new Set(members.map((m) => m.id));
      let checked = {};
      allUsers.forEach((u) => { checked[u.id] = assignedIds.has(u.id); });
      openModal(`Assign employees — ${project.name}`, (
        <>
          <div className="checkbox-list">
            {allUsers.filter((u) => u.role !== "admin").map((u) => (
              <label className="checkbox-list-item" key={u.id}>
                <input type="checkbox" defaultChecked={checked[u.id]} onChange={(e) => { checked[u.id] = e.target.checked; }} />
                <span>{u.name} <span style={{ color: "var(--text-dim)" }}>({u.email})</span></span>
              </label>
            ))}
          </div>
          <p className="subtle-note">If no one is assigned, this project falls back to visible-to-everyone.</p>
        </>
      ), (
        <>
          <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
          <button className="btn btn-primary" onClick={async () => {
            const userIds = Object.keys(checked).filter((id) => checked[id]).map((id) => parseInt(id, 10));
            try { await api.saveProjectAssignments(project.id, userIds); closeModal(); showToast("Assignments updated"); } catch (err) { showError(err); }
          }}>Save assignments</button>
        </>
      ));
    } catch (err) { showError(err); }
  }

  function openAddDept() {
    let name = "";
    openModal("Add department", (
      <Field label="Department name"><input type="text" onChange={(e) => { name = e.target.value; }} /></Field>
    ), (
      <>
        <button className="btn btn-ghost" onClick={closeModal}>Cancel</button>
        <button className="btn btn-primary" onClick={async () => {
          if (!name.trim()) { showToast("Department name is required", true); return; }
          try { await api.addDepartment(name.trim()); closeModal(); showToast("Department added"); reload(); } catch (err) { showError(err); }
        }}>Add</button>
      </>
    ));
  }
  async function toggleDept(d) {
    try { await api.toggleDepartment(d.id, d.active ? 0 : 1); showToast(d.active ? "Department deactivated" : "Department activated"); reload(); } catch (err) { showError(err); }
  }

  if (!settings) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Administration" title="User & System Admin" sub="Manage accounts, projects, departments, leave types, holidays, and system settings."
        actions={<>
          <button className="btn btn-ghost btn-sm" onClick={openImportCsv}>Import CSV</button>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddUser((v) => !v)}>+ Add user</button>
        </>} />

      {showAddUser ? (
        <Card title="New user">
          <div className="form-grid">
            <Field label="Full name"><input type="text" value={newUser.name} onChange={(e) => setNewUser((u) => ({ ...u, name: e.target.value }))} /></Field>
            <Field label="Email"><input type="email" value={newUser.email} onChange={(e) => setNewUser((u) => ({ ...u, email: e.target.value }))} /></Field>
            <Field label="Role">
              <select value={newUser.role} onChange={(e) => setNewUser((u) => ({ ...u, role: e.target.value }))}>
                <option value="employee">Employee</option><option value="manager">Manager</option><option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Title"><input type="text" value={newUser.title} onChange={(e) => setNewUser((u) => ({ ...u, title: e.target.value }))} /></Field>
            <Field label="Department">
              <select value={newUser.dept} onChange={(e) => setNewUser((u) => ({ ...u, dept: e.target.value }))}>
                <option value="">— None —</option>
                {departments.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Date joined"><input type="date" value={newUser.joinedDate} onChange={(e) => setNewUser((u) => ({ ...u, joinedDate: e.target.value }))} /></Field>
            <Field label="Temporary password"><input type="text" placeholder="changeme123" value={newUser.password} onChange={(e) => setNewUser((u) => ({ ...u, password: e.target.value }))} /></Field>
          </div>
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setShowAddUser(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createUser}>Create user</button>
          </div>
        </Card>
      ) : null}

      <Card title={`Employee Directory (${empDir ? empDir.total : "…"})`}>
        <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.75rem", flexWrap: "wrap" }}>
          <input type="text" placeholder="Search name, email, title..." style={{ flex: 1, minWidth: 150, padding: "0.4rem 0.6rem", border: "1px solid var(--border)", borderRadius: 6 }}
            onChange={(e) => debouncedSearch(e.target.value)} />
          <select style={{ padding: "0.4rem 0.6rem", border: "1px solid var(--border)", borderRadius: 6 }} value={empDept} onChange={(e) => { setEmpPage(1); setEmpDept(e.target.value); }}>
            <option value="">All Departments</option>
            {depts.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select style={{ padding: "0.4rem 0.6rem", border: "1px solid var(--border)", borderRadius: 6 }} value={empStatus} onChange={(e) => { setEmpPage(1); setEmpStatus(e.target.value); }}>
            <option value="">All Status</option><option value="active">Active</option><option value="inactive">Inactive</option>
          </select>
          <select style={{ padding: "0.4rem 0.6rem", border: "1px solid var(--border)", borderRadius: 6 }} value={empSortBy} onChange={(e) => { setEmpPage(1); setEmpSortBy(e.target.value); }}>
            <option value="name">Name</option><option value="annual_ctc">Annual CTC</option><option value="dept">Department</option><option value="joined_date">Joining Date</option>
          </select>
          <button className="btn btn-ghost btn-sm" onClick={loadDirectory}>Refresh</button>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Name</th><th>Email</th><th>Department</th><th>Title</th><th>Manager</th><th>Joined</th>
                <th>Annual CTC</th><th>Monthly CTC</th><th>Salary Status</th><th>Status</th><th></th><th></th><th></th>
              </tr>
            </thead>
            <tbody>
              {!empDir ? <EmptyRow colSpan={13}>Loading…</EmptyRow> : empDir.items.map((u) => (
                <EmployeeRow key={u.id} u={u} onOpenDetails={openEmployeeDetails} onViewComp={openCompensation} onGiveHike={openGiveHikeById} />
              ))}
            </tbody>
          </table>
        </div>
        {empDir ? (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: "0.5rem", fontSize: "0.85rem" }}>
            <span>Showing {empDir.items.length} of {empDir.total} employees</span>
            <div style={{ display: "flex", gap: "0.4rem" }}>
              <button className="btn btn-ghost btn-sm" disabled={empPage <= 1} onClick={() => setEmpPage((p) => p - 1)}>← Prev</button>
              <button className="btn btn-ghost btn-sm" disabled={empPage * 50 >= empDir.total} onClick={() => setEmpPage((p) => p + 1)}>Next →</button>
            </div>
          </div>
        ) : null}
      </Card>

      {compUserId ? (
        <Card title={<>Employee Compensation <button className="btn btn-ghost btn-sm" style={{ float: "right" }} onClick={() => setCompUserId(null)}>Close</button></>}>
          <CompensationDetail userId={compUserId} onGiveHike={(id, name, ctc) => openGiveHikeFor(id, name, ctc)} />
        </Card>
      ) : null}

      <Card title="Projects & tasks">
        <p className="subtle-note" style={{ marginTop: 0 }}>Employees log timesheet hours against these. Only employees assigned to a project can select it — if a project has no assignments yet, everyone sees it as a fallback.</p>
        <table>
          <thead><tr><th>Project</th><th>Code</th><th>Tasks</th><th>Assigned</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {projects.length === 0 ? <EmptyRow colSpan={6}>No projects yet.</EmptyRow> : projects.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="mono">{p.code || "—"}</td>
                <td>{tasks.filter((t) => t.project_id === p.id).map((t) => t.name).join(", ") || <span style={{ color: "var(--text-dim)" }}>No tasks yet</span>}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => openManageAssignments(p)}>Manage</button></td>
                <td>{p.active ? "Active" : "Inactive"}</td>
                <td>
                  <button className="btn btn-ghost btn-sm" onClick={() => openAddTask(p.id, p.name)}>+ Task</button>{" "}
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleProject(p)}>{p.active ? "Deactivate" : "Activate"}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-actions"><button className="btn btn-ghost btn-sm" onClick={openAddProject}>+ Add project</button></div>
      </Card>

      <Card title="Departments">
        <table>
          <thead><tr><th>Name</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {departments.length === 0 ? <EmptyRow colSpan={3}>No departments yet.</EmptyRow> : departments.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td><td>{d.active ? "Active" : "Inactive"}</td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => toggleDept(d)}>{d.active ? "Deactivate" : "Activate"}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="form-actions"><button className="btn btn-ghost btn-sm" onClick={openAddDept}>+ Add department</button></div>
      </Card>

      <Card title="Leave types & annual allocation">
        <p className="subtle-note" style={{ marginTop: 0 }}>Carry-forward defines how many unused days roll into next year at year-end.</p>
        <table>
          <thead><tr><th>Leave type</th><th>Default annual days</th><th>Max carry-forward</th><th>Status</th></tr></thead>
          <tbody>
            {types.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td><td className="mono">{t.default_annual_days || "—"}</td>
                <td className="mono">{t.max_carry_forward_days || 0}</td><td>{t.active ? "Active" : "Inactive"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="Company holidays & blackout periods">
        <div style={{ marginBottom: "1rem" }}>
          {holidays.length === 0 ? <span style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No holidays configured.</span> : holidays.map((h) => (
            <span className={`holiday-chip${h.blackout ? " blackout" : ""}`} key={h.id}>{fmtDate(h.holiday_date)} — {h.name} {h.blackout ? "(blackout)" : ""}</span>
          ))}
        </div>
      </Card>

      <Card title="System settings">
        <div className="form-grid">
          <Field label="Standard hours per day"><input type="number" defaultValue={settings.standard_hours_per_day} disabled /></Field>
          <Field label="Timesheet lock (weeks)"><input type="number" defaultValue={settings.timesheet_lock_weeks} disabled /></Field>
          <Field label="Financial year start month"><input type="number" min="1" max="12" defaultValue={settings.financial_year_start_month} disabled /></Field>
          <Field label="Company name"><input type="text" defaultValue={settings.company_name} disabled /></Field>
          <Field label="Submission deadline (weekday, 1=Mon..7=Sun)"><input type="number" min="1" max="7" defaultValue={settings.submission_deadline_day} disabled /></Field>
          <Field label="Escalation threshold (days pending)"><input type="number" defaultValue={settings.escalation_days} disabled /></Field>
        </div>
        <p className="subtle-note">Read-only in this build — matches the original app, where these controls weren't wired to save either.</p>
      </Card>
    </>
  );
}

// ============================================================
// MY SALARY
// ============================================================
export function MySalaryPage({ navTo }) {
  const { user } = useAuth();
  const { showError } = useToast();
  const [data, setData] = useState(null);
  const [noFy, setNoFy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const fy = await api.getFinancialYears();
        const activeFy = fy.financialYears.find((f) => f.is_active) || fy.financialYears[0];
        if (!activeFy) { setNoFy(true); return; }
        const [{ structures }, { regime }, taxSummary] = await Promise.all([
          api.getSalaryStructures(user.id), api.getMyTaxRegime(activeFy.id),
          api.getMyTaxSummary(activeFy.id).catch(() => ({ taxLiability: null })),
        ]);
        const active = structures.find((s) => s.status === "active") || structures[0];
        setData({ activeFy, active, regime, taxLiability: taxSummary.taxLiability });
      } catch (err) { showError(err); }
    })();
  }, [user.id]);

  if (noFy) return <div className="card">No financial year configured. Contact administrator.</div>;
  if (!data) return <PageLoading />;
  const { activeFy, active, regime, taxLiability } = data;

  return (
    <>
      <PageHead eyebrow="Payroll" title={`My Salary — ${activeFy.name}`} sub="Your salary structure and tax details for the current financial year." />
      {active ? (
        <>
          <div className="stat-grid">
            <StatCard label="Annual CTC" value={fmtMoney(active.annual_ctc)} foot="per year" />
            <StatCard label="Monthly CTC" value={fmtMoney(active.monthly_ctc)} foot="per month" />
            <StatCard label="Status" value={<Stamp status={active.status} />} foot="salary structure" />
            <StatCard label="Tax Regime" value={regime ? regime.regime_name : "—"} foot={regime ? "selected" : "not selected"} />
          </div>
          {taxLiability ? (
            <div className="two-col">
              <Card title="Tax Summary">
                <table>
                  <tbody>
                    <tr><td className="text-dim">Annual Taxable Income</td><td className="mono">{fmtMoneyDec(taxLiability.taxableIncome)}</td></tr>
                    <tr><td className="text-dim">Income Tax</td><td className="mono">{fmtMoneyDec(taxLiability.incomeTax)}</td></tr>
                    <tr><td className="text-dim">Cess</td><td className="mono">{fmtMoneyDec(taxLiability.cess)}</td></tr>
                    <tr><td className="text-dim">Total Annual Tax</td><td className="mono"><strong>{fmtMoneyDec(taxLiability.totalTax)}</strong></td></tr>
                    <tr><td className="text-dim">Monthly TDS</td><td className="mono">{fmtMoneyDec(taxLiability.totalTax / 12)}</td></tr>
                  </tbody>
                </table>
              </Card>
              <Card title="Previous Employer Income">
                <div className="subtle-note">Not provided. <button className="btn btn-ghost btn-sm" onClick={() => navTo("my-tax-declaration")}>Declare Now</button></div>
              </Card>
            </div>
          ) : null}
        </>
      ) : (
        <Card title="No Salary Structure">
          <p style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>Your salary structure has not been set up yet. Please contact your administrator.</p>
        </Card>
      )}
    </>
  );
}

// ============================================================
// MY TAX DECLARATION
// ============================================================
function TaxSectionCard({ sec, decl, isDraft, onAddEntry, onDeleteEntry }) {
  const entries = decl ? decl.entries : [];
  const totalDeclared = entries.reduce((s, e) => s + (e.amount || 0), 0);
  const statusLabel = decl ? decl.status : "not started";
  const [invType, setInvType] = useState("");
  const [provider, setProvider] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState("");

  return (
    <div className="card" style={{ marginBottom: "0.8rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
        <div>
          <strong>{sec.section_name}</strong>
          {sec.max_limit ? <span style={{ color: "var(--text-dim)", fontSize: "0.8rem", marginLeft: "0.5rem" }}>Limit: {fmtMoney(sec.max_limit)}</span> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <span className={`stamp ${statusLabel === "submitted" ? "pending" : statusLabel === "verified" ? "approved" : "draft"}`}>{statusLabel}</span>
          <span className="mono" style={{ fontSize: "0.85rem" }}>{fmtMoney(totalDeclared)}</span>
        </div>
      </div>
      {entries.length ? (
        <table style={{ marginBottom: "0.5rem" }}>
          <thead><tr><th>Type</th><th>Provider</th><th>Amount</th><th>Date</th><th>Status</th><th></th></tr></thead>
          <tbody>{entries.map((e) => (
            <tr key={e.id}>
              <td>{e.investment_type || "—"}</td><td>{e.provider_name || "—"}</td><td className="mono">{fmtMoney(e.amount)}</td>
              <td>{fmtDate(e.investment_date)}</td><td><Stamp status={e.status || "draft"} /></td>
              <td>{isDraft ? <button className="btn btn-ghost btn-sm" title="Remove" onClick={() => onDeleteEntry(e.id)}>✕</button> : null}</td>
            </tr>
          ))}</tbody>
        </table>
      ) : null}
      {isDraft ? (
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
          <input type="text" placeholder="Type (e.g. PPF, LIC)" style={{ width: 120 }} className="input-sm" value={invType} onChange={(e) => setInvType(e.target.value)} />
          <input type="text" placeholder="Provider" style={{ width: 120 }} className="input-sm" value={provider} onChange={(e) => setProvider(e.target.value)} />
          <input type="number" placeholder="Amount" style={{ width: 100 }} className="input-sm" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input type="date" className="input-sm" value={date} onChange={(e) => setDate(e.target.value)} />
          <button className="btn btn-sm btn-primary" onClick={() => onAddEntry(sec.id, { invType, provider, amount, date })}>+ Add</button>
        </div>
      ) : null}
    </div>
  );
}

export function MyTaxDeclarationPage() {
  const { showToast, showError } = useToast();
  const [noFy, setNoFy] = useState(false);
  const [state, setState] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [compareOpen, setCompareOpen] = useState(false);
  const [comparison, setComparison] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fy = await api.getFinancialYears();
        const activeFy = fy.financialYears.find((f) => f.is_active) || fy.financialYears[0];
        if (!activeFy) { setNoFy(true); return; }
        const [declarationsData, sectionsData, regimesData, myRegimeData] = await Promise.all([
          api.getMyTaxDeclarations(activeFy.id), api.getTaxDeclarationSections(activeFy.id),
          api.getTaxRegimes(activeFy.id), api.getMyTaxRegime(activeFy.id),
        ]);
        if (!cancelled) setState({
          activeFy, declarations: declarationsData.declarations, sections: sectionsData.sections,
          regimes: regimesData.regimes, selectedRegime: myRegimeData.regime,
        });
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function selectRegime(regimeId) {
    try {
      await api.setMyTaxRegime(state.activeFy.id, regimeId);
      showToast("Tax regime updated");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  async function openCompare() {
    try {
      const { comparison: c } = await api.compareMyTaxRegimes(state.activeFy.id);
      setComparison(c);
      setCompareOpen(true);
    } catch (err) { showError(err); }
  }

  async function addEntry(sectionId, { invType, provider, amount, date }) {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) { showToast("Enter a valid amount", true); return; }
    try {
      const { id: declId } = await api.createOrGetTaxDeclaration(state.activeFy.id, sectionId);
      await api.addTaxDeclarationEntry(declId, { investmentType: invType, providerName: provider, amount: amt, investmentDate: date });
      showToast("Entry added");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  async function deleteEntry(entryId) {
    if (!window.confirm("Remove this entry?")) return;
    try {
      await api.deleteTaxDeclarationEntry(entryId);
      showToast("Entry removed");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  async function submitAll() {
    try {
      await api.submitAllTaxDeclarations(state.activeFy.id);
      showToast("Declarations submitted");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  if (noFy) return <div className="card">No financial year configured.</div>;
  if (!state) return <PageLoading />;
  const { activeFy, declarations, sections, regimes, selectedRegime } = state;

  const regimeBlock = regimes.length ? (
    <Card style={{ marginBottom: "1.1rem" }} title="Choose Your Tax Regime">
      <p style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: "0.8rem" }}>
        {selectedRegime
          ? <>You're currently on the <strong>{selectedRegime.regime_name}</strong> for {activeFy.name}. You can switch any time before payroll is finalized for this year.</>
          : "Pick a regime to see which deduction sections apply to you. Not sure? Compare both first."}
      </p>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {regimes.map((r) => (
          <button key={r.id} className={`btn btn-sm ${selectedRegime && selectedRegime.tax_regime_id === r.id ? "btn-primary" : "btn-ghost"}`} onClick={() => selectRegime(r.id)}>{r.name}</button>
        ))}
        <button className="btn btn-sm btn-ghost" onClick={openCompare}>Compare Regimes</button>
      </div>
    </Card>
  ) : null;

  const compareModal = compareOpen ? (
    <div style={{ display: "flex", position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000, alignItems: "center", justifyContent: "center" }}>
      <div className="card" style={{ maxWidth: 600, width: "90%", maxHeight: "80vh", overflow: "auto", padding: "1.5rem" }}>
        <div className="card-title">Tax Regime Comparison</div>
        {comparison && comparison.comparison && comparison.comparison.length ? (
          <>
            <p style={{ fontSize: "0.85rem", color: "var(--text-dim)", marginBottom: "1rem" }}>Recommended: <strong>{comparison.lower_tax_regime}</strong></p>
            <table>
              <thead><tr><th>Item</th>{comparison.comparison.map((r) => <th key={r.regime_name} className={r.is_lower_tax ? "mono" : ""}>{r.regime_name}{r.is_lower_tax ? " ✓" : ""}</th>)}</tr></thead>
              <tbody>
                {[
                  ["Taxable Income", "taxable_income"], ["Income Tax", "income_tax"], ["Total Annual Tax (incl. cess)", "total_annual_tax"],
                  ["Monthly TDS", "monthly_tds"], ["Est. Annual Take-home", "estimated_annual_takehome"],
                ].map(([label, key]) => (
                  <tr key={key}>
                    <td>{label}</td>
                    {comparison.comparison.map((r) => <td key={r.regime_name} className="mono" style={r.is_lower_tax ? { background: "var(--teal-soft)" } : undefined}>{fmtMoneyDec(r[key])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        ) : <p style={{ color: "var(--text-dim)" }}>Set up your salary structure first to see a comparison.</p>}
        <button className="btn btn-ghost" style={{ marginTop: "1rem" }} onClick={() => setCompareOpen(false)}>Close</button>
      </div>
    </div>
  ) : null;

  if (!selectedRegime) {
    return (
      <>
        <PageHead eyebrow="Tax" title={`Tax Declaration — ${activeFy.name}`} sub="Declare your tax-saving investments and deductions for this financial year." />
        {regimeBlock}
        <div className="card"><p style={{ color: "var(--text-dim)" }}>Choose a tax regime above to see the deduction sections that apply to you.</p></div>
        {compareModal}
      </>
    );
  }

  const regimeCode = selectedRegime.regime_code;
  const visibleSections = sections.filter((s) => s.applicable_regime === "both" || s.applicable_regime === regimeCode);
  const newRegimeNote = regimeCode === "new" ? (
    <Card style={{ marginBottom: "0.8rem" }} title={<span style={{ fontSize: "0.9rem" }}>About the New Regime</span>}>
      <p style={{ fontSize: "0.85rem", color: "var(--text-dim)" }}>
        Most exemptions and deductions (80C, 80D, HRA, home loan interest, and others) don't apply under the new regime.
        The flat standard deduction and any employer NPS contribution (80CCD(2)) are applied automatically during payroll —
        there's nothing to declare for those. The section below is the one exception that still needs your input.
      </p>
    </Card>
  ) : null;

  return (
    <>
      <PageHead eyebrow="Tax" title={`Tax Declaration — ${activeFy.name}`} sub="Declare your tax-saving investments and deductions for this financial year." />
      {regimeBlock}
      {newRegimeNote}
      {visibleSections.length === 0 ? (
        <div className="card"><p style={{ color: "var(--text-dim)" }}>No declaration sections apply under this regime.</p></div>
      ) : visibleSections.map((sec) => {
        const decl = declarations.find((d) => d.section_id === sec.id);
        const isDraft = !decl || decl.status === "draft";
        return <TaxSectionCard key={sec.id} sec={sec} decl={decl} isDraft={isDraft} onAddEntry={addEntry} onDeleteEntry={deleteEntry} />;
      })}
      {visibleSections.length ? (
        <div style={{ marginTop: "1rem", display: "flex", gap: "0.5rem" }}>
          <button className="btn btn-primary" onClick={submitAll}>Submit All Declarations</button>
        </div>
      ) : null}
      {compareModal}
    </>
  );
}

// ============================================================
// MY PAYSLIPS
// ============================================================
export function MyPayslipsPage() {
  const { showError, showToast } = useToast();
  const [noFy, setNoFy] = useState(false);
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const fy = await api.getFinancialYears();
        const activeFy = fy.financialYears.find((f) => f.is_active) || fy.financialYears[0];
        if (!activeFy) { setNoFy(true); return; }
        const { payslips } = await api.getMyPayslips(activeFy.id);
        setData({ activeFy, payslips });
      } catch (err) { showError(err); }
    })();
  }, []);

  function download(id) {
    if (!id) { showToast("Payslip not found", true); return; }
    const a = document.createElement("a");
    a.href = api.payslipPdfUrl(id);
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  if (noFy) return <div className="card">No financial year configured.</div>;
  if (!data) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Payroll" title={`My Payslips — ${data.activeFy.name}`} sub="View and download your monthly payslips." />
      <Card>
        <table>
          <thead><tr><th>Month</th><th>Gross</th><th>Deductions</th><th>TDS</th><th>Net Pay</th><th></th></tr></thead>
          <tbody>
            {data.payslips.length === 0 ? <EmptyRow colSpan={6}>No payslips generated yet for this financial year.</EmptyRow> : data.payslips.map((p) => (
              <tr key={p.id}>
                <td>{p.payroll_month}</td><td className="mono">{fmtMoneyDec(p.gross_earning)}</td><td className="mono">{fmtMoneyDec(p.total_deductions)}</td>
                <td className="mono">{fmtMoneyDec(p.tds_deduction)}</td><td className="mono"><strong>{fmtMoneyDec(p.net_salary)}</strong></td>
                <td><button className="btn btn-ghost btn-sm" onClick={() => download(p.id)}>Download PDF</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// PAYROLL DASHBOARD (admin)
// ============================================================
export function PayrollDashboardPage({ navTo }) {
  const { showError } = useToast();
  const [noFy, setNoFy] = useState(false);
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const fy = await api.getFinancialYears();
        const activeFy = fy.financialYears.find((f) => f.is_active) || fy.financialYears[0];
        if (!activeFy) { setNoFy(true); return; }
        const { dashboard } = await api.getPayrollDashboard(activeFy.id);
        setData({ activeFy, dashboard });
      } catch (err) { showError(err); }
    })();
  }, []);

  if (noFy) return <div className="card">No financial year configured.</div>;
  if (!data) return <PageLoading />;
  const { activeFy, dashboard } = data;

  return (
    <>
      <PageHead eyebrow="Payroll Admin" title={`Payroll Dashboard — ${activeFy.name}`} sub="Overview of payroll status for the current financial year." />
      <div className="stat-grid">
        <StatCard label="Total Employees" value={dashboard.totalEmployees} />
        <StatCard label="Processed Runs" value={dashboard.processed} foot={`of ${dashboard.processed + dashboard.pending} total`} tone="amber" />
        <StatCard label="Total Gross Payroll" value={fmtMoney(dashboard.totalGross)} />
        <StatCard label="Total Net Payroll" value={fmtMoney(dashboard.totalNetPayroll)} />
        <StatCard label="Total TDS" value={fmtMoney(dashboard.totalTds)} />
        <StatCard label="Open Exceptions" value={dashboard.payrollExceptions} tone={dashboard.payrollExceptions ? "amber" : undefined} />
        <StatCard label="Missing Salary Setup" value={dashboard.employeesMissingSalary} foot="employees without salary structure" tone={dashboard.employeesMissingSalary ? "amber" : undefined} />
        <StatCard label="Pending Tax Proofs" value={dashboard.pendingTaxProofs} tone={dashboard.pendingTaxProofs ? "amber" : undefined} />
      </div>

      {dashboard.currentRun ? (
        <Card style={{ marginTop: "1rem" }} title={`Current Month: ${dashboard.currentMonth}`}>
          <PayrollStagePath status={dashboard.currentRun.status} />
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap", marginTop: "0.9rem" }}>
            <div><span className="text-dim">Run Status:</span> <Stamp status={dashboard.currentRun.status} /></div>
            <div><span className="text-dim">Employees:</span> <span className="mono">{dashboard.currentRun.total_employees}</span></div>
            <div><span className="text-dim">Gross:</span> <span className="mono">{fmtMoney(dashboard.currentRun.total_gross)}</span></div>
            <div><span className="text-dim">Net:</span> <span className="mono">{fmtMoney(dashboard.currentRun.total_net)}</span></div>
          </div>
        </Card>
      ) : null}

      <Card style={{ marginTop: "1rem" }} title="Quick Actions">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button className="btn btn-primary btn-sm" onClick={() => navTo("payroll-run")}>Manage Payroll Runs</button>
          <button className="btn btn-ghost btn-sm" onClick={() => navTo("salary-admin")}>Salary Setup</button>
        </div>
      </Card>
    </>
  );
}

// ============================================================
// PAYROLL RUN (admin)
// ============================================================
function RunDetailPanel({ runId }) {
  const { showToast, showError } = useToast();
  const [details, setDetails] = useState(null);
  const [exceptions, setExceptions] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [{ details: d }, { exceptions: ex }] = await Promise.all([api.getPayrollRunDetails(runId), api.getPayrollRunExceptions(runId)]);
        if (!cancelled) { setDetails(d); setExceptions(ex); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [runId, reloadKey]);

  async function generate(payrollDetailId) {
    try {
      const result = await api.generatePayslip(payrollDetailId);
      showToast("Payslip generated — downloading PDF");
      const a = document.createElement("a");
      a.href = api.payslipPdfUrl(result.id);
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) { showToast(err.message || "Could not generate payslip", true); }
  }
  async function resolveException(id) {
    try {
      await api.resolvePayrollException(id, "Reviewed");
      showToast("Exception resolved");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  if (!details) return <div style={{ color: "var(--text-dim)" }}>Loading…</div>;
  const unresolved = (exceptions || []).filter((e) => !e.is_resolved);

  return (
    <Card style={{ marginTop: "1rem" }} title={`Run #${runId} — ${details.length} employees`}>
      {unresolved.length ? (
        <div style={{ marginBottom: "1rem" }}>
          <div className="card-title" style={{ fontSize: "0.85rem" }}>Exceptions ({unresolved.length})</div>
          {unresolved.map((e) => (
            <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem", padding: "0.4rem 0", borderBottom: "1px solid var(--line)", fontSize: "0.85rem" }}>
              <div><span className={`stamp ${e.severity === "error" ? "rejected" : "pending"}`}>{e.severity || "warning"}</span><span style={{ marginLeft: "0.5rem" }}>{e.exception_message || e.exception_code}</span></div>
              <button className="btn btn-ghost btn-sm" onClick={() => resolveException(e.id)}>Resolve</button>
            </div>
          ))}
        </div>
      ) : null}
      <table>
        <thead><tr><th>Employee</th><th>Gross</th><th>Deductions</th><th>TDS</th><th>Net</th><th>Payslip</th></tr></thead>
        <tbody>
          {details.length === 0 ? <EmptyRow colSpan={6}>No details.</EmptyRow> : details.map((d) => (
            <tr key={d.id}>
              <td>{d.user_name}</td><td className="mono">{fmtMoneyDec(d.gross_earning)}</td><td className="mono">{fmtMoneyDec(d.total_deductions)}</td>
              <td className="mono">{fmtMoneyDec(d.tds_deduction)}</td><td className="mono"><strong>{fmtMoneyDec(d.net_salary)}</strong></td>
              <td><button className="btn btn-ghost btn-sm" onClick={() => generate(d.id)}>Generate</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function PayrollRunPage() {
  const { showToast, showError } = useToast();
  const [noFy, setNoFy] = useState(false);
  const [activeFy, setActiveFy] = useState(null);
  const [runs, setRuns] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newMonth, setNewMonth] = useState("");
  const [detailRunId, setDetailRunId] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const fy = await api.getFinancialYears();
        const fyActive = fy.financialYears.find((f) => f.is_active) || fy.financialYears[0];
        if (!fyActive) { setNoFy(true); return; }
        setActiveFy(fyActive);
        const { runs: r } = await api.getPayrollRuns(fyActive.id);
        if (!cancelled) setRuns(r);
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function createRun() {
    if (!newMonth) { showToast("Select a month", true); return; }
    try {
      await api.createPayrollRun(activeFy.id, newMonth);
      showToast("Payroll run created");
      setShowCreate(false);
      setNewMonth("");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  async function act(runId, action) {
    if (action === "calculate" && !window.confirm("Calculate payroll for all active employees?")) return;
    if (action === "approve" && !window.confirm("Approve this payroll run? This cannot be undone.")) return;
    if (action === "lock" && !window.confirm("Lock this payroll run? No further changes allowed.")) return;
    try {
      const result = await api.actOnPayrollRun(runId, action);
      showToast(result.totalEmployees ? `Calculated: ${result.totalEmployees} employees` : `Run ${action}d`);
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message, true); }
  }

  async function deleteRun(run) {
    if (!window.confirm(`Delete the ${run.payroll_month} payroll run? All pre-lock calculations, exceptions, and generated payslips for this run will be removed. You can then create the same month again and rerun payroll. This cannot be undone.`)) return;
    try {
      await api.deletePayrollRun(run.id);
      showToast(`Payroll run ${run.payroll_month} deleted. You can create it again.`);
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message, true); }
  }

  if (noFy) return <div className="card">No financial year configured.</div>;
  if (!runs) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Payroll Admin" title="Payroll Runs" sub="Create, calculate, and manage monthly payroll runs."
        actions={<button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>Create New Run</button>} />

      {showCreate ? (
        <Card style={{ marginBottom: "1rem" }} title="New Payroll Run">
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "end", flexWrap: "wrap" }}>
            <div>
              <label className="field-label">Month (YYYY-MM)</label>
              <input type="month" className="input-sm" required value={newMonth} onChange={(e) => setNewMonth(e.target.value)} />
            </div>
            <button className="btn btn-primary btn-sm" onClick={createRun}>Create</button>
            <button className="btn btn-ghost btn-sm" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </Card>
      ) : null}

      <Card>
        <table>
          <thead><tr><th>Month</th><th>Status</th><th>Employees</th><th>Gross</th><th>Net</th><th>TDS</th><th>Actions</th></tr></thead>
          <tbody>
            {runs.length === 0 ? <EmptyRow colSpan={7}>No payroll runs yet. Click "Create New Run" to start.</EmptyRow> : runs.map((r) => (
              <tr key={r.id}>
                <td>{r.payroll_month}</td>
                <td><Stamp status={r.status} /><div style={{ marginTop: "0.35rem" }}><PayrollStagePath status={r.status} compact /></div></td>
                <td className="mono">{r.total_employees || 0}</td>
                <td className="mono">{fmtMoney(r.total_gross)}</td><td className="mono">{fmtMoney(r.total_net)}</td><td className="mono">{fmtMoney(r.total_tds)}</td>
                <td>
                  <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                    {r.status === "draft" ? <button className="btn btn-sm btn-primary" onClick={() => act(r.id, "calculate")}>Calculate</button> : null}
                    {["calculated", "reviewed", "approved"].includes(r.status) ? <button className="btn btn-sm btn-primary" onClick={() => act(r.id, "calculate")}>Update &amp; Recalculate</button> : null}
                    {r.status === "calculated" ? <button className="btn btn-sm btn-primary" onClick={() => act(r.id, "review")}>Review</button> : null}
                    {r.status === "reviewed" ? <button className="btn btn-sm btn-primary" onClick={() => act(r.id, "approve")}>Approve</button> : null}
                    {r.status === "approved" ? <button className="btn btn-sm btn-primary" onClick={() => act(r.id, "lock")}>Lock</button> : null}
                    {!["locked", "disbursed"].includes(r.status) ? <button className="btn btn-sm btn-ghost" onClick={() => deleteRun(r)}>Delete &amp; Rerun</button> : null}
                    <button className="btn btn-sm btn-ghost" onClick={() => setDetailRunId(r.id)}>Details</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {detailRunId ? <RunDetailPanel runId={detailRunId} key={`${detailRunId}-${reloadKey}`} /> : null}
    </>
  );
}

// ============================================================
// SALARY ADMIN — build/activate salary structures
// (React only sends component amounts the admin types; the backend computes
// CTC totals, PF, gratuity, insurance and any derived math.)
// ============================================================
function ComponentRow({ c, onChange, onRemove, disabled }) {
  return (
    <tr>
      <td><input type="text" className="input-sm" value={c.componentName} disabled={disabled} onChange={(e) => onChange({ ...c, componentName: e.target.value })} /></td>
      <td>
        <select className="input-sm" value={c.type} disabled={disabled} onChange={(e) => onChange({ ...c, type: e.target.value })}>
          <option value="earning">Earning</option><option value="deduction">Deduction</option>
        </select>
      </td>
      <td><input type="text" className="input-sm" placeholder="e.g. allowance" value={c.category} disabled={disabled} onChange={(e) => onChange({ ...c, category: e.target.value })} /></td>
      <td><input type="number" className="input-sm" value={c.amount} disabled={disabled} onChange={(e) => onChange({ ...c, amount: e.target.value })} /></td>
      <td><input type="checkbox" checked={!!c.isTaxable} disabled={disabled} onChange={(e) => onChange({ ...c, isTaxable: e.target.checked })} /></td>
      <td>{!disabled ? <button className="btn btn-ghost btn-sm" onClick={onRemove}>✕</button> : null}</td>
    </tr>
  );
}

export function SalaryAdminPage() {
  const { showToast, showError } = useToast();
  const [employees, setEmployees] = useState(null);
  const [userId, setUserId] = useState("");
  const [structures, setStructures] = useState(null);
  const [openStructureId, setOpenStructureId] = useState(null);
  const [openStructure, setOpenStructure] = useState(null);
  const [components, setComponents] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);

  const [showNew, setShowNew] = useState(false);
  const [newAnnualCtc, setNewAnnualCtc] = useState("");
  const [newBasic, setNewBasic] = useState("");
  const [newEffectiveFrom, setNewEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));

  useEffect(() => {
    (async () => { try { setEmployees((await api.getUsersFlat()).users.filter((u) => u.role !== "admin")); } catch (err) { showError(err); } })();
  }, []);

  useEffect(() => {
    if (!userId) { setStructures(null); return; }
    let cancelled = false;
    (async () => {
      try { const { structures: s } = await api.getSalaryStructures(userId); if (!cancelled) setStructures(s); }
      catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [userId, reloadKey]);

  useEffect(() => {
    if (!openStructureId) { setOpenStructure(null); setComponents([]); return; }
    let cancelled = false;
    (async () => {
      try {
        const s = await api.getSalaryStructure(openStructureId);
        if (!cancelled) { setOpenStructure(s); setComponents((s.components || []).map((c) => ({ id: c.id, componentName: c.component_name, type: c.type, category: c.category || "", amount: c.amount, isTaxable: !!c.is_taxable }))); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [openStructureId, reloadKey]);

  async function createStructure() {
    const ctc = parseFloat(newAnnualCtc);
    if (!ctc || ctc <= 0) { showToast("Enter a valid annual CTC", true); return; }
    try {
      const { id } = await api.createSalaryStructure({
        userId: parseInt(userId, 10), annualCtc: ctc, basicSalary: parseFloat(newBasic) || undefined, effectiveFrom: newEffectiveFrom,
      });
      showToast("Salary structure created (draft)");
      setShowNew(false); setNewAnnualCtc(""); setNewBasic("");
      setReloadKey((k) => k + 1);
      setOpenStructureId(id);
    } catch (err) { showError(err); }
  }

  function addComponentRow() {
    setComponents((c) => [...c, { componentName: "", type: "earning", category: "", amount: "", isTaxable: true }]);
  }
  function updateComponentRow(idx, next) {
    setComponents((c) => c.map((row, i) => (i === idx ? next : row)));
  }
  function removeComponentRow(idx) {
    setComponents((c) => c.filter((_, i) => i !== idx));
  }

  async function saveComponents() {
    const cleaned = components
      .filter((c) => c.componentName.trim() && parseFloat(c.amount) > 0)
      .map((c) => ({ componentName: c.componentName.trim(), type: c.type, category: c.category.trim() || null, amount: parseFloat(c.amount), isTaxable: !!c.isTaxable }));
    try {
      await api.saveSalaryStructureComponents(openStructureId, cleaned);
      showToast("Components saved");
      setReloadKey((k) => k + 1);
    } catch (err) { showError(err); }
  }

  async function activate() {
    if (!window.confirm("Activate this salary structure? It will become the employee's active salary and any previous active structure will be superseded.")) return;
    try {
      await api.activateSalaryStructure(openStructureId);
      showToast("Salary structure activated");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message, true); }
  }

  const isDraft = openStructure && openStructure.status === "draft";

  return (
    <>
      <PageHead eyebrow="Payroll Admin" title="Salary Setup" sub="Build and activate salary structures per employee. All CTC, PF, gratuity, and tax math is computed by the backend when payroll runs." />
      <Card>
        <Field label="Employee">
          <select value={userId} onChange={(e) => { setUserId(e.target.value); setOpenStructureId(null); }}>
            <option value="">— Select employee —</option>
            {(employees || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </Field>
      </Card>

      {userId ? (
        <Card title="Salary Structures" right={<button className="btn btn-primary btn-sm" onClick={() => setShowNew((v) => !v)}>+ New Structure</button>}>
          {showNew ? (
            <div className="form-grid" style={{ marginBottom: "0.8rem" }}>
              <Field label="Annual CTC (₹)"><input type="number" value={newAnnualCtc} onChange={(e) => setNewAnnualCtc(e.target.value)} /></Field>
              <Field label="Basic Salary (₹, optional)"><input type="number" value={newBasic} onChange={(e) => setNewBasic(e.target.value)} /></Field>
              <Field label="Effective from"><input type="date" value={newEffectiveFrom} onChange={(e) => setNewEffectiveFrom(e.target.value)} /></Field>
              <div className="field full"><button className="btn btn-primary btn-sm" onClick={createStructure}>Create draft</button></div>
            </div>
          ) : null}
          <table>
            <thead><tr><th>Annual CTC</th><th>Monthly CTC</th><th>Effective From</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {!structures ? <EmptyRow colSpan={5}>Loading…</EmptyRow> : structures.length === 0 ? <EmptyRow colSpan={5}>No salary structures yet for this employee.</EmptyRow> : structures.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{fmtMoney(s.annual_ctc)}</td><td className="mono">{fmtMoney(s.monthly_ctc)}</td><td>{s.effective_from}</td>
                  <td><Stamp status={s.status} /></td>
                  <td><button className="btn btn-ghost btn-sm" onClick={() => setOpenStructureId(s.id)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {openStructure ? (
        <Card title={`Structure — ${fmtMoney(openStructure.annual_ctc)}/yr (${openStructure.status})`}>
          <table>
            <thead><tr><th>Component</th><th>Type</th><th>Category</th><th>Annual Amount (₹)</th><th>Taxable</th><th></th></tr></thead>
            <tbody>
              {components.map((c, i) => (
                <ComponentRow key={c.id || i} c={c} disabled={!isDraft} onChange={(next) => updateComponentRow(i, next)} onRemove={() => removeComponentRow(i)} />
              ))}
            </tbody>
          </table>
          {isDraft ? (
            <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.8rem", flexWrap: "wrap" }}>
              <button className="btn btn-ghost btn-sm" onClick={addComponentRow}>+ Add component</button>
              <button className="btn btn-primary btn-sm" onClick={saveComponents}>Save components</button>
              <button className="btn btn-primary btn-sm" onClick={activate}>Activate structure</button>
            </div>
          ) : (
            <p className="subtle-note">This structure is {openStructure.status} and can no longer be edited.</p>
          )}
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// Route registry — maps view id -> page component.
// Consumed by App.jsx so the sidebar/routing logic stays tiny.
// ============================================================
// ============================================================
// MY BENEFITS (employee/manager self-service — loans, advances,
// leave encashment, gratuity estimate)
// ============================================================
export function MyBenefitsPage() {
  const { user } = useAuth();
  const { showToast, showError } = useToast();
  const [loans, setLoans] = useState(null);
  const [advances, setAdvances] = useState(null);
  const [encashments, setEncashments] = useState(null);
  const [gratuity, setGratuity] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [loanForm, setLoanForm] = useState({ principalAmount: "", interestRateAnnual: "0", tenureMonths: "", purpose: "" });
  const [advanceForm, setAdvanceForm] = useState({ amount: "", reason: "", recoveryMonths: "1" });
  const [encashDays, setEncashDays] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [leaveTypes, setLeaveTypes] = useState([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [l, a, e, g, lt] = await Promise.all([
          api.getLoansForEmployee(user.id),
          api.getAdvancesForEmployee(user.id),
          api.getLeaveEncashmentsForEmployee(user.id),
          api.getGratuityEstimate(user.id).catch(() => null),
          api.getLeaveTypes ? api.getLeaveTypes().catch(() => ({ leaveTypes: [] })) : Promise.resolve({ leaveTypes: [] }),
        ]);
        if (cancelled) return;
        setLoans(l); setAdvances(a); setEncashments(e); setGratuity(g);
        setLeaveTypes(lt.leaveTypes || lt || []);
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [user.id, reloadKey]);

  async function submitLoan(e) {
    e.preventDefault();
    try {
      await api.requestLoan(user.id, {
        principalAmount: Number(loanForm.principalAmount),
        interestRateAnnual: Number(loanForm.interestRateAnnual) || 0,
        tenureMonths: Number(loanForm.tenureMonths),
        purpose: loanForm.purpose,
      });
      showToast("Loan request submitted");
      setLoanForm({ principalAmount: "", interestRateAnnual: "0", tenureMonths: "", purpose: "" });
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not submit loan request", true); }
  }

  async function submitAdvance(e) {
    e.preventDefault();
    try {
      await api.requestAdvance(user.id, {
        amount: Number(advanceForm.amount), reason: advanceForm.reason, recoveryMonths: Number(advanceForm.recoveryMonths) || 1,
      });
      showToast("Salary advance request submitted");
      setAdvanceForm({ amount: "", reason: "", recoveryMonths: "1" });
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not submit advance request", true); }
  }

  async function submitEncashment(e) {
    e.preventDefault();
    if (!leaveTypeId) { showToast("Select a leave type", true); return; }
    try {
      await api.requestLeaveEncashment(user.id, { leaveTypeId: Number(leaveTypeId), days: Number(encashDays) });
      showToast("Leave encashment request submitted");
      setEncashDays(""); setLeaveTypeId("");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not submit encashment request", true); }
  }

  if (!loans || !advances || !encashments) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Payroll" title="My Benefits" sub="Loans, salary advances, leave encashment and your gratuity estimate." />

      {gratuity ? (
        <div className="stat-grid" style={{ marginBottom: "1rem" }}>
          <StatCard label="Years of Service" value={gratuity.yearsOfService} />
          <StatCard label="Gratuity Eligible" value={gratuity.eligible ? "Yes" : "No"} foot={`from ${gratuity.eligibilityThresholdYears} years`} tone={gratuity.eligible ? undefined : "amber"} />
          <StatCard label="Estimated Gratuity" value={fmtMoney(gratuity.gratuityAmount)} foot="on last-drawn basic, not yet payable" />
        </div>
      ) : null}

      <div className="two-col">
        <Card title="Request a Loan">
          <form onSubmit={submitLoan} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Field label="Principal Amount">
              <input type="number" className="input-sm" value={loanForm.principalAmount} onChange={(e) => setLoanForm({ ...loanForm, principalAmount: e.target.value })} required />
            </Field>
            <Field label="Annual Interest Rate (%)">
              <input type="number" className="input-sm" value={loanForm.interestRateAnnual} onChange={(e) => setLoanForm({ ...loanForm, interestRateAnnual: e.target.value })} />
            </Field>
            <Field label="Tenure (months)">
              <input type="number" className="input-sm" value={loanForm.tenureMonths} onChange={(e) => setLoanForm({ ...loanForm, tenureMonths: e.target.value })} required />
            </Field>
            <Field label="Purpose">
              <input type="text" className="input-sm" value={loanForm.purpose} onChange={(e) => setLoanForm({ ...loanForm, purpose: e.target.value })} />
            </Field>
            <button className="btn btn-primary btn-sm" type="submit">Submit Loan Request</button>
          </form>
          <table style={{ marginTop: "0.8rem" }}>
            <thead><tr><th>Principal</th><th>EMI</th><th>Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {loans.length === 0 ? <EmptyRow colSpan={4}>No loans yet.</EmptyRow> : loans.map((l) => (
                <tr key={l.id}>
                  <td className="mono">{fmtMoney(l.principal_amount)}</td>
                  <td className="mono">{l.emi_amount ? fmtMoney(l.emi_amount) : "—"}</td>
                  <td className="mono">{fmtMoney(l.outstanding_balance)}</td>
                  <td><Stamp status={l.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Request a Salary Advance">
          <form onSubmit={submitAdvance} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <Field label="Amount">
              <input type="number" className="input-sm" value={advanceForm.amount} onChange={(e) => setAdvanceForm({ ...advanceForm, amount: e.target.value })} required />
            </Field>
            <Field label="Reason">
              <input type="text" className="input-sm" value={advanceForm.reason} onChange={(e) => setAdvanceForm({ ...advanceForm, reason: e.target.value })} />
            </Field>
            <Field label="Preferred Recovery (months)">
              <input type="number" className="input-sm" value={advanceForm.recoveryMonths} onChange={(e) => setAdvanceForm({ ...advanceForm, recoveryMonths: e.target.value })} />
            </Field>
            <button className="btn btn-primary btn-sm" type="submit">Submit Advance Request</button>
          </form>
          <table style={{ marginTop: "0.8rem" }}>
            <thead><tr><th>Amount</th><th>Monthly Recovery</th><th>Outstanding</th><th>Status</th></tr></thead>
            <tbody>
              {advances.length === 0 ? <EmptyRow colSpan={4}>No advances yet.</EmptyRow> : advances.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{fmtMoney(a.amount)}</td>
                  <td className="mono">{a.monthly_recovery_amount ? fmtMoney(a.monthly_recovery_amount) : "—"}</td>
                  <td className="mono">{fmtMoney(a.outstanding_balance)}</td>
                  <td><Stamp status={a.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <Card style={{ marginTop: "1rem" }} title="Leave Encashment">
        <form onSubmit={submitEncashment} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "0.8rem" }}>
          <Field label="Leave Type">
            <select className="input-sm" value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)}>
              <option value="">Select…</option>
              {leaveTypes.map((lt) => <option key={lt.id} value={lt.id}>{lt.name}</option>)}
            </select>
          </Field>
          <Field label="Days to Encash">
            <input type="number" className="input-sm" value={encashDays} onChange={(e) => setEncashDays(e.target.value)} required />
          </Field>
          <button className="btn btn-primary btn-sm" type="submit">Request Encashment</button>
        </form>
        <table>
          <thead><tr><th>Leave Type</th><th>Days</th><th>Amount</th><th>Status</th></tr></thead>
          <tbody>
            {encashments.length === 0 ? <EmptyRow colSpan={4}>No leave encashment requests yet.</EmptyRow> : encashments.map((e) => (
              <tr key={e.id}>
                <td>{e.leave_type_name}</td><td className="mono">{e.days}</td>
                <td className="mono">{fmtMoney(e.amount)}</td><td><Stamp status={e.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// PAYROLL BENEFITS ADMIN (loans / advances / leave encashment approvals)
// ============================================================
export function PayrollBenefitsAdminPage() {
  const { showToast, showError } = useToast();
  const [tab, setTab] = useState("loans");
  const [loans, setLoans] = useState(null);
  const [advances, setAdvances] = useState(null);
  const [encashments, setEncashments] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [l, a, e] = await Promise.all([api.getAllLoans(), api.getAllAdvances(), api.getAllLeaveEncashments()]);
        if (!cancelled) { setLoans(l); setAdvances(a); setEncashments(e); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function actLoan(id, decision) {
    try { await api.decideLoan(id, decision); showToast(`Loan ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not update loan", true); }
  }
  async function disburse(id) {
    try { await api.disburseLoan(id); showToast("Loan disbursed"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not disburse loan", true); }
  }
  async function actAdvance(id, decision) {
    try { await api.decideAdvance(id, decision); showToast(`Advance ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not update advance", true); }
  }
  async function actEncashment(id, decision) {
    try { await api.decideLeaveEncashment(id, decision); showToast(`Encashment ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not update encashment", true); }
  }

  if (!loans || !advances || !encashments) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Payroll Admin" title="Loans, Advances & Leave Encashment" sub="Review and approve employee loan, salary advance and leave encashment requests." />
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button className={`btn btn-sm ${tab === "loans" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("loans")}>Loans ({loans.length})</button>
        <button className={`btn btn-sm ${tab === "advances" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("advances")}>Advances ({advances.length})</button>
        <button className={`btn btn-sm ${tab === "encashment" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("encashment")}>Leave Encashment ({encashments.length})</button>
      </div>

      {tab === "loans" ? (
        <Card title="Loan Requests">
          <table>
            <thead><tr><th>Employee</th><th>Principal</th><th>Tenure</th><th>EMI</th><th>Outstanding</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {loans.length === 0 ? <EmptyRow colSpan={7}>No loan requests.</EmptyRow> : loans.map((l) => (
                <tr key={l.id}>
                  <td>{l.user_name}</td><td className="mono">{fmtMoney(l.principal_amount)}</td>
                  <td className="mono">{l.tenure_months}mo</td>
                  <td className="mono">{l.emi_amount ? fmtMoney(l.emi_amount) : "—"}</td>
                  <td className="mono">{fmtMoney(l.outstanding_balance)}</td>
                  <td><Stamp status={l.status} /></td>
                  <td style={{ display: "flex", gap: "0.3rem" }}>
                    {l.status === "pending" ? (<>
                      <button className="btn btn-ghost btn-sm" onClick={() => actLoan(l.id, "approved")}>Approve</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => actLoan(l.id, "rejected")}>Reject</button>
                    </>) : null}
                    {l.status === "approved" ? <button className="btn btn-primary btn-sm" onClick={() => disburse(l.id)}>Disburse</button> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "advances" ? (
        <Card title="Salary Advance Requests">
          <table>
            <thead><tr><th>Employee</th><th>Amount</th><th>Recovery</th><th>Outstanding</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {advances.length === 0 ? <EmptyRow colSpan={6}>No advance requests.</EmptyRow> : advances.map((a) => (
                <tr key={a.id}>
                  <td>{a.user_name}</td><td className="mono">{fmtMoney(a.amount)}</td>
                  <td className="mono">{a.monthly_recovery_amount ? `${fmtMoney(a.monthly_recovery_amount)}/mo` : `${a.recovery_months}mo`}</td>
                  <td className="mono">{fmtMoney(a.outstanding_balance)}</td>
                  <td><Stamp status={a.status} /></td>
                  <td style={{ display: "flex", gap: "0.3rem" }}>
                    {a.status === "pending" ? (<>
                      <button className="btn btn-ghost btn-sm" onClick={() => actAdvance(a.id, "approved")}>Approve</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => actAdvance(a.id, "rejected")}>Reject</button>
                    </>) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "encashment" ? (
        <Card title="Leave Encashment Requests">
          <table>
            <thead><tr><th>Employee</th><th>Leave Type</th><th>Days</th><th>Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {encashments.length === 0 ? <EmptyRow colSpan={6}>No leave encashment requests.</EmptyRow> : encashments.map((e) => (
                <tr key={e.id}>
                  <td>{e.user_name}</td><td>{e.leave_type_name}</td><td className="mono">{e.days}</td>
                  <td className="mono">{fmtMoney(e.amount)}</td><td><Stamp status={e.status} /></td>
                  <td style={{ display: "flex", gap: "0.3rem" }}>
                    {e.status === "pending" ? (<>
                      <button className="btn btn-ghost btn-sm" onClick={() => actEncashment(e.id, "approved")}>Approve</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => actEncashment(e.id, "rejected")}>Reject</button>
                    </>) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// PAYROLL REPORTS — month-to-month comparison & variance
// ============================================================
export function PayrollReportsPage() {
  const { showError } = useToast();
  const [fy, setFy] = useState(null);
  const [monthA, setMonthA] = useState("");
  const [monthB, setMonthB] = useState("");
  const [threshold, setThreshold] = useState("10");
  const [comparison, setComparison] = useState(null);
  const [variance, setVariance] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const { financialYears } = await api.getFinancialYears();
        const active = financialYears.find((f) => f.is_active) || financialYears[0];
        setFy(active);
      } catch (err) { showError(err); }
    })();
  }, []);

  async function run() {
    if (!fy || !monthA || !monthB) return;
    setBusy(true);
    try {
      const [cmp, vr] = await Promise.all([
        api.getPayrollComparisonReport(fy.id, monthA, monthB),
        api.getPayrollVarianceReport(fy.id, monthA, monthB, Number(threshold) || 10),
      ]);
      setComparison(cmp); setVariance(vr);
    } catch (err) { showError(err); }
    finally { setBusy(false); }
  }

  return (
    <>
      <PageHead eyebrow="Payroll Admin" title="Payroll Reports" sub="Compare two payroll months and flag employees whose net pay swung beyond a threshold." />
      <Card title="Choose Months to Compare">
        <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Month A"><input type="month" className="input-sm" value={monthA} onChange={(e) => setMonthA(e.target.value)} /></Field>
          <Field label="Month B"><input type="month" className="input-sm" value={monthB} onChange={(e) => setMonthB(e.target.value)} /></Field>
          <Field label="Variance Threshold (%)"><input type="number" className="input-sm" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
          <button className="btn btn-primary btn-sm" disabled={busy || !monthA || !monthB} onClick={run}>Compare</button>
        </div>
      </Card>

      {comparison ? (
        <Card style={{ marginTop: "1rem" }} title={`Totals: ${comparison.monthA} vs ${comparison.monthB}`}>
          <div className="stat-grid">
            <StatCard label="Gross (A → B)" value={`${fmtMoney(comparison.totals.grossA)} → ${fmtMoney(comparison.totals.grossB)}`} />
            <StatCard label="Net (A → B)" value={`${fmtMoney(comparison.totals.netA)} → ${fmtMoney(comparison.totals.netB)}`} />
            <StatCard label="TDS (A → B)" value={`${fmtMoney(comparison.totals.tdsA)} → ${fmtMoney(comparison.totals.tdsB)}`} />
            <StatCard label="Headcount (A → B)" value={`${comparison.totals.headcountA} → ${comparison.totals.headcountB}`} />
          </div>
          <table style={{ marginTop: "0.8rem" }}>
            <thead><tr><th>Employee</th><th>Net A</th><th>Net B</th><th>Δ Net</th></tr></thead>
            <tbody>
              {comparison.employees.map((e) => (
                <tr key={e.userId}>
                  <td>{e.userName}{!e.presentInA ? " (new)" : ""}{!e.presentInB ? " (not in B)" : ""}</td>
                  <td className="mono">{fmtMoneyDec(e.netA)}</td><td className="mono">{fmtMoneyDec(e.netB)}</td>
                  <td className="mono" style={{ color: e.netDelta > 0 ? "var(--ok, #2a9d5c)" : e.netDelta < 0 ? "var(--danger, #d64545)" : undefined }}>
                    {e.netDelta > 0 ? "+" : ""}{fmtMoneyDec(e.netDelta)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {variance ? (
        <Card style={{ marginTop: "1rem" }} title={`Variance Flags (≥ ${variance.thresholdPercent}%)`}>
          <table>
            <thead><tr><th>Employee</th><th>Net A</th><th>Net B</th><th>% Change</th></tr></thead>
            <tbody>
              {variance.flagged.length === 0 ? <EmptyRow colSpan={4}>No employee exceeded the threshold.</EmptyRow> : variance.flagged.map((e) => (
                <tr key={e.userId}>
                  <td>{e.userName}</td><td className="mono">{fmtMoneyDec(e.netA)}</td><td className="mono">{fmtMoneyDec(e.netB)}</td>
                  <td className="mono">{e.pctChange > 0 ? "+" : ""}{e.pctChange}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// MY ATTENDANCE (employee self-service — check in/out, calendar, corrections)
// ============================================================
const ATTENDANCE_STATUS_LABEL = {
  present: "Present", absent: "Absent", half_day: "Half Day", wfh: "Work From Home",
  on_duty: "On Duty", holiday: "Holiday", weekly_off: "Weekly Off", leave: "Leave", pending: "—",
};

export function MyAttendancePage() {
  const { user } = useAuth();
  const { showToast, showError } = useToast();
  const [today, setToday] = useState(null);
  const [busy, setBusy] = useState(false);
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 }; });
  const [calendar, setCalendar] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [showCorrectionFor, setShowCorrectionFor] = useState(null);
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionStatus, setCorrectionStatus] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [t, cal, corr] = await Promise.all([
          api.getTodayAttendance(),
          api.getAttendanceCalendar(user.id, cursor.year, cursor.month),
          api.getAttendanceCorrectionsForEmployee(user.id),
        ]);
        if (cancelled) return;
        setToday(t); setCalendar(cal); setCorrections(corr);
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [user.id, cursor.year, cursor.month, reloadKey]);

  async function doCheckIn() {
    setBusy(true);
    try { await api.checkIn(); showToast("Checked in"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not check in", true); }
    finally { setBusy(false); }
  }
  async function doCheckOut() {
    setBusy(true);
    try { await api.checkOut(); showToast("Checked out"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not check out", true); }
    finally { setBusy(false); }
  }

  async function submitCorrection(date) {
    try {
      await api.requestAttendanceCorrection(user.id, { date, requestedStatus: correctionStatus || undefined, reason: correctionReason });
      showToast("Correction request submitted");
      setShowCorrectionFor(null); setCorrectionReason(""); setCorrectionStatus("");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not submit correction request", true); }
  }

  function shiftMonth(delta) {
    setCursor((c) => {
      let month = c.month + delta, year = c.year;
      if (month < 1) { month = 12; year--; } if (month > 12) { month = 1; year++; }
      return { year, month };
    });
  }

  if (!today || !calendar || !corrections) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Attendance" title="My Attendance" sub="Check in and out, review your monthly calendar, and request corrections." />

      <Card title="Today">
        <div style={{ display: "flex", gap: "1rem", alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "0.85rem", opacity: 0.7 }}>Status</div>
            <div style={{ fontWeight: 600 }}>{ATTENDANCE_STATUS_LABEL[today.status] || today.status}</div>
          </div>
          {today.check_in_at ? (
            <div><div style={{ fontSize: "0.85rem", opacity: 0.7 }}>Checked in</div><div>{fmtDateTime(today.check_in_at)}</div></div>
          ) : null}
          {today.check_out_at ? (
            <div><div style={{ fontSize: "0.85rem", opacity: 0.7 }}>Checked out</div><div>{fmtDateTime(today.check_out_at)}</div></div>
          ) : null}
          <div style={{ marginLeft: "auto", display: "flex", gap: "0.5rem" }}>
            {!today.check_in_at ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={doCheckIn}>Check In</button> : null}
            {today.check_in_at && !today.check_out_at ? <button className="btn btn-primary btn-sm" disabled={busy} onClick={doCheckOut}>Check Out</button> : null}
          </div>
        </div>
      </Card>

      <Card style={{ marginTop: "1rem" }} title={`${MONTH_NAMES[cursor.month - 1]} ${cursor.year}`} right={
        <div style={{ display: "flex", gap: "0.4rem" }}>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(-1)}>← Prev</button>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(1)}>Next →</button>
        </div>
      }>
        <table>
          <thead><tr><th>Date</th><th>Status</th><th>Check In</th><th>Check Out</th><th>Worked</th><th></th></tr></thead>
          <tbody>
            {calendar.days.map((d) => (
              <React.Fragment key={d.date}>
                <tr>
                  <td>{fmtDate(d.date)}</td>
                  <td><Stamp status={d.status === "present" ? "approved" : d.status === "absent" ? "rejected" : "pending"} label={ATTENDANCE_STATUS_LABEL[d.status] || d.status} /></td>
                  <td className="mono">{d.checkInAt ? fmtDateTime(d.checkInAt).split(" ").slice(-1)[0] : "—"}</td>
                  <td className="mono">{d.checkOutAt ? fmtDateTime(d.checkOutAt).split(" ").slice(-1)[0] : "—"}</td>
                  <td className="mono">{d.workedMinutes ? `${Math.floor(d.workedMinutes / 60)}h ${d.workedMinutes % 60}m` : "—"}</td>
                  <td>
                    {!d.isHoliday && !d.isWeeklyOff ? (
                      showCorrectionFor === d.date ? null : (
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowCorrectionFor(d.date)}>Request Correction</button>
                      )
                    ) : null}
                  </td>
                </tr>
                {showCorrectionFor === d.date ? (
                  <tr>
                    <td colSpan={6}>
                      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", padding: "0.5rem 0" }}>
                        <Field label="Correct Status To">
                          <select className="input-sm" value={correctionStatus} onChange={(e) => setCorrectionStatus(e.target.value)}>
                            <option value="">(leave as-is)</option>
                            <option value="present">Present</option>
                            <option value="wfh">Work From Home</option>
                            <option value="on_duty">On Duty</option>
                            <option value="half_day">Half Day</option>
                          </select>
                        </Field>
                        <Field label="Reason">
                          <input type="text" className="input-sm" value={correctionReason} onChange={(e) => setCorrectionReason(e.target.value)} placeholder="e.g. forgot to check out" />
                        </Field>
                        <button className="btn btn-primary btn-sm" onClick={() => submitCorrection(d.date)}>Submit</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShowCorrectionFor(null)}>Cancel</button>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </Card>

      <Card style={{ marginTop: "1rem" }} title="My Correction Requests">
        <table>
          <thead><tr><th>Date</th><th>Reason</th><th>Status</th></tr></thead>
          <tbody>
            {corrections.length === 0 ? <EmptyRow colSpan={3}>No correction requests yet.</EmptyRow> : corrections.map((c) => (
              <tr key={c.id}><td>{fmtDate(c.date)}</td><td>{c.reason}</td><td><Stamp status={c.status} /></td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// ATTENDANCE ADMIN (shifts, team day/range view, manual marking,
// correction approvals, weekly-off config)
// ============================================================
export function AttendanceAdminPage() {
  const { showToast, showError } = useToast();
  const [tab, setTab] = useState("today");
  const [dayRecords, setDayRecords] = useState(null);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [shifts, setShifts] = useState(null);
  const [corrections, setCorrections] = useState(null);
  const [weeklyOff, setWeeklyOff] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [shiftForm, setShiftForm] = useState({ code: "", name: "", startTime: "09:00", endTime: "18:00", gracePeriodMinutes: "10", breakMinutes: "60" });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [d, s, c, w] = await Promise.all([
          api.getAttendanceForDay(date),
          api.getShifts(true),
          api.getAllAttendanceCorrections(),
          api.getWeeklyOffDays(),
        ]);
        if (cancelled) return;
        setDayRecords(d); setShifts(s); setCorrections(c); setWeeklyOff(w.days);
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [date, reloadKey]);

  async function createShiftSubmit(e) {
    e.preventDefault();
    try {
      await api.createShift({
        ...shiftForm, gracePeriodMinutes: Number(shiftForm.gracePeriodMinutes), breakMinutes: Number(shiftForm.breakMinutes),
      });
      showToast("Shift created");
      setShiftForm({ code: "", name: "", startTime: "09:00", endTime: "18:00", gracePeriodMinutes: "10", breakMinutes: "60" });
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not create shift", true); }
  }

  async function decideCorr(id, decision) {
    try { await api.decideAttendanceCorrection(id, decision); showToast(`Correction ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not update correction", true); }
  }

  async function toggleWeeklyOff(dow) {
    const next = weeklyOff.includes(dow) ? weeklyOff.filter((d) => d !== dow) : [...weeklyOff, dow].sort();
    try { await api.setWeeklyOffDays(next); setWeeklyOff(next); showToast("Weekly off updated"); }
    catch (err) { showToast(err.message || "Could not update weekly off", true); }
  }

  if (!dayRecords || !shifts || !corrections || !weeklyOff) return <PageLoading />;

  const pendingCorrections = corrections.filter((c) => c.status === "pending");

  return (
    <>
      <PageHead eyebrow="Attendance Admin" title="Attendance Management" sub="Shifts, daily attendance, corrections and weekly-off configuration." />
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button className={`btn btn-sm ${tab === "today" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("today")}>Daily View</button>
        <button className={`btn btn-sm ${tab === "shifts" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("shifts")}>Shifts</button>
        <button className={`btn btn-sm ${tab === "corrections" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("corrections")}>Corrections ({pendingCorrections.length})</button>
        <button className={`btn btn-sm ${tab === "settings" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("settings")}>Weekly Off</button>
      </div>

      {tab === "today" ? (
        <Card title="Daily Attendance" right={<input type="date" className="input-sm" value={date} onChange={(e) => setDate(e.target.value)} />}>
          <table>
            <thead><tr><th>Employee</th><th>Status</th><th>Check In</th><th>Check Out</th><th>Worked</th></tr></thead>
            <tbody>
              {dayRecords.length === 0 ? <EmptyRow colSpan={5}>No attendance records for this date.</EmptyRow> : dayRecords.map((r) => (
                <tr key={r.id}>
                  <td>{r.user_name}</td>
                  <td><Stamp status={r.status === "present" ? "approved" : r.status === "absent" ? "rejected" : "pending"} label={ATTENDANCE_STATUS_LABEL[r.status] || r.status} /></td>
                  <td className="mono">{r.check_in_at ? fmtDateTime(r.check_in_at) : "—"}</td>
                  <td className="mono">{r.check_out_at ? fmtDateTime(r.check_out_at) : "—"}</td>
                  <td className="mono">{r.worked_minutes ? `${Math.floor(r.worked_minutes / 60)}h ${r.worked_minutes % 60}m` : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "shifts" ? (
        <Card title="Shifts">
          <form onSubmit={createShiftSubmit} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "1rem" }}>
            <Field label="Code"><input className="input-sm" value={shiftForm.code} onChange={(e) => setShiftForm({ ...shiftForm, code: e.target.value })} required /></Field>
            <Field label="Name"><input className="input-sm" value={shiftForm.name} onChange={(e) => setShiftForm({ ...shiftForm, name: e.target.value })} required /></Field>
            <Field label="Start"><input type="time" className="input-sm" value={shiftForm.startTime} onChange={(e) => setShiftForm({ ...shiftForm, startTime: e.target.value })} /></Field>
            <Field label="End"><input type="time" className="input-sm" value={shiftForm.endTime} onChange={(e) => setShiftForm({ ...shiftForm, endTime: e.target.value })} /></Field>
            <Field label="Grace (min)"><input type="number" className="input-sm" value={shiftForm.gracePeriodMinutes} onChange={(e) => setShiftForm({ ...shiftForm, gracePeriodMinutes: e.target.value })} /></Field>
            <Field label="Break (min)"><input type="number" className="input-sm" value={shiftForm.breakMinutes} onChange={(e) => setShiftForm({ ...shiftForm, breakMinutes: e.target.value })} /></Field>
            <button className="btn btn-primary btn-sm" type="submit">Add Shift</button>
          </form>
          <table>
            <thead><tr><th>Code</th><th>Name</th><th>Hours</th><th>Grace</th><th>Active</th></tr></thead>
            <tbody>
              {shifts.length === 0 ? <EmptyRow colSpan={5}>No shifts configured yet.</EmptyRow> : shifts.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{s.code}</td><td>{s.name}</td>
                  <td className="mono">{s.start_time}–{s.end_time}</td>
                  <td className="mono">{s.grace_period_minutes}m</td>
                  <td>{s.active ? "Yes" : "No"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "corrections" ? (
        <Card title="Correction Requests">
          <table>
            <thead><tr><th>Employee</th><th>Date</th><th>Reason</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {corrections.length === 0 ? <EmptyRow colSpan={5}>No correction requests.</EmptyRow> : corrections.map((c) => (
                <tr key={c.id}>
                  <td>{c.user_name}</td><td>{fmtDate(c.date)}</td><td>{c.reason}</td><td><Stamp status={c.status} /></td>
                  <td style={{ display: "flex", gap: "0.3rem" }}>
                    {c.status === "pending" ? (<>
                      <button className="btn btn-ghost btn-sm" onClick={() => decideCorr(c.id, "approved")}>Approve</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => decideCorr(c.id, "rejected")}>Reject</button>
                    </>) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "settings" ? (
        <Card title="Weekly Off Days">
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, dow) => (
              <button key={dow} className={`btn btn-sm ${weeklyOff.includes(dow) ? "btn-primary" : "btn-ghost"}`} onClick={() => toggleWeeklyOff(dow)}>{label}</button>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// MY TAX STATEMENT (employee — annual reconciliation + Form 16 data)
// ============================================================
export function MyTaxStatementPage() {
  const { user } = useAuth();
  const { showError } = useToast();
  const [statement, setStatement] = useState(null);
  const [form16, setForm16] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [s, f] = await Promise.all([api.getAnnualTaxStatement(user.id), api.getForm16(user.id)]);
        if (!cancelled) { setStatement(s); setForm16(f); }
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [user.id]);

  if (!statement || !form16) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Tax" title="My Annual Tax Statement" sub={`${statement.financialYearName} — ${statement.regime.name}`} />

      <div className="stat-grid">
        <StatCard label="Total Annual Gross" value={fmtMoney(statement.totalAnnualGross)} />
        <StatCard label="Taxable Income" value={fmtMoney(statement.taxableIncome)} />
        <StatCard label="Tax Computed" value={fmtMoney(statement.annualTaxComputed)} />
        <StatCard label="TDS Deducted" value={fmtMoney(statement.totalTdsDeducted)} />
      </div>

      <Card style={{ marginTop: "1rem" }} title={statement.balanceType === "refund_due" ? "Refund Due" : statement.balanceType === "additional_tax_due" ? "Additional Tax Due" : "Settled"}>
        <div style={{ fontSize: "1.4rem", fontWeight: 700 }}>{fmtMoney(Math.abs(statement.balance))}</div>
        <div style={{ opacity: 0.7, fontSize: "0.85rem" }}>
          {statement.balanceType === "refund_due" ? "More TDS was deducted than your computed liability." :
            statement.balanceType === "additional_tax_due" ? "Your computed liability exceeds TDS deducted so far." : "TDS deducted matches your computed liability."}
        </div>
      </Card>

      {statement.previousEmployer ? (
        <Card style={{ marginTop: "1rem" }} title="Previous Employer Income">
          <table>
            <tbody>
              <tr><td>Employer</td><td className="mono">{statement.previousEmployer.name}</td></tr>
              <tr><td>Gross Income</td><td className="mono">{fmtMoney(statement.previousEmployer.grossIncome)}</td></tr>
              <tr><td>TDS Deducted</td><td className="mono">{fmtMoney(statement.previousEmployer.tdsDeducted)}</td></tr>
            </tbody>
          </table>
        </Card>
      ) : null}

      <Card style={{ marginTop: "1rem" }} title="Monthly Breakdown">
        <table>
          <thead><tr><th>Month</th><th>Gross</th><th>PF</th><th>PT</th><th>TDS</th><th>Net</th></tr></thead>
          <tbody>
            {statement.monthlyBreakdown.length === 0 ? <EmptyRow colSpan={6}>No payroll processed yet this year.</EmptyRow> : statement.monthlyBreakdown.map((m) => (
              <tr key={m.payrollMonth}>
                <td>{m.payrollMonth}</td><td className="mono">{fmtMoneyDec(m.grossEarning)}</td>
                <td className="mono">{fmtMoneyDec(m.pfEmployeeDeduction)}</td><td className="mono">{fmtMoneyDec(m.professionalTaxDeduction)}</td>
                <td className="mono">{fmtMoneyDec(m.tdsDeduction)}</td><td className="mono">{fmtMoneyDec(m.netSalary)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card style={{ marginTop: "1rem" }} title="Form 16 — Quarterly TDS Summary">
        <table>
          <thead><tr><th>Quarter</th><th>TDS Deducted</th></tr></thead>
          <tbody>
            {Object.entries(form16.partA.quarterlyTdsSummary).map(([q, amt]) => (
              <tr key={q}><td>{q}</td><td className="mono">{fmtMoney(amt)}</td></tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// COMPLIANCE ADMIN (Block 5 — employer info, Form 24Q, PF/ESI/PT
// reports, statutory wage register)
// ============================================================
export function ComplianceAdminPage() {
  const { showToast, showError } = useToast();
  const [tab, setTab] = useState("employer");
  const [fy, setFy] = useState(null);
  const [employerInfo, setEmployerInfo] = useState(null);
  const [quarter, setQuarter] = useState("Q1");
  const [payrollMonth, setPayrollMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const [form24q, setForm24q] = useState(null);
  const [pfReport, setPfReport] = useState(null);
  const [esiReport, setEsiReport] = useState(null);
  const [ptReport, setPtReport] = useState(null);
  const [register, setRegister] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [info, fys] = await Promise.all([api.getEmployerStatutoryInfo(), api.getFinancialYears()]);
        setEmployerInfo(info);
        setFy(fys.financialYears.find((f) => f.is_active) || fys.financialYears[0]);
      } catch (err) { showError(err); }
    })();
  }, []);

  async function saveEmployerInfo(e) {
    e.preventDefault();
    try { await api.updateEmployerStatutoryInfo(employerInfo); showToast("Employer info saved"); }
    catch (err) { showToast(err.message || "Could not save", true); }
  }

  async function runReport(kind) {
    if (!fy) return;
    setBusy(true);
    try {
      if (kind === "24q") setForm24q(await api.getForm24Q(fy.id, quarter));
      if (kind === "pf") setPfReport(await api.getPfComplianceReport(fy.id, payrollMonth));
      if (kind === "esi") setEsiReport(await api.getEsiComplianceReport(fy.id, payrollMonth));
      if (kind === "pt") setPtReport(await api.getPtComplianceReport(fy.id, payrollMonth));
      if (kind === "register") setRegister(await api.getStatutoryWageRegister(fy.id, payrollMonth));
    } catch (err) { showToast(err.message || "Could not run report", true); }
    finally { setBusy(false); }
  }

  if (!employerInfo || !fy) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Compliance" title="Tax & Statutory Compliance" sub="Employer details, Form 24Q, and PF/ESI/PT compliance reports." />
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap" }}>
        {["employer", "24q", "pf", "esi", "pt", "register"].map((t) => (
          <button key={t} className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(t)}>
            {{ employer: "Employer Info", "24q": "Form 24Q", pf: "PF Report", esi: "ESI Report", pt: "PT Report", register: "Wage Register" }[t]}
          </button>
        ))}
      </div>

      {tab === "employer" ? (
        <Card title="Employer Statutory Info">
          <form onSubmit={saveEmployerInfo} style={{ display: "flex", flexDirection: "column", gap: "0.5rem", maxWidth: 420 }}>
            <Field label="Company Name"><input className="input-sm" value={employerInfo.company_name} onChange={(e) => setEmployerInfo({ ...employerInfo, company_name: e.target.value })} /></Field>
            <Field label="Company PAN"><input className="input-sm" value={employerInfo.company_pan} onChange={(e) => setEmployerInfo({ ...employerInfo, company_pan: e.target.value })} /></Field>
            <Field label="Company TAN"><input className="input-sm" value={employerInfo.company_tan} onChange={(e) => setEmployerInfo({ ...employerInfo, company_tan: e.target.value })} /></Field>
            <Field label="PF Establishment Code"><input className="input-sm" value={employerInfo.pf_establishment_code} onChange={(e) => setEmployerInfo({ ...employerInfo, pf_establishment_code: e.target.value })} /></Field>
            <Field label="ESI Establishment Code"><input className="input-sm" value={employerInfo.esi_establishment_code} onChange={(e) => setEmployerInfo({ ...employerInfo, esi_establishment_code: e.target.value })} /></Field>
            <Field label="Address"><input className="input-sm" value={employerInfo.company_address} onChange={(e) => setEmployerInfo({ ...employerInfo, company_address: e.target.value })} /></Field>
            <button className="btn btn-primary btn-sm" type="submit">Save</button>
          </form>
        </Card>
      ) : null}

      {tab === "24q" ? (
        <Card title="Form 24Q — Quarterly TDS Return Data" right={
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <select className="input-sm" value={quarter} onChange={(e) => setQuarter(e.target.value)}>
              {["Q1", "Q2", "Q3", "Q4"].map((q) => <option key={q} value={q}>{q}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => runReport("24q")}>Generate</button>
          </div>
        }>
          {form24q ? (
            <>
              <div className="stat-grid">
                <StatCard label="Deductees" value={form24q.deducteeCount} />
                <StatCard label="Total Gross Paid" value={fmtMoney(form24q.totalGrossPaid)} />
                <StatCard label="Total TDS Deducted" value={fmtMoney(form24q.totalTdsDeducted)} />
              </div>
              <table style={{ marginTop: "0.8rem" }}>
                <thead><tr><th>Employee</th><th>PAN</th><th>Gross Paid</th><th>TDS Deducted</th></tr></thead>
                <tbody>
                  {form24q.deductees.map((d) => (
                    <tr key={d.userId}><td>{d.name}</td><td className="mono">{d.pan}</td><td className="mono">{fmtMoneyDec(d.totalGrossPaid)}</td><td className="mono">{fmtMoneyDec(d.totalTdsDeducted)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : <EmptyRow colSpan={1}>Choose a quarter and generate.</EmptyRow>}
        </Card>
      ) : null}

      {["pf", "esi", "pt", "register"].includes(tab) ? (
        <Card title={{ pf: "PF Compliance Report", esi: "ESI Compliance Report", pt: "PT Compliance Report", register: "Statutory Wage Register" }[tab]} right={
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <input type="month" className="input-sm" value={payrollMonth} onChange={(e) => setPayrollMonth(e.target.value)} />
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => runReport(tab)}>Generate</button>
          </div>
        }>
          {tab === "pf" && pfReport ? (
            <>
              <div className="stat-grid">
                <StatCard label="Employees" value={pfReport.employeeCount} />
                <StatCard label="Employee PF" value={fmtMoney(pfReport.totals.employeePf)} />
                <StatCard label="Employer PF" value={fmtMoney(pfReport.totals.employerPfTotal)} />
                <StatCard label="Total Remittance" value={fmtMoney(pfReport.totals.totalRemittance)} />
              </div>
              <table style={{ marginTop: "0.8rem" }}>
                <thead><tr><th>Employee</th><th>UAN</th><th>PF Wage</th><th>Employee PF</th><th>Employer PF</th></tr></thead>
                <tbody>
                  {pfReport.employees.map((e) => (
                    <tr key={e.employeeCode}><td>{e.name}</td><td className="mono">{e.uan}</td><td className="mono">{fmtMoneyDec(e.pfWage)}</td><td className="mono">{fmtMoneyDec(e.employeePf)}</td><td className="mono">{fmtMoneyDec(e.employerPfTotal)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {tab === "esi" && esiReport ? (
            <>
              <div className="stat-grid">
                <StatCard label="Eligible Employees" value={esiReport.eligibleCount} />
                <StatCard label="Employee ESI" value={fmtMoney(esiReport.totals.employeeEsi)} />
                <StatCard label="Employer ESI" value={fmtMoney(esiReport.totals.employerEsi)} />
              </div>
              <div style={{ fontSize: "0.8rem", opacity: 0.7, margin: "0.5rem 0" }}>Advisory report — ESI is not currently withheld in payroll runs.</div>
              <table>
                <thead><tr><th>Employee</th><th>Gross Wage</th><th>Eligible</th><th>Employee ESI</th><th>Employer ESI</th></tr></thead>
                <tbody>
                  {esiReport.employees.map((e) => (
                    <tr key={e.employeeCode}><td>{e.name}</td><td className="mono">{fmtMoneyDec(e.grossWage)}</td><td>{e.eligible ? "Yes" : "No"}</td><td className="mono">{fmtMoneyDec(e.employeeEsi)}</td><td className="mono">{fmtMoneyDec(e.employerEsi)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {tab === "pt" && ptReport ? (
            <>
              <div className="stat-grid"><StatCard label="Total Professional Tax" value={fmtMoney(ptReport.totalProfessionalTax)} /></div>
              <table style={{ marginTop: "0.8rem" }}>
                <thead><tr><th>Employee</th><th>Location</th><th>PT Deducted</th></tr></thead>
                <tbody>
                  {ptReport.employees.map((e) => (
                    <tr key={e.employeeCode}><td>{e.name}</td><td>{e.location}</td><td className="mono">{fmtMoneyDec(e.professionalTaxDeducted)}</td></tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
          {tab === "register" && register ? (
            <table>
              <thead><tr><th>Employee</th><th>Designation</th><th>Paid Days</th><th>Basic</th><th>Gross</th><th>Net</th></tr></thead>
              <tbody>
                {register.employees.map((e) => (
                  <tr key={e.employeeCode}><td>{e.name}</td><td>{e.designation}</td><td className="mono">{e.paidDays}/{e.workingDays}</td><td className="mono">{fmtMoneyDec(e.basicEarning)}</td><td className="mono">{fmtMoneyDec(e.grossEarning)}</td><td className="mono">{fmtMoneyDec(e.netSalary)}</td></tr>
                ))}
              </tbody>
            </table>
          ) : null}
          {!pfReport && !esiReport && !ptReport && !register ? <EmptyRow colSpan={1}>Choose a month and generate.</EmptyRow> : null}
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// FULL & FINAL SETTLEMENT ADMIN (Block 6)
// ============================================================
export function FnfAdminPage() {
  const { showToast, showError } = useToast();
  const [tab, setTab] = useState("separations");
  const [separations, setSeparations] = useState(null);
  const [settlements, setSettlements] = useState(null);
  const [employees, setEmployees] = useState(null);
  const [form, setForm] = useState({ userId: "", resignationDate: "", lastWorkingDate: "", noticePeriodRequiredDays: "30", reason: "" });
  const [statementFor, setStatementFor] = useState(null);
  const [statement, setStatement] = useState(null);
  const [overrides, setOverrides] = useState({ bonusAmount: "0", reimbursementsAmount: "0", assetRecoveryAmount: "0", otherDeductionsAmount: "0", otherDeductionsNotes: "" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [sep, settle, emp] = await Promise.all([api.getSeparations(), api.getFnfSettlements(), api.getUsers(500)]);
        if (cancelled) return;
        setSeparations(sep); setSettlements(settle); setEmployees(emp.items || emp || []);
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function submitSeparation(e) {
    e.preventDefault();
    try {
      await api.initiateSeparation({ ...form, userId: Number(form.userId), noticePeriodRequiredDays: Number(form.noticePeriodRequiredDays) });
      showToast("Resignation recorded");
      setForm({ userId: "", resignationDate: "", lastWorkingDate: "", noticePeriodRequiredDays: "30", reason: "" });
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not record resignation", true); }
  }

  async function decideSep(id, decision) {
    try { await api.decideSeparation(id, decision); showToast(`Separation ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not update separation", true); }
  }

  async function generate(separationId) {
    try {
      await api.generateFnfSettlement(separationId, {
        bonusAmount: Number(overrides.bonusAmount) || 0, reimbursementsAmount: Number(overrides.reimbursementsAmount) || 0,
        assetRecoveryAmount: Number(overrides.assetRecoveryAmount) || 0, otherDeductionsAmount: Number(overrides.otherDeductionsAmount) || 0,
        otherDeductionsNotes: overrides.otherDeductionsNotes,
      });
      showToast("Settlement generated");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not generate settlement", true); }
  }

  async function viewStatement(id) {
    try { setStatementFor(id); setStatement(await api.getFnfSettlementStatement(id)); }
    catch (err) { showToast(err.message || "Could not load statement", true); }
  }

  async function submitForApproval(id) {
    try { await api.submitFnfSettlement(id); showToast("Submitted for approval"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not submit", true); }
  }
  async function decideSettle(id, decision) {
    try { await api.decideFnfSettlement(id, decision); showToast(`Settlement ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not decide", true); }
  }
  async function markPaid(id) {
    try { await api.markFnfSettlementPaid(id); showToast("Settlement marked paid — employee deactivated"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not mark paid", true); }
  }

  if (!separations || !settlements) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Offboarding" title="Full & Final Settlement" sub="Resignations, notice period, and final settlement approval." />
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button className={`btn btn-sm ${tab === "separations" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("separations")}>Separations ({separations.length})</button>
        <button className={`btn btn-sm ${tab === "settlements" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("settlements")}>Settlements ({settlements.length})</button>
      </div>

      {tab === "separations" ? (
        <>
          <Card title="Record a Resignation">
            <form onSubmit={submitSeparation} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
              <Field label="Employee">
                <select className="input-sm" value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })} required>
                  <option value="">Select…</option>
                  {(employees || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </Field>
              <Field label="Resignation Date"><input type="date" className="input-sm" value={form.resignationDate} onChange={(e) => setForm({ ...form, resignationDate: e.target.value })} required /></Field>
              <Field label="Last Working Date"><input type="date" className="input-sm" value={form.lastWorkingDate} onChange={(e) => setForm({ ...form, lastWorkingDate: e.target.value })} required /></Field>
              <Field label="Notice Period (days)"><input type="number" className="input-sm" value={form.noticePeriodRequiredDays} onChange={(e) => setForm({ ...form, noticePeriodRequiredDays: e.target.value })} /></Field>
              <Field label="Reason"><input className="input-sm" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
              <button className="btn btn-primary btn-sm" type="submit">Record</button>
            </form>
          </Card>
          <Card style={{ marginTop: "1rem" }} title="Separations">
            <table>
              <thead><tr><th>Employee</th><th>Resignation</th><th>Last Working Day</th><th>Notice (days)</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {separations.length === 0 ? <EmptyRow colSpan={6}>No separations recorded.</EmptyRow> : separations.map((s) => (
                  <tr key={s.id}>
                    <td>{s.user_name}</td><td>{fmtDate(s.resignation_date)}</td><td>{fmtDate(s.last_working_date)}</td>
                    <td className="mono">{s.notice_period_required_days}</td><td><Stamp status={s.status} /></td>
                    <td style={{ display: "flex", gap: "0.3rem" }}>
                      {s.status === "pending" ? (<>
                        <button className="btn btn-ghost btn-sm" onClick={() => decideSep(s.id, "approved")}>Approve</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => decideSep(s.id, "withdrawn")}>Withdraw</button>
                      </>) : null}
                      {s.status === "approved" ? <button className="btn btn-primary btn-sm" onClick={() => generate(s.id)}>Generate Settlement</button> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      ) : null}

      {tab === "settlements" ? (
        <Card title="Settlements">
          <table>
            <thead><tr><th>Employee</th><th>Last Working Day</th><th>Final Payable</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {settlements.length === 0 ? <EmptyRow colSpan={5}>No settlements yet.</EmptyRow> : settlements.map((s) => (
                <React.Fragment key={s.id}>
                  <tr>
                    <td>{s.user_name}</td><td>{fmtDate(s.last_working_date)}</td>
                    <td className="mono">{fmtMoney(s.final_payable)}</td><td><Stamp status={s.status} /></td>
                    <td style={{ display: "flex", gap: "0.3rem" }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => viewStatement(s.id)}>{statementFor === s.id ? "Hide" : "View"} Statement</button>
                      {s.status === "draft" ? <button className="btn btn-primary btn-sm" onClick={() => submitForApproval(s.id)}>Submit</button> : null}
                      {s.status === "pending_approval" ? (<>
                        <button className="btn btn-ghost btn-sm" onClick={() => decideSettle(s.id, "approved")}>Approve</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => decideSettle(s.id, "rejected")}>Reject</button>
                      </>) : null}
                      {s.status === "approved" ? <button className="btn btn-primary btn-sm" onClick={() => markPaid(s.id)}>Mark Paid</button> : null}
                    </td>
                  </tr>
                  {statementFor === s.id && statement ? (
                    <tr>
                      <td colSpan={5}>
                        <div style={{ padding: "0.8rem", background: "var(--surface-subtle, #f7f7f5)", borderRadius: 8 }}>
                          <div style={{ display: "flex", gap: "2rem", flexWrap: "wrap" }}>
                            <div>
                              <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>Earnings</div>
                              {statement.earnings.map((l) => <div key={l.label} style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}><span>{l.label}</span><span className="mono">{fmtMoney(l.amount)}</span></div>)}
                            </div>
                            <div>
                              <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>Deductions</div>
                              {statement.deductions.map((l) => <div key={l.label} style={{ display: "flex", justifyContent: "space-between", gap: "1rem" }}><span>{l.label}</span><span className="mono">{fmtMoney(l.amount)}</span></div>)}
                            </div>
                          </div>
                          <div style={{ marginTop: "0.6rem", fontWeight: 700 }}>Final Payable: {fmtMoney(statement.finalPayable)}</div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// MY COMP-OFF (employee self-service)
// ============================================================
export function MyCompOffPage() {
  const { user } = useAuth();
  const { showToast, showError } = useToast();
  const [compOffs, setCompOffs] = useState(null);
  const [form, setForm] = useState({ workedDate: "", earnedDays: "1", reason: "" });
  const [redeemDate, setRedeemDate] = useState({});
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try { const c = await api.getMyCompOffs(); if (!cancelled) setCompOffs(c); }
      catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [reloadKey]);

  async function submitRequest(e) {
    e.preventDefault();
    try {
      await api.requestCompOff({ workedDate: form.workedDate, earnedDays: Number(form.earnedDays), reason: form.reason });
      showToast("Comp-off request submitted");
      setForm({ workedDate: "", earnedDays: "1", reason: "" });
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not submit request", true); }
  }

  async function redeem(id) {
    const date = redeemDate[id];
    if (!date) { showToast("Pick a date to redeem against", true); return; }
    try { await api.redeemCompOff(id, date); showToast("Comp-off redeemed as leave"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not redeem comp-off", true); }
  }

  if (!compOffs) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Leave" title="My Comp-Off" sub="Request compensatory time off for working a holiday or weekend, then redeem it as leave." />
      <Card title="Request Comp-Off">
        <form onSubmit={submitRequest} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end" }}>
          <Field label="Date Worked"><input type="date" className="input-sm" value={form.workedDate} onChange={(e) => setForm({ ...form, workedDate: e.target.value })} required /></Field>
          <Field label="Days Earned">
            <select className="input-sm" value={form.earnedDays} onChange={(e) => setForm({ ...form, earnedDays: e.target.value })}>
              <option value="1">1 (full day)</option><option value="0.5">0.5 (half day)</option>
            </select>
          </Field>
          <Field label="Reason"><input className="input-sm" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <button className="btn btn-primary btn-sm" type="submit">Submit</button>
        </form>
      </Card>
      <Card style={{ marginTop: "1rem" }} title="My Comp-Off Credits">
        <table>
          <thead><tr><th>Worked Date</th><th>Days</th><th>Status</th><th>Expires</th><th></th></tr></thead>
          <tbody>
            {compOffs.length === 0 ? <EmptyRow colSpan={5}>No comp-off requests yet.</EmptyRow> : compOffs.map((c) => (
              <tr key={c.id}>
                <td>{fmtDate(c.worked_date)}</td><td className="mono">{c.earned_days}</td><td><Stamp status={c.status} /></td>
                <td>{c.expires_on ? fmtDate(c.expires_on) : "—"}</td>
                <td>
                  {c.status === "approved" ? (
                    <div style={{ display: "flex", gap: "0.3rem" }}>
                      <input type="date" className="input-sm" value={redeemDate[c.id] || ""} onChange={(e) => setRedeemDate({ ...redeemDate, [c.id]: e.target.value })} />
                      <button className="btn btn-ghost btn-sm" onClick={() => redeem(c.id)}>Redeem</button>
                    </div>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}

// ============================================================
// TEAM LEAVE CALENDAR
// ============================================================
export function TeamLeaveCalendarPage() {
  const { user } = useAuth();
  const { showError } = useToast();
  const [scope, setScope] = useState(user.role === "employee" ? "mine" : "team");
  const [cursor, setCursor] = useState(() => { const d = new Date(); return { year: d.getFullYear(), month: d.getMonth() + 1 }; });
  const [entries, setEntries] = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const from = `${cursor.year}-${String(cursor.month).padStart(2, "0")}-01`;
        const lastDay = new Date(cursor.year, cursor.month, 0).getDate();
        const to = `${cursor.year}-${String(cursor.month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
        const data = await api.getLeaveCalendar(from, to, scope);
        if (!cancelled) setEntries(data);
      } catch (err) { showError(err); }
    })();
    return () => { cancelled = true; };
  }, [cursor.year, cursor.month, scope]);

  function shiftMonth(delta) {
    setCursor((c) => { let month = c.month + delta, year = c.year; if (month < 1) { month = 12; year--; } if (month > 12) { month = 1; year++; } return { year, month }; });
  }

  return (
    <>
      <PageHead eyebrow="Leave" title="Leave Calendar" sub="Who's on approved or pending leave." />
      <Card title={`${MONTH_NAMES[cursor.month - 1]} ${cursor.year}`} right={
        <div style={{ display: "flex", gap: "0.4rem" }}>
          {user.role !== "employee" ? (
            <select className="input-sm" value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="mine">Just Me</option><option value="team">My Team</option>
            </select>
          ) : null}
          <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(-1)}>← Prev</button>
          <button className="btn btn-ghost btn-sm" onClick={() => shiftMonth(1)}>Next →</button>
        </div>
      }>
        {!entries ? <PageLoading /> : (
          <table>
            <thead><tr><th>Employee</th><th>Leave Type</th><th>From</th><th>To</th><th>Days</th><th>Status</th></tr></thead>
            <tbody>
              {entries.length === 0 ? <EmptyRow colSpan={6}>No leave scheduled this month.</EmptyRow> : entries.map((e) => (
                <tr key={e.id}>
                  <td>{e.user_name}</td><td>{e.leave_type_name}</td><td>{fmtDate(e.from_date)}</td><td>{fmtDate(e.to_date)}</td>
                  <td className="mono">{e.days}</td><td><Stamp status={e.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

// ============================================================
// LEAVE ADMIN (Block 3 — policies, comp-off approvals, accrual/carry-forward)
// ============================================================
export function LeaveAdminPage() {
  const { showToast, showError } = useToast();
  const [tab, setTab] = useState("policies");
  const [leaveTypes, setLeaveTypes] = useState(null);
  const [selectedType, setSelectedType] = useState("");
  const [policies, setPolicies] = useState(null);
  const [compOffs, setCompOffs] = useState(null);
  const [policyForm, setPolicyForm] = useState({ departmentName: "", userId: "", annualDays: "12", accrualMethod: "annual", monthlyAccrualDays: "1", carryForwardEnabled: false, maxCarryForwardDays: "5", carryForwardExpiryMonths: "3", minServiceDaysBeforeEligible: "0", allowNegativeBalance: false, maxNegativeDays: "0", isSandwichLeave: false, unit: "day" });
  const [accrualForm, setAccrualForm] = useState(() => { const d = new Date(); return { year: String(d.getFullYear()), month: String(d.getMonth() + 1) }; });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const lt = await api.getLeaveTypes();
        setLeaveTypes(lt.leaveTypes || lt || []);
        const co = await api.getAllCompOffs();
        setCompOffs(co);
      } catch (err) { showError(err); }
    })();
  }, [reloadKey]);

  useEffect(() => {
    if (!selectedType) { setPolicies(null); return; }
    (async () => {
      try { setPolicies(await api.getLeavePolicies(selectedType)); }
      catch (err) { showError(err); }
    })();
  }, [selectedType, reloadKey]);

  async function createPolicy(e) {
    e.preventDefault();
    try {
      await api.createLeavePolicy({
        leaveTypeId: Number(selectedType), departmentName: policyForm.departmentName || undefined, userId: policyForm.userId ? Number(policyForm.userId) : undefined,
        annualDays: Number(policyForm.annualDays), accrualMethod: policyForm.accrualMethod, monthlyAccrualDays: Number(policyForm.monthlyAccrualDays),
        carryForwardEnabled: policyForm.carryForwardEnabled, maxCarryForwardDays: Number(policyForm.maxCarryForwardDays), carryForwardExpiryMonths: Number(policyForm.carryForwardExpiryMonths),
        minServiceDaysBeforeEligible: Number(policyForm.minServiceDaysBeforeEligible), allowNegativeBalance: policyForm.allowNegativeBalance, maxNegativeDays: Number(policyForm.maxNegativeDays),
        isSandwichLeave: policyForm.isSandwichLeave, unit: policyForm.unit,
      });
      showToast("Policy created");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not create policy", true); }
  }
  async function removePolicy(id) {
    try { await api.deleteLeavePolicy(id); showToast("Policy removed"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not remove policy", true); }
  }
  async function actCompOff(id, decision) {
    try { await api.decideCompOff(id, decision); showToast(`Comp-off ${decision}`); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not update comp-off", true); }
  }
  async function runAccrual() {
    try { const r = await api.runLeaveAccrual(Number(accrualForm.year), Number(accrualForm.month)); showToast(`Accrual applied to ${r.accrualsApplied} balance(s)`); }
    catch (err) { showToast(err.message || "Could not run accrual", true); }
  }
  async function runExpiry() {
    try { const r = await api.runCarryForwardExpiry(); showToast(`${r.expiredCount} carry-forward balance(s) expired`); }
    catch (err) { showToast(err.message || "Could not run expiry", true); }
  }

  if (!leaveTypes || !compOffs) return <PageLoading />;

  return (
    <>
      <PageHead eyebrow="Leave Admin" title="Advanced Leave Management" sub="Policies, comp-off approvals, and accrual/carry-forward maintenance." />
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem" }}>
        <button className={`btn btn-sm ${tab === "policies" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("policies")}>Policies</button>
        <button className={`btn btn-sm ${tab === "compoff" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("compoff")}>Comp-Off ({compOffs.filter((c) => c.status === "pending").length})</button>
        <button className={`btn btn-sm ${tab === "maintenance" ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab("maintenance")}>Accrual & Carry-Forward</button>
      </div>

      {tab === "policies" ? (
        <Card title="Leave Policies">
          <Field label="Leave Type">
            <select className="input-sm" value={selectedType} onChange={(e) => setSelectedType(e.target.value)}>
              <option value="">Select…</option>
              {leaveTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Field>
          {selectedType ? (
            <>
              <form onSubmit={createPolicy} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", margin: "0.8rem 0" }}>
                <Field label="Department (optional)"><input className="input-sm" value={policyForm.departmentName} onChange={(e) => setPolicyForm({ ...policyForm, departmentName: e.target.value })} /></Field>
                <Field label="Employee ID (optional)"><input className="input-sm" value={policyForm.userId} onChange={(e) => setPolicyForm({ ...policyForm, userId: e.target.value })} /></Field>
                <Field label="Annual Days"><input type="number" className="input-sm" value={policyForm.annualDays} onChange={(e) => setPolicyForm({ ...policyForm, annualDays: e.target.value })} /></Field>
                <Field label="Accrual">
                  <select className="input-sm" value={policyForm.accrualMethod} onChange={(e) => setPolicyForm({ ...policyForm, accrualMethod: e.target.value })}>
                    <option value="annual">Annual (lump sum)</option><option value="monthly">Monthly</option>
                  </select>
                </Field>
                {policyForm.accrualMethod === "monthly" ? (
                  <Field label="Monthly Days"><input type="number" className="input-sm" value={policyForm.monthlyAccrualDays} onChange={(e) => setPolicyForm({ ...policyForm, monthlyAccrualDays: e.target.value })} /></Field>
                ) : null}
                <Field label="Unit">
                  <select className="input-sm" value={policyForm.unit} onChange={(e) => setPolicyForm({ ...policyForm, unit: e.target.value })}>
                    <option value="day">Day</option><option value="hour">Hour</option>
                  </select>
                </Field>
                <Field label="Waiting Period (days)"><input type="number" className="input-sm" value={policyForm.minServiceDaysBeforeEligible} onChange={(e) => setPolicyForm({ ...policyForm, minServiceDaysBeforeEligible: e.target.value })} /></Field>
                <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
                  <input type="checkbox" checked={policyForm.carryForwardEnabled} onChange={(e) => setPolicyForm({ ...policyForm, carryForwardEnabled: e.target.checked })} /> Carry-forward
                </label>
                {policyForm.carryForwardEnabled ? (<>
                  <Field label="Max Carry-Forward"><input type="number" className="input-sm" value={policyForm.maxCarryForwardDays} onChange={(e) => setPolicyForm({ ...policyForm, maxCarryForwardDays: e.target.value })} /></Field>
                  <Field label="Expires After (months)"><input type="number" className="input-sm" value={policyForm.carryForwardExpiryMonths} onChange={(e) => setPolicyForm({ ...policyForm, carryForwardExpiryMonths: e.target.value })} /></Field>
                </>) : null}
                <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
                  <input type="checkbox" checked={policyForm.allowNegativeBalance} onChange={(e) => setPolicyForm({ ...policyForm, allowNegativeBalance: e.target.checked })} /> Allow negative
                </label>
                {policyForm.allowNegativeBalance ? (
                  <Field label="Max Negative"><input type="number" className="input-sm" value={policyForm.maxNegativeDays} onChange={(e) => setPolicyForm({ ...policyForm, maxNegativeDays: e.target.value })} /></Field>
                ) : null}
                <label style={{ display: "flex", gap: "0.3rem", alignItems: "center", fontSize: "0.85rem" }}>
                  <input type="checkbox" checked={policyForm.isSandwichLeave} onChange={(e) => setPolicyForm({ ...policyForm, isSandwichLeave: e.target.checked })} /> Sandwich rule
                </label>
                <button className="btn btn-primary btn-sm" type="submit">Add Policy</button>
              </form>
              <table>
                <thead><tr><th>Scope</th><th>Annual Days</th><th>Accrual</th><th>Carry-Forward</th><th>Negative</th><th></th></tr></thead>
                <tbody>
                  {!policies || policies.length === 0 ? <EmptyRow colSpan={6}>No overrides for this leave type — the type's own default applies to everyone.</EmptyRow> : policies.map((p) => (
                    <tr key={p.id}>
                      <td>{p.user_id ? `Employee #${p.user_id}` : p.department_name ? `Dept: ${p.department_name}` : "—"}</td>
                      <td className="mono">{p.annual_days} {p.unit}</td>
                      <td>{p.accrual_method === "monthly" ? `${p.monthly_accrual_days}/mo` : "Annual"}</td>
                      <td>{p.carry_forward_enabled ? `up to ${p.max_carry_forward_days}` : "No"}</td>
                      <td>{p.allow_negative_balance ? `up to -${p.max_negative_days}` : "No"}</td>
                      <td><button className="btn btn-ghost btn-sm" onClick={() => removePolicy(p.id)}>Remove</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}
        </Card>
      ) : null}

      {tab === "compoff" ? (
        <Card title="Comp-Off Requests">
          <table>
            <thead><tr><th>Employee</th><th>Worked Date</th><th>Days</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {compOffs.length === 0 ? <EmptyRow colSpan={5}>No comp-off requests.</EmptyRow> : compOffs.map((c) => (
                <tr key={c.id}>
                  <td>{c.user_name}</td><td>{fmtDate(c.worked_date)}</td><td className="mono">{c.earned_days}</td><td><Stamp status={c.status} /></td>
                  <td style={{ display: "flex", gap: "0.3rem" }}>
                    {c.status === "pending" ? (<>
                      <button className="btn btn-ghost btn-sm" onClick={() => actCompOff(c.id, "approved")}>Approve</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => actCompOff(c.id, "rejected")}>Reject</button>
                    </>) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}

      {tab === "maintenance" ? (
        <Card title="Accrual & Carry-Forward">
          <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>Run Monthly Accrual</div>
              <div style={{ display: "flex", gap: "0.5rem" }}>
                <input type="number" className="input-sm" style={{ width: 90 }} value={accrualForm.year} onChange={(e) => setAccrualForm({ ...accrualForm, year: e.target.value })} />
                <select className="input-sm" value={accrualForm.month} onChange={(e) => setAccrualForm({ ...accrualForm, month: e.target.value })}>
                  {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
                <button className="btn btn-primary btn-sm" onClick={runAccrual}>Run</button>
              </div>
            </div>
            <div>
              <div style={{ fontWeight: 600, marginBottom: "0.4rem" }}>Expire Stale Carry-Forward</div>
              <button className="btn btn-primary btn-sm" onClick={runExpiry}>Run Now</button>
            </div>
          </div>
        </Card>
      ) : null}
    </>
  );
}

// ============================================================
// EMPLOYEE LIFECYCLE ADMIN (Block 1)
// ============================================================
export function EmployeeLifecycleAdminPage() {
  const { showToast, showError } = useToast();
  const [employees, setEmployees] = useState(null);
  const [userId, setUserId] = useState("");
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState("timeline");
  const [transferForm, setTransferForm] = useState({ dept: "", title: "", managerId: "", location: "" });
  const [probationForm, setProbationForm] = useState({ startDate: "", durationDays: "90" });
  const [docForm, setDocForm] = useState({ docType: "", filePath: "", issueDate: "", expiryDate: "" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    (async () => { try { const u = await api.getUsers(500); setEmployees(u.items || u || []); } catch (err) { showError(err); } })();
  }, []);

  useEffect(() => {
    if (!userId) { setProfile(null); return; }
    (async () => { try { setProfile(await api.getLifecycleProfile(Number(userId))); } catch (err) { showError(err); } })();
  }, [userId, reloadKey]);

  async function doTransfer(kind) {
    try {
      if (kind === "dept") await api.transferDepartment(Number(userId), { newDept: transferForm.dept });
      if (kind === "title") await api.changeDesignation(Number(userId), { newTitle: transferForm.title });
      if (kind === "manager") await api.changeManager(Number(userId), { newManagerId: Number(transferForm.managerId) });
      if (kind === "location") await api.changeLocation(Number(userId), { newLocation: transferForm.location });
      showToast("Updated");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not update", true); }
  }

  async function doStartProbation(e) {
    e.preventDefault();
    try {
      await api.startProbation(Number(userId), { startDate: probationForm.startDate || undefined, durationDays: Number(probationForm.durationDays) });
      showToast("Probation started");
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not start probation", true); }
  }
  async function doConfirmProbation(id) {
    try { await api.confirmProbation(id); showToast("Probation confirmed"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not confirm", true); }
  }

  async function doUploadDoc(e) {
    e.preventDefault();
    try {
      await api.uploadEmployeeDocument(Number(userId), docForm);
      showToast("Document recorded");
      setDocForm({ docType: "", filePath: "", issueDate: "", expiryDate: "" });
      setReloadKey((k) => k + 1);
    } catch (err) { showToast(err.message || "Could not save document", true); }
  }

  async function doCompleteTask(id) {
    try { await api.completeChecklistTask(id); showToast("Task completed"); setReloadKey((k) => k + 1); }
    catch (err) { showToast(err.message || "Could not complete task", true); }
  }

  return (
    <>
      <PageHead eyebrow="Lifecycle" title="Employee Lifecycle" sub="Transfers, promotions, probation, documents and onboarding checklist." />
      <Card title="Select Employee">
        <select className="input-sm" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Select…</option>
          {(employees || []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </Card>

      {!userId ? null : !profile ? <PageLoading /> : (
        <>
          <div className="stat-grid" style={{ marginTop: "1rem" }}>
            <StatCard label="Lifecycle Status" value={profile.lifecycleStatus} />
            <StatCard label="Onboarding Tasks" value={`${profile.onboardingTasks.filter((t) => t.status === "completed").length}/${profile.onboardingTasks.length}`} />
            <StatCard label="Active Probation" value={profile.activeProbation ? "Yes" : "No"} />
            <StatCard label="Documents on File" value={profile.documents.length} />
          </div>

          <div style={{ display: "flex", gap: "0.5rem", margin: "1rem 0" }}>
            {["timeline", "transfer", "probation", "documents", "checklist"].map((t) => (
              <button key={t} className={`btn btn-sm ${tab === t ? "btn-primary" : "btn-ghost"}`} onClick={() => setTab(t)}>{t[0].toUpperCase() + t.slice(1)}</button>
            ))}
          </div>

          {tab === "timeline" ? (
            <Card title="History">
              <table>
                <thead><tr><th>Date</th><th>Event</th><th>From</th><th>To</th></tr></thead>
                <tbody>
                  {profile.events.length === 0 ? <EmptyRow colSpan={4}>No history yet.</EmptyRow> : profile.events.map((e) => (
                    <tr key={e.id}><td>{fmtDate(e.effective_date)}</td><td>{e.event_type.replace(/_/g, " ")}</td><td>{e.previous_value || "—"}</td><td>{e.new_value || "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          {tab === "transfer" ? (
            <Card title="Transfers & Promotion">
              <div style={{ display: "flex", gap: "1.5rem", flexWrap: "wrap" }}>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <Field label="Department"><input className="input-sm" value={transferForm.dept} onChange={(e) => setTransferForm({ ...transferForm, dept: e.target.value })} /></Field>
                  <button className="btn btn-ghost btn-sm" onClick={() => doTransfer("dept")}>Transfer</button>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <Field label="Designation"><input className="input-sm" value={transferForm.title} onChange={(e) => setTransferForm({ ...transferForm, title: e.target.value })} /></Field>
                  <button className="btn btn-ghost btn-sm" onClick={() => doTransfer("title")}>Change</button>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <Field label="Manager ID"><input className="input-sm" value={transferForm.managerId} onChange={(e) => setTransferForm({ ...transferForm, managerId: e.target.value })} /></Field>
                  <button className="btn btn-ghost btn-sm" onClick={() => doTransfer("manager")}>Change</button>
                </div>
                <div style={{ display: "flex", gap: "0.4rem", alignItems: "flex-end" }}>
                  <Field label="Location"><input className="input-sm" value={transferForm.location} onChange={(e) => setTransferForm({ ...transferForm, location: e.target.value })} /></Field>
                  <button className="btn btn-ghost btn-sm" onClick={() => doTransfer("location")}>Change</button>
                </div>
              </div>
            </Card>
          ) : null}

          {tab === "probation" ? (
            <Card title="Probation">
              {profile.activeProbation ? (
                <div style={{ marginBottom: "0.8rem" }}>
                  <div>Started {fmtDate(profile.activeProbation.start_date)}, expected end {fmtDate(profile.activeProbation.expected_end_date)}</div>
                  <button className="btn btn-primary btn-sm" style={{ marginTop: "0.4rem" }} onClick={() => doConfirmProbation(profile.activeProbation.id)}>Confirm Probation</button>
                </div>
              ) : (
                <form onSubmit={doStartProbation} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end" }}>
                  <Field label="Start Date"><input type="date" className="input-sm" value={probationForm.startDate} onChange={(e) => setProbationForm({ ...probationForm, startDate: e.target.value })} /></Field>
                  <Field label="Duration (days)"><input type="number" className="input-sm" value={probationForm.durationDays} onChange={(e) => setProbationForm({ ...probationForm, durationDays: e.target.value })} /></Field>
                  <button className="btn btn-primary btn-sm" type="submit">Start Probation</button>
                </form>
              )}
            </Card>
          ) : null}

          {tab === "documents" ? (
            <Card title="Documents">
              <form onSubmit={doUploadDoc} style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", alignItems: "flex-end", marginBottom: "0.8rem" }}>
                <Field label="Document Type"><input className="input-sm" value={docForm.docType} onChange={(e) => setDocForm({ ...docForm, docType: e.target.value })} required /></Field>
                <Field label="File Path/URL"><input className="input-sm" value={docForm.filePath} onChange={(e) => setDocForm({ ...docForm, filePath: e.target.value })} /></Field>
                <Field label="Issue Date"><input type="date" className="input-sm" value={docForm.issueDate} onChange={(e) => setDocForm({ ...docForm, issueDate: e.target.value })} /></Field>
                <Field label="Expiry Date"><input type="date" className="input-sm" value={docForm.expiryDate} onChange={(e) => setDocForm({ ...docForm, expiryDate: e.target.value })} /></Field>
                <button className="btn btn-primary btn-sm" type="submit">Add</button>
              </form>
              <table>
                <thead><tr><th>Type</th><th>Issued</th><th>Expires</th></tr></thead>
                <tbody>
                  {profile.documents.length === 0 ? <EmptyRow colSpan={3}>No documents on file.</EmptyRow> : profile.documents.map((d) => (
                    <tr key={d.id}><td>{d.doc_type}</td><td>{d.issue_date ? fmtDate(d.issue_date) : "—"}</td><td>{d.expiry_date ? fmtDate(d.expiry_date) : "—"}</td></tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}

          {tab === "checklist" ? (
            <Card title="Onboarding Checklist">
              <table>
                <thead><tr><th>Task</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {profile.onboardingTasks.length === 0 ? <EmptyRow colSpan={3}>No checklist tasks.</EmptyRow> : profile.onboardingTasks.map((t) => (
                    <tr key={t.id}>
                      <td>{t.label}</td><td><Stamp status={t.status === "completed" ? "approved" : "pending"} label={t.status} /></td>
                      <td>{t.status === "pending" ? <button className="btn btn-ghost btn-sm" onClick={() => doCompleteTask(t.id)}>Mark Done</button> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : null}
        </>
      )}
    </>
  );
}

export const PAGES = {
  dashboard: DashboardPage,
  calendar: CalendarPage,
  "timesheet-entry": TimesheetEntryPage,
  "timesheet-history": TimesheetHistoryPage,
  "leave-application": LeaveApplicationPage,
  "leave-history": LeaveHistoryPage,
  approvals: ApprovalsPage,
  "team-timesheets": TeamTimesheetsPage,
  reports: ReportsPage,
  team: TeamPage,
  profile: ProfilePage,
  admin: AdminPage,
  "my-salary": MySalaryPage,
  "my-tax-declaration": MyTaxDeclarationPage,
  "my-payslips": MyPayslipsPage,
  "payroll-dashboard": PayrollDashboardPage,
  "payroll-run": PayrollRunPage,
  "salary-admin": SalaryAdminPage,
  "payroll-benefits-admin": PayrollBenefitsAdminPage,
  "payroll-reports": PayrollReportsPage,
  "my-benefits": MyBenefitsPage,
  "my-attendance": MyAttendancePage,
  "attendance-admin": AttendanceAdminPage,
  "my-tax-statement": MyTaxStatementPage,
  "compliance-admin": ComplianceAdminPage,
  "fnf-admin": FnfAdminPage,
  "my-comp-off": MyCompOffPage,
  "leave-calendar": TeamLeaveCalendarPage,
  "leave-admin": LeaveAdminPage,
  "lifecycle-admin": EmployeeLifecycleAdminPage,
};
