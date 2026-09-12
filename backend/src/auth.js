// src/auth.js — authentication middleware, session handling, password
// hashing/verification, and role checks. Ported behavior-for-behavior from
// the original src/db.js (session/password sections) and src/server.js
// (the auth-related request handling), now as Express middleware.

const crypto = require('node:crypto');
const db = require('./db');
const { nowStr } = require('./utils');

// ---------------------------------------------------------------------------
// PASSWORD HELPERS (unchanged: scrypt, same params, same output shape)
// ---------------------------------------------------------------------------

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, hash, salt) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(check, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Used both by seed data (real onboarded users get a unique temp password
// each, not a shared default) and by admin/manager-initiated password reset.
const TEMP_PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars
function generateTempPassword() {
  let out = '';
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 10; i++) out += TEMP_PW_CHARS[bytes[i] % TEMP_PW_CHARS.length];
  return out;
}

// ---------------------------------------------------------------------------
// SESSIONS
// ---------------------------------------------------------------------------

const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.dbRun('INSERT INTO sessions (token, csrf_token, user_id, expires_at) VALUES (?, ?, ?, ?)', [token, csrfToken, userId, expiresAt]);
  return { token, csrfToken };
}

async function getSessionUser(token) {
  if (!token) return null;
  const row = await db.dbGet(`
    SELECT s.expires_at, s.csrf_token, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?
  `, [token]);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    await db.dbRun('DELETE FROM sessions WHERE token = ?', [token]);
    return null;
  }
  if (!row.active) return null;
  const csrfToken = row.csrf_token;
  delete row.password_hash;
  delete row.password_salt;
  delete row.expires_at;
  delete row.csrf_token;
  row._csrfToken = csrfToken;
  return row;
}

async function deleteSession(token) {
  await db.dbRun('DELETE FROM sessions WHERE token = ?', [token]);
}

async function deleteAllSessionsForUser(userId) {
  await db.dbRun('DELETE FROM sessions WHERE user_id = ?', [userId]);
}

// ---------------------------------------------------------------------------
// LOGIN RATE LIMITING (in-memory — resets on server restart, same as before)
// ---------------------------------------------------------------------------

const loginAttempts = new Map(); // email -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkLoginLock(email) {
  const rec = loginAttempts.get(email.toLowerCase());
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfterMs: rec.lockedUntil - Date.now() };
  }
  return { locked: false };
}

function recordLoginFailure(email) {
  const key = email.toLowerCase();
  const rec = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}

function clearLoginFailures(email) {
  loginAttempts.delete(email.toLowerCase());
}

// ---------------------------------------------------------------------------
// ADMIN/MANAGER-INITIATED PASSWORD RESET
// ---------------------------------------------------------------------------

async function adminResetPassword(userId) {
  const tempPassword = generateTempPassword();
  const pw = hashPassword(tempPassword);
  await db.dbRun('UPDATE users SET password_hash = ?, password_salt = ?, must_reset_password = 1 WHERE id = ?', [pw.hash, pw.salt, userId]);
  await deleteAllSessionsForUser(userId);
  return tempPassword;
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await db.dbGet('SELECT * FROM users WHERE id = ?', [userId]);
  if (!verifyPassword(currentPassword, user.password_hash, user.password_salt)) {
    const err = new Error('Current password is incorrect');
    err.code = 'BAD_CURRENT_PASSWORD';
    throw err;
  }
  const pw = hashPassword(newPassword);
  await db.dbRun('UPDATE users SET password_hash = ?, password_salt = ?, must_reset_password = 0 WHERE id = ?', [pw.hash, pw.salt, userId]);
}

// ---------------------------------------------------------------------------
// EXPRESS MIDDLEWARE
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
// endpoints exempt from CSRF because they run before a session exists
const CSRF_EXEMPT = new Set(['/api/login']);

// Resolves req.session = { token, user } for every request. Does not itself
// reject unauthenticated requests — /api/login and /api/me (GET) need to run
// without one. requireAuth below enforces the actual "must be signed in" gate.
async function attachSession(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.session;
    const user = await getSessionUser(token);
    req.session = { token, user };
    next();
  } catch (e) {
    next(e);
  }
}

function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) return res.status(401).json({ error: 'Not signed in' });
  next();
}

// CSRF check for mutating requests — same header/cookie double-submit scheme
// as before.
function csrfProtection(req, res, next) {
  if (MUTATING_METHODS.has(req.method) && !CSRF_EXEMPT.has(req.path)) {
    const user = req.session && req.session.user;
    const csrfHeader = req.headers['x-csrf-token'];
    if (!user || !csrfHeader || csrfHeader !== user._csrfToken) {
      return res.status(403).json({ error: 'Invalid or missing CSRF token' });
    }
  }
  next();
}

function requireRole(user, roles) {
  return !!(user && roles.includes(user.role));
}

// Express middleware factory: requireRoleMw(['admin']) etc.
function requireRoleMw(roles) {
  return (req, res, next) => {
    if (!requireRole(req.session.user, roles)) return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  generateTempPassword,
  createSession,
  getSessionUser,
  deleteSession,
  deleteAllSessionsForUser,
  checkLoginLock,
  recordLoginFailure,
  clearLoginFailures,
  adminResetPassword,
  changePassword,
  parseCookies,
  attachSession,
  requireAuth,
  csrfProtection,
  requireRole,
  requireRoleMw,
  MUTATING_METHODS,
  CSRF_EXEMPT,
};
