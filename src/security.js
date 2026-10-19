import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { hash, verify } from '@node-rs/argon2';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeBase32LowerCaseNoPadding, encodeBase32UpperCaseNoPadding, encodeHexLowerCase } from '@oslojs/encoding';
import { config } from './config.js';
import { db } from './db.js';

const scrypt = promisify(crypto.scrypt);

/* ───────────── passwords ─────────────
 * password → HMAC-SHA256(server pepper) → Argon2id (OWASP params).
 * The HMAC step removes any password-length DoS and means a stolen DB alone
 * can't be brute-forced without also stealing the server secret. */
const ARGON = { memoryCost: 19456, timeCost: 2, parallelism: 1 };
const pre = (pw) => crypto.createHmac('sha256', config.secret).update(pw).digest('base64');

export const hashPassword = (pw) => hash(pre(pw), ARGON);
export const verifyPassword = async (hashed, pw) => { try { return await verify(hashed, pre(pw)); } catch { return false; } };
// Used to equalise timing when the account doesn't exist.
let dummy;
export const dummyVerify = async (pw) => { dummy ??= await hashPassword('dummy-password-for-timing'); await verifyPassword(dummy, pw); };

export function validatePassword(pw) {
  if (typeof pw !== 'string') return 'Password required';
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 256) return 'Password too long';
  if (/^(.)\1+$/.test(pw) || /^(password|12345|qwerty)/i.test(pw)) return 'Password is too easy to guess';
  return null;
}

/* ───────────── field encryption (AES-256-GCM) ───────────── */
export const randomKey = () => crypto.randomBytes(32);

export function encrypt(key, plaintext, aad = '') {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
}
export function decrypt(key, blob, aad = '') {
  const [v, iv, tag, ct] = blob.split('.');
  if (v !== 'v1') throw new Error('Unknown ciphertext version');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
const encBytes = (key, buf, aad) => encrypt(key, buf.toString('base64'), aad);
const decBytes = (key, s, aad) => Buffer.from(decrypt(key, s, aad), 'base64');

/* ───────────── key hierarchy ─────────────
 * dataKey (random) encrypts all user records.
 * dataKey is stored wrapped twice: by a KEK derived (scrypt) from the password, and by a KEK
 * derived from a one-time recovery code shown at sign-up. The server never stores the password
 * or any key that can unwrap it without the user supplying one of them. */
const kdf = (secret, salt) => scrypt(secret, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });

export const newRecoveryCode = () => {
  const raw = encodeBase32UpperCaseNoPadding(crypto.randomBytes(15)); // 24 chars, 120 bits
  return raw.match(/.{4}/g).join('-');
};
const normCode = (c) => String(c).toUpperCase().replace(/[^A-Z2-7]/g, '');

export async function createKeyMaterial(password) {
  const dataKey = randomKey();
  const kekSalt = crypto.randomBytes(16), recSalt = crypto.randomBytes(16);
  const recovery = newRecoveryCode();
  return {
    dataKey, recovery, kekSalt, recSalt,
    wrapped: encBytes(await kdf(password, kekSalt), dataKey, 'wrap'),
    recWrapped: encBytes(await kdf(normCode(recovery), recSalt), dataKey, 'wrap'),
  };
}
export async function unwrapWithPassword(user, password) {
  try { return decBytes(await kdf(password, user.kek_salt), user.wrapped_key, 'wrap'); } catch { return null; }
}
export async function unwrapWithRecovery(user, code) {
  try { return decBytes(await kdf(normCode(code), user.rec_salt), user.rec_wrapped, 'wrap'); } catch { return null; }
}
export async function rewrapPassword(dataKey, password) {
  const kekSalt = crypto.randomBytes(16);
  return { kekSalt, wrapped: encBytes(await kdf(password, kekSalt), dataKey, 'wrap') };
}
export async function rewrapRecovery(dataKey) {
  const recovery = newRecoveryCode(), recSalt = crypto.randomBytes(16);
  return { recovery, recSalt, recWrapped: encBytes(await kdf(normCode(recovery), recSalt), dataKey, 'wrap') };
}

/* ───────────── sessions (Oslo / Lucia pattern) ─────────────
 * token: 160 random bits, base32. DB stores only sha256(token) so a DB leak can't hijack sessions.
 * The data key is held in the session row encrypted with HKDF(token), so it is only recoverable
 * from a request that carries the cookie. */
const DAY = 86_400_000;
const sessionId = (token) => encodeHexLowerCase(sha256(new TextEncoder().encode(token)));
const sessionKey = (token) => Buffer.from(crypto.hkdfSync('sha256', Buffer.from(token), Buffer.alloc(0), 'sherpa-session-key', 32));

export function createSession(userId, dataKey, meta = {}) {
  const token = encodeBase32LowerCaseNoPadding(crypto.getRandomValues(new Uint8Array(20)));
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id,user_id,key_enc,expires_at,created_at,ip,ua) VALUES (?,?,?,?,?,?,?)')
    .run(sessionId(token), userId, encBytes(sessionKey(token), dataKey, 'session'), now + config.sessionDays * DAY, now, meta.ip ?? null, (meta.ua ?? '').slice(0, 200));
  return { token, expiresAt: new Date(now + config.sessionDays * DAY) };
}

export function validateSession(token) {
  if (typeof token !== 'string' || token.length !== 32) return null;
  const id = sessionId(token);
  const s = db.prepare('SELECT s.*, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?').get(id);
  if (!s) return null;
  const now = Date.now();
  if (s.expires_at <= now) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); return null; }
  let dataKey;
  try { dataKey = decBytes(sessionKey(token), s.key_enc, 'session'); } catch { return null; }
  let refreshed = null;
  if (s.expires_at - now < (config.sessionDays * DAY) / 2) { // sliding expiry
    refreshed = new Date(now + config.sessionDays * DAY);
    db.prepare('UPDATE sessions SET expires_at=? WHERE id=?').run(+refreshed, id);
  }
  return { id, userId: s.user_id, email: s.email, dataKey, refreshed };
}
export const invalidateSession = (token) => token && db.prepare('DELETE FROM sessions WHERE id=?').run(sessionId(token));
export const invalidateUserSessions = (userId, exceptId) =>
  db.prepare('DELETE FROM sessions WHERE user_id=? AND id IS NOT ?').run(userId, exceptId ?? null);
export const purgeExpiredSessions = () => db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now());

/* ───────────── rate limiting (in-memory sliding window) ───────────── */
const buckets = new Map();
export function hit(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  buckets.set(key, arr);
  return arr.length <= limit;
}
export const clearHits = (key) => buckets.delete(key);
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3_600_000)) buckets.delete(k); }, 600_000).unref();
