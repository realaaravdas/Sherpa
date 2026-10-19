import { Router } from 'express';
import crypto from 'node:crypto';
import { db, tx } from '../db.js';
import { config } from '../config.js';
import * as sec from '../security.js';
import { setSessionCookie, clearSessionCookie, requireAuth, limit } from '../middleware.js';
import { hit, clearHits } from '../security.js';

const r = Router();
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const norm = (e) => String(e || '').trim().toLowerCase();
const meta = (req) => ({ ip: req.ip, ua: req.get('user-agent') });

r.post('/register', limit('register', config.registerPerHourPerIp, 3_600_000, 'ip'), async (req, res) => {
  if (!config.allowRegistration) return res.status(403).json({ error: 'Registration is closed on this server' });
  const email = norm(req.body?.email), password = req.body?.password;
  if (!EMAIL.test(email) || email.length > 254) return res.status(400).json({ error: 'Enter a valid email address' });
  const pwErr = sec.validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email)) {
    await sec.dummyVerify(password); // don't make registration a cheaper oracle than login
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const [passwordHash, km] = await Promise.all([sec.hashPassword(password), sec.createKeyMaterial(password)]);
  const id = crypto.randomUUID();
  try {
    db.prepare('INSERT INTO users (id,email,password_hash,kek_salt,wrapped_key,rec_salt,rec_wrapped,created_at) VALUES (?,?,?,?,?,?,?,?)')
      .run(id, email, passwordHash, km.kekSalt, km.wrapped, km.recSalt, km.recWrapped, Date.now());
  } catch { return res.status(409).json({ error: 'An account with this email already exists' }); }
  const s = sec.createSession(id, km.dataKey, meta(req));
  setSessionCookie(res, s.token, s.expiresAt);
  // The recovery code is shown exactly once; it's the only way to regain data after a forgotten password.
  res.status(201).json({ user: { id, email }, recoveryCode: km.recovery });
});

r.post('/login', limit('login-ip', 30, 900_000, 'ip'), async (req, res) => {
  const email = norm(req.body?.email), password = String(req.body?.password ?? '');
  // Two buckets: a tight one per (account, IP) so an attacker can't lock the real owner out from elsewhere,
  // and a looser per-account ceiling that still stops distributed guessing.
  const bucket = `login-acct:${email}|${req.ip}`, wide = `login-acct:${email}`;
  if (!hit(bucket, 8, 900_000) || !hit(wide, 40, 900_000)) return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const fail = () => res.status(401).json({ error: 'Incorrect email or password' });
  if (!user) { await sec.dummyVerify(password); return fail(); }
  if (!(await sec.verifyPassword(user.password_hash, password))) return fail();
  const dataKey = await sec.unwrapWithPassword(user, password);
  if (!dataKey) return res.status(500).json({ error: 'Could not unlock account data' });
  clearHits(bucket); clearHits(wide);
  const s = sec.createSession(user.id, dataKey, meta(req));
  setSessionCookie(res, s.token, s.expiresAt);
  res.json({ user: { id: user.id, email: user.email } });
});

r.post('/logout', (req, res) => {
  if (req.token) sec.invalidateSession(req.token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

r.get('/me', (req, res) => res.json({ user: req.user ? { id: req.user.userId, email: req.user.email } : null, registration: config.allowRegistration }));

r.post('/change-password', requireAuth, limit('pw', 6, 3_600_000), async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!(await sec.verifyPassword(user.password_hash, String(currentPassword ?? '')))) return res.status(401).json({ error: 'Current password is incorrect' });
  const err = sec.validatePassword(newPassword);
  if (err) return res.status(400).json({ error: err });
  const [hash, rw] = await Promise.all([sec.hashPassword(newPassword), sec.rewrapPassword(req.user.dataKey, newPassword)]);
  db.prepare('UPDATE users SET password_hash=?, kek_salt=?, wrapped_key=? WHERE id=?').run(hash, rw.kekSalt, rw.wrapped, user.id);
  sec.invalidateUserSessions(user.id, req.user.id); // sign out everywhere else
  res.json({ ok: true });
});

// Forgotten password: prove possession of the recovery code, set a new password, get a fresh code.
r.post('/recover', limit('recover', 10, 3_600_000, 'ip'), async (req, res) => {
  const email = norm(req.body?.email), { recoveryCode, newPassword } = req.body || {};
  const bucket = `recover-acct:${email}`;
  if (!hit(bucket, 5, 3_600_000)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
  const err = sec.validatePassword(newPassword);
  if (err) return res.status(400).json({ error: err });
  const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
  const dataKey = user && (await sec.unwrapWithRecovery(user, String(recoveryCode ?? '')));
  if (!dataKey) return res.status(401).json({ error: 'Email or recovery code is incorrect' });
  const [hash, rw, rr] = await Promise.all([sec.hashPassword(newPassword), sec.rewrapPassword(dataKey, newPassword), sec.rewrapRecovery(dataKey)]);
  db.prepare('UPDATE users SET password_hash=?, kek_salt=?, wrapped_key=?, rec_salt=?, rec_wrapped=? WHERE id=?').run(hash, rw.kekSalt, rw.wrapped, rr.recSalt, rr.recWrapped, user.id);
  sec.invalidateUserSessions(user.id);
  clearHits(bucket);
  const s = sec.createSession(user.id, dataKey, meta(req));
  setSessionCookie(res, s.token, s.expiresAt);
  res.json({ user: { id: user.id, email }, recoveryCode: rr.recovery });
});

r.post('/new-recovery-code', requireAuth, limit('pw', 6, 3_600_000), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!(await sec.verifyPassword(user.password_hash, String(req.body?.password ?? '')))) return res.status(401).json({ error: 'Password is incorrect' });
  const rr = await sec.rewrapRecovery(req.user.dataKey);
  db.prepare('UPDATE users SET rec_salt=?, rec_wrapped=? WHERE id=?').run(rr.recSalt, rr.recWrapped, user.id);
  res.json({ recoveryCode: rr.recovery });
});

r.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id,created_at,expires_at,ip,ua FROM sessions WHERE user_id=? ORDER BY created_at DESC').all(req.user.userId);
  res.json({ sessions: rows.map((s) => ({ id: s.id.slice(0, 12), current: s.id === req.user.id, createdAt: s.created_at, expiresAt: s.expires_at, ip: s.ip, ua: s.ua })) });
});
r.post('/logout-others', requireAuth, (req, res) => { sec.invalidateUserSessions(req.user.userId, req.user.id); res.json({ ok: true }); });

r.delete('/account', requireAuth, limit('pw', 6, 3_600_000), async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.userId);
  if (!(await sec.verifyPassword(user.password_hash, String(req.body?.password ?? '')))) return res.status(401).json({ error: 'Password is incorrect' });
  tx(() => db.prepare('DELETE FROM users WHERE id=?').run(user.id)); // cascades to sessions + records
  clearSessionCookie(res);
  res.json({ ok: true });
});

export default r;
