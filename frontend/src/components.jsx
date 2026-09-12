import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from "react";
import * as api from "./api.js";

// ============================================================
// Small formatting / date helpers shared across pages
// ============================================================
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
export const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];

export function initials(name) {
  return (name || "").split(" ").map((p) => p[0]).join("").slice(0, 2).toUpperCase();
}
export function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d.length > 10 ? d : d + "T00:00:00");
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
export function fmtDateTime(d) {
  if (!d) return "—";
  return new Date(d.replace(" ", "T")).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
export function stampClass(status) {
  return { approved: "approved", pending: "pending", rejected: "rejected", draft: "draft", cancelled: "draft" }[status] || "draft";
}
export function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  return "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
export function fmtMoneyDec(v) {
  if (v === null || v === undefined) return "—";
  return "₹" + Number(v).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function mondayOf(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  d.setDate(d.getDate() + diff);
  return d;
}
export function weekDates(mondayDate) {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(mondayDate);
    d.setDate(d.getDate() + i);
    out.push(d);
  }
  return out;
}
export function toISODate(d) { return d.toISOString().slice(0, 10); }
export function addWeeks(dateObj, n) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + n * 7);
  return d;
}
export function leaveTypeName(id, types) {
  const t = (types || []).find((x) => x.id === id || x.id === parseInt(id, 10));
  return t ? t.name : "—";
}
export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

// ============================================================
// Toast
// ============================================================
const ToastContext = createContext(() => {});
export function useToast() { return useContext(ToastContext); }

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null); // { msg, isError }
  const timerRef = useRef(null);

  const showToast = useCallback((msg, isError = false) => {
    setToast({ msg, isError });
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  const showError = useCallback((err) => {
    console.error(err);
    showToast(err?.message || "Something went wrong", true);
  }, [showToast]);

  return (
    <ToastContext.Provider value={{ showToast, showError }}>
      {children}
      <div className={`toast${toast ? " show" : ""}${toast?.isError ? " error" : ""}`}>
        <span className="dot" />
        <span>{toast?.msg || ""}</span>
      </div>
    </ToastContext.Provider>
  );
}

// ============================================================
// Modal
// ============================================================
const ModalContext = createContext(null);
export function useModal() { return useContext(ModalContext); }

export function ModalProvider({ children }) {
  const [modal, setModal] = useState(null); // { title, body, footer }

  const openModal = useCallback((title, body, footer) => setModal({ title, body, footer }), []);
  const closeModal = useCallback(() => setModal(null), []);

  /** Promise-based comment prompt, replacing the old promptComment() helper. */
  const promptComment = useCallback((actionLabel, required = false) => {
    return new Promise((resolve) => {
      let value = "";
      let error = "";
      const renderBody = () => (
        <div className="field">
          <label>Comment {required ? "(required — the employee will see this)" : "(optional)"}</label>
          <textarea
            autoFocus
            placeholder={required ? "Explain what needs to change..." : "Add a note for the employee..."}
            defaultValue={value}
            onChange={(e) => { value = e.target.value; }}
          />
          {error ? <div className="inline-error">{error}</div> : null}
        </div>
      );
      const submit = () => {
        const v = value.trim();
        if (required && !v) {
          error = "A comment is required when rejecting.";
          setModal((m) => (m ? { ...m, body: renderBody() } : m));
          return;
        }
        setModal(null);
        resolve(v || "");
      };
      const cancel = () => { setModal(null); resolve(null); };
      setModal({
        title: actionLabel,
        body: renderBody(),
        footer: (
          <>
            <button className="btn btn-ghost" onClick={cancel}>Cancel</button>
            <button className="btn btn-primary" onClick={submit}>Confirm</button>
          </>
        ),
      });
    });
  }, []);

  return (
    <ModalContext.Provider value={{ openModal, closeModal, promptComment }}>
      {children}
      <div className={`modal-overlay${modal ? " open" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
        <div className="modal">
          <div className="modal-header">
            <h3>{modal?.title || ""}</h3>
            <button className="modal-close" onClick={closeModal}>✕</button>
          </div>
          <div className="modal-body">{modal?.body}</div>
          <div className="modal-footer">{modal?.footer}</div>
        </div>
      </div>
    </ModalContext.Provider>
  );
}

// ============================================================
// Auth context — user, csrf token, session bootstrap
// ============================================================
const AuthContext = createContext(null);
export function useAuth() { return useContext(AuthContext); }

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [mustReset, setMustReset] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { user: u, csrfToken: tok } = await api.me();
        api.setCsrfToken(tok);
        setUser(u);
      } catch (e) {
        /* not logged in */
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  const doLogin = useCallback(async (email, password) => {
    const { user: u, csrfToken: tok, mustReset: mr } = await api.login(email, password);
    api.setCsrfToken(tok);
    setUser(u);
    if (mr) setMustReset(true);
    return { mustReset: !!mr };
  }, []);

  const completeForcedReset = useCallback(async (currentPassword, newPassword) => {
    await api.changePassword(currentPassword, newPassword);
    setMustReset(false);
  }, []);

  const doLogout = useCallback(async () => {
    try { await api.logout(); } catch (e) { /* ignore */ }
    api.setCsrfToken(null);
    setUser(null);
    setMustReset(false);
  }, []);

  const refreshUser = useCallback(async () => {
    const { user: u } = await api.me();
    setUser(u);
    return u;
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser, mustReset, checking, doLogin, completeForcedReset, doLogout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
}

// ============================================================
// Nav structure — identical grouping/labels/roles to the original app
// ============================================================
// Small glyph per nav destination — purely decorative, keyed by the same
// route ids already used everywhere else, so it never touches routing.
export const NAV_ICONS = {
  "dashboard": "◈", "calendar": "▦", "timesheet-entry": "◷", "timesheet-history": "☰",
  "leave-application": "✎", "leave-history": "▤",
  "my-salary": "₹", "my-tax-declaration": "§", "my-payslips": "▧", "my-benefits": "☂",
  "approvals": "✓", "team-timesheets": "▥", "reports": "▲", "team": "◎",
  "payroll-dashboard": "◈", "payroll-run": "⟳", "salary-admin": "₹",
  "payroll-benefits-admin": "☂", "payroll-reports": "△",
  "my-attendance": "⏱", "attendance-admin": "⏱",
  "my-tax-statement": "§", "compliance-admin": "§", "fnf-admin": "⏏",
  "my-comp-off": "☯", "leave-calendar": "▤", "leave-admin": "▤", "lifecycle-admin": "◐",
  "admin": "⚙", "profile": "◐",
};

export const NAV_ITEMS = {
  employee: [
    { section: "Time", items: [
      { id: "dashboard", label: "Dashboard" },
      { id: "calendar", label: "Calendar" },
      { id: "timesheet-entry", label: "Submit Timesheet" },
      { id: "timesheet-history", label: "Timesheet History" },
      { id: "my-attendance", label: "My Attendance" },
      { id: "my-comp-off", label: "My Comp-Off" },
      { id: "leave-calendar", label: "Leave Calendar" },
    ]},
    { section: "Leave", items: [
      { id: "leave-application", label: "Apply for Leave" },
      { id: "leave-history", label: "Leave History" },
    ]},
    { section: "Payroll", items: [
      { id: "my-salary", label: "My Salary" },
      { id: "my-tax-declaration", label: "Tax Declaration" },
      { id: "my-tax-statement", label: "My Tax Statement" },
      { id: "my-payslips", label: "My Payslips" },
      { id: "my-benefits", label: "My Benefits" },
    ]},
    { section: "Account", items: [{ id: "profile", label: "My Profile" }] },
  ],
  manager: [
    { section: "Time", items: [
      { id: "dashboard", label: "Dashboard" },
      { id: "calendar", label: "Calendar" },
      { id: "timesheet-entry", label: "Submit Timesheet" },
      { id: "timesheet-history", label: "Timesheet History" },
      { id: "my-attendance", label: "My Attendance" },
      { id: "my-comp-off", label: "My Comp-Off" },
      { id: "leave-calendar", label: "Leave Calendar" },
    ]},
    { section: "Leave", items: [
      { id: "leave-application", label: "Apply for Leave" },
      { id: "leave-history", label: "Leave History" },
    ]},
    { section: "Payroll", items: [
      { id: "my-salary", label: "My Salary" },
      { id: "my-tax-declaration", label: "Tax Declaration" },
      { id: "my-tax-statement", label: "My Tax Statement" },
      { id: "my-payslips", label: "My Payslips" },
      { id: "my-benefits", label: "My Benefits" },
    ]},
    { section: "Team", items: [
      { id: "approvals", label: "Approvals" },
      { id: "team-timesheets", label: "Team Timesheets" },
      { id: "reports", label: "Reports" },
      { id: "team", label: "My Team" },
    ]},
    { section: "Account", items: [{ id: "profile", label: "My Profile" }] },
  ],
  admin: [
    { section: "Time", items: [
      { id: "dashboard", label: "Dashboard" },
      { id: "calendar", label: "Calendar" },
      { id: "timesheet-entry", label: "Submit Timesheet" },
      { id: "timesheet-history", label: "Timesheet History" },
      { id: "my-attendance", label: "My Attendance" },
      { id: "my-comp-off", label: "My Comp-Off" },
      { id: "leave-calendar", label: "Leave Calendar" },
    ]},
    { section: "Leave", items: [
      { id: "leave-application", label: "Apply for Leave" },
      { id: "leave-history", label: "Leave History" },
    ]},
    { section: "Payroll", items: [
      { id: "payroll-dashboard", label: "Payroll Dashboard" },
      { id: "payroll-run", label: "Payroll Runs" },
      { id: "salary-admin", label: "Salary Setup" },
      { id: "payroll-benefits-admin", label: "Loans, Advances & Encashment" },
      { id: "payroll-reports", label: "Payroll Reports" },
    ]},
    { section: "Attendance", items: [
      { id: "attendance-admin", label: "Attendance Management" },
    ]},
    { section: "Compliance", items: [
      { id: "compliance-admin", label: "Tax & Statutory Compliance" },
    ]},
    { section: "Offboarding", items: [
      { id: "fnf-admin", label: "Full & Final Settlement" },
    ]},
    { section: "Leave", items: [
      { id: "leave-admin", label: "Leave Policies & Comp-Off" },
    ]},
    { section: "Lifecycle", items: [
      { id: "lifecycle-admin", label: "Employee Lifecycle" },
    ]},
    { section: "Payroll (My)", items: [
      { id: "my-salary", label: "My Salary" },
      { id: "my-tax-declaration", label: "Tax Declaration" },
      { id: "my-tax-statement", label: "My Tax Statement" },
      { id: "my-payslips", label: "My Payslips" },
      { id: "my-benefits", label: "My Benefits" },
    ]},
    { section: "Team", items: [
      { id: "approvals", label: "Approvals" },
      { id: "team-timesheets", label: "Team Timesheets" },
      { id: "reports", label: "Reports" },
    ]},
    { section: "Administration", items: [{ id: "admin", label: "User & System Admin" }] },
    { section: "Account", items: [{ id: "profile", label: "My Profile" }] },
  ],
};

// ============================================================
// Brand mark (sidebar + login screen)
// ============================================================
export function BrandMark() {
  return (
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
  );
}

// ============================================================
// Sidebar
// ============================================================
export function Sidebar({ view, setView, sidebarOpen, closeSidebar }) {
  const { user, doLogout } = useAuth();
  if (!user) return null;
  const groups = NAV_ITEMS[user.role] || [];
  return (
    <aside className={`sidebar${sidebarOpen ? " open" : ""}`} id="app-sidebar">
      <BrandMark />
      <nav>
        {groups.map((group) => (
          <div className="nav-group" key={group.section}>
            <div className="nav-label">{group.section}</div>
            {group.items.map((item) => (
              <button
                key={item.id}
                className={`nav-item${view === item.id ? " active" : ""}`}
                onClick={() => { setView(item.id); closeSidebar(); }}
              >
                <span className="nav-icon" aria-hidden="true">{NAV_ICONS[item.id] || "•"}</span>
                <span className="nav-label-text">{item.label}</span>
                <span className="dot" />
              </button>
            ))}
          </div>
        ))}
      </nav>
      <div className="sidebar-footer">
        <div className="user-chip">
          <div className="user-avatar" style={{ background: user.avatar_color || "var(--amber)" }}>{initials(user.name)}</div>
          <div className="who">
            <div className="name">{user.name}</div>
            <div className="role">{user.role}</div>
          </div>
        </div>
        <button className="logout-btn" onClick={() => { closeSidebar(); doLogout(); }}>↩ Sign out</button>
      </div>
    </aside>
  );
}

// ============================================================
// Notification bell + dropdown
// ============================================================
export function NotifBell() {
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      const { items: it, unreadCount: uc } = await api.getNotifications();
      setItems(it);
      setUnreadCount(uc);
    } catch (e) { /* silent — notifications are non-critical */ }
  }, []);

  useEffect(() => {
    refresh();
    const handle = setInterval(refresh, 30000);
    return () => clearInterval(handle);
  }, [refresh]);

  useEffect(() => {
    function onDocClick(e) {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, []);

  async function onItemClick(id) {
    await api.markNotificationRead(id);
    refresh();
  }
  async function markAll(e) {
    e.stopPropagation();
    await api.markAllNotificationsRead();
    refresh();
  }

  return (
    <div style={{ position: "relative", marginLeft: "auto" }} ref={rootRef}>
      <button className={`notif-bell${unreadCount > 0 ? " has-unread" : ""}`} title="Notifications" onClick={() => setOpen((o) => !o)}>
        🔔<span className="notif-dot" />
      </button>
      <div className={`notif-dropdown${open ? " open" : ""}`}>
        <div className="notif-dropdown-head">
          <span>Notifications</span>
          <button onClick={markAll}>Mark all read</button>
        </div>
        <div>
          {items.length === 0 ? (
            <div className="notif-empty">You're all caught up.</div>
          ) : items.map((n) => (
            <div key={n.id} className={`notif-item${n.read ? "" : " unread"}`} onClick={() => onItemClick(n.id)}>
              <span className="n-dot" />
              <div>
                <div className="n-msg">{n.message}</div>
                <div className="n-time">{fmtDateTime(n.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Generic building blocks
// ============================================================
export function PageHead({ eyebrow, title, sub, actions }) {
  return (
    <div className="page-head">
      <div>
        <div className="eyebrow">{eyebrow}</div>
        <h1>{title}</h1>
        {sub ? <div className="sub">{sub}</div> : null}
      </div>
      {actions ? <div style={{ display: "flex", gap: "0.5rem" }}>{actions}</div> : null}
    </div>
  );
}

export function Card({ title, children, style, right }) {
  return (
    <div className="card" style={style}>
      {title ? (
        <div className="card-title" style={right ? { display: "flex", justifyContent: "space-between", alignItems: "center" } : undefined}>
          {title}{right}
        </div>
      ) : null}
      {children}
    </div>
  );
}

export function StatCard({ label, value, foot, tone }) {
  return (
    <div className={`stat-card${tone ? ` ${tone}` : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {foot ? <div className="foot">{foot}</div> : null}
    </div>
  );
}

export function Stamp({ status, label }) {
  return <span className={`stamp ${stampClass(status)}`}>{label || status}</span>;
}

export function EmptyRow({ colSpan, children }) {
  return (
    <tr className="empty-row">
      <td colSpan={colSpan}>{children}</td>
    </tr>
  );
}

// Shared full-width loading state — replaces the old plain "Loading…" text
// with a skeleton shimmer, matching the page-head + stat-grid shape most
// pages load into. Purely presentational; callers still gate on their own
// data becoming non-null exactly as before.
export function PageLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="skeleton" style={{ width: "8rem", height: "0.7rem", marginBottom: "0.7rem" }} />
      <div className="skeleton" style={{ width: "16rem", height: "1.6rem", marginBottom: "2rem" }} />
      <div className="stat-grid">
        {[0, 1, 2, 3].map((i) => (
          <div className="stat-card" key={i}>
            <div className="skeleton" style={{ width: "60%", height: "0.6rem", marginBottom: "0.8rem" }} />
            <div className="skeleton" style={{ width: "45%", height: "1.6rem" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

// Payroll workflow stepper — visualizes DRAFT → CALCULATED → REVIEWED →
// APPROVED → LOCKED for a run's existing `status` string. Read-only,
// decorative: it never changes what actions are shown, only how the
// current stage reads. `compact` renders a thin inline version for use
// inside a table cell.
const PAYROLL_STAGES = ["draft", "calculated", "reviewed", "approved", "locked"];
export function PayrollStagePath({ status, compact }) {
  const idx = PAYROLL_STAGES.indexOf(status);
  return (
    <div className={compact ? "stage-path stage-path-compact" : "stage-path"}>
      {PAYROLL_STAGES.map((stage, i) => {
        const state = idx < 0 ? "" : i < idx ? "done" : i === idx ? "current" : "";
        return (
          <React.Fragment key={stage}>
            <div className={`stage-node ${state}`}>
              <span className="stage-dot" />
              {!compact ? <span className="stage-name">{stage}</span> : null}
            </div>
            {i < PAYROLL_STAGES.length - 1 ? <span className={`stage-link${state === "done" ? " done" : ""}`} /> : null}
          </React.Fragment>
        );
      })}
    </div>
  );
}

export function BarChart({ rows, labelKey, valueKey, unit }) {
  const max = Math.max(1, ...rows.map((r) => r[valueKey] || 0));
  if (!rows.length) return <div style={{ color: "var(--text-dim)", fontSize: "0.85rem" }}>No data yet.</div>;
  return (
    <div className="bar-chart">
      {rows.map((r, i) => (
        <div className="bar-row" key={i}>
          <div className="bar-label">{r[labelKey]}</div>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${Math.round(((r[valueKey] || 0) / max) * 100)}%` }} /></div>
          <div className="bar-value">{r[valueKey]}{unit || ""}</div>
        </div>
      ))}
    </div>
  );
}

export function Field({ label, children }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  );
}

/** Expandable "View history" widget backed by /api/audit-log. */
export function AuditToggle({ entityType, entityId }) {
  const [open, setOpen] = useState(false);
  const [log, setLog] = useState(null);
  const { showError } = useToast();

  async function toggle(e) {
    e.preventDefault();
    if (open) { setOpen(false); return; }
    try {
      if (!log) {
        const { log: l } = await api.getAuditLog(entityType, entityId);
        setLog(l);
      }
      setOpen(true);
    } catch (err) { showError(err); }
  }

  return (
    <>
      <a href="#" className="audit-toggle" onClick={toggle}>{open ? "Hide history" : "View history"}</a>
      <div className={`audit-panel${open ? " open" : ""}`}>
        {open && log ? (
          log.length ? log.map((l, i) => (
            <div className="audit-item" key={i}>
              <span className="a-actor">{l.actor_name}</span> {l.action} — <span className="a-time">{fmtDateTime(l.acted_at)}</span>
              {l.notes ? <div className="a-notes">"{l.notes}"</div> : null}
            </div>
          )) : <div style={{ color: "var(--text-dim)", fontSize: "0.78rem" }}>No history yet.</div>
        ) : null}
      </div>
    </>
  );
}

/** Shared "reset a user's password" button + result modal, used by Admin and My Team. */
export function ResetPasswordButton({ userId, userName }) {
  const { openModal, closeModal } = useModal();
  const { showError } = useToast();

  async function onClick() {
    if (!window.confirm(`Reset the password for ${userName}? Their current password will stop working immediately.`)) return;
    try {
      const { tempPassword, userName: uName, userEmail } = await api.resetUserPassword(userId);
      openModal(
        `Password reset — ${uName}`,
        <>
          <p className="subtle-note" style={{ marginTop: 0 }}>
            Share this temporary password with {uName} ({userEmail}) through your normal channel — Slack, in person, etc.
            They'll be asked to set their own password the next time they sign in.
          </p>
          <Field label="Temporary password">
            <input type="text" defaultValue={tempPassword} readOnly style={{ fontFamily: "var(--font-mono)", fontSize: "1rem", textAlign: "center" }} />
          </Field>
        </>,
        <>
          <button className="btn btn-ghost" onClick={() => { navigator.clipboard?.writeText(tempPassword).catch(() => {}); }}>Copy</button>
          <button className="btn btn-primary" onClick={closeModal}>Done</button>
        </>
      );
    } catch (err) { showError(err); }
  }

  return <button className="btn btn-ghost btn-sm" onClick={onClick}>Reset Password</button>;
}

// ============================================================
// VISUAL-ONLY ADDITIONS (motion/VFX layer)
// These are purely decorative, isolated, and additive: no existing
// export above is modified. Both are opt-in — CursorGlow is mounted
// once in App.jsx and renders nothing that intercepts pointer events.
// ============================================================

/** True when the user has requested reduced motion at the OS/browser level. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(() =>
    typeof window !== "undefined" && window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)").matches : false
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener ? mq.addEventListener("change", onChange) : mq.addListener(onChange);
    return () => {
      mq.removeEventListener ? mq.removeEventListener("change", onChange) : mq.removeListener(onChange);
    };
  }, []);
  return reduced;
}

/**
 * A soft radial-gradient glow that follows the pointer on desktop.
 * - Renders nothing on touch devices (no `(pointer: fine)` match).
 * - Renders nothing when prefers-reduced-motion is set.
 * - `pointer-events: none` (see styles.css) so it can never intercept clicks.
 * - Listener is passive and removed on unmount.
 */
export function CursorGlow() {
  const dotRef = useRef(null);
  const reducedMotion = usePrefersReducedMotion();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    setEnabled(window.matchMedia("(pointer: fine)").matches);
  }, []);

  useEffect(() => {
    if (!enabled || reducedMotion) return;
    function onMove(e) {
      if (dotRef.current) {
        dotRef.current.style.transform = `translate(${e.clientX - 210}px, ${e.clientY - 210}px)`;
      }
    }
    window.addEventListener("mousemove", onMove, { passive: true });
    return () => window.removeEventListener("mousemove", onMove);
  }, [enabled, reducedMotion]);

  if (!enabled || reducedMotion) return null;
  return <div className="cursor-glow" ref={dotRef} aria-hidden="true" />;
}

/**
 * Powers the subtle mouse-follow spotlight on .card / .stat-card (see
 * styles.css `.card::after`). Uses a single delegated pointermove listener
 * and only ever writes CSS custom properties — never touches layout,
 * never intercepts events. No-op on touch devices or reduced motion.
 */
export function CardSpotlight() {
  const reducedMotion = usePrefersReducedMotion();
  useEffect(() => {
    if (reducedMotion || typeof window === "undefined" || !window.matchMedia) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    let raf = null;
    function onMove(e) {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = null;
        const el = e.target.closest && e.target.closest(".card, .stat-card");
        if (el) {
          const r = el.getBoundingClientRect();
          el.style.setProperty("--mx", `${e.clientX - r.left}px`);
          el.style.setProperty("--my", `${e.clientY - r.top}px`);
        }
      });
    }
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => { window.removeEventListener("pointermove", onMove); if (raf) cancelAnimationFrame(raf); };
  }, [reducedMotion]);
  return null;
}
