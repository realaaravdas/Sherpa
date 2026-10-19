// Encrypted per-user record store. All personal data goes through here.
import crypto from 'node:crypto';
import { db } from './db.js';
import { encrypt, decrypt } from './security.js';

const aad = (userId, kind) => `${userId}:${kind}`;
export const newId = () => crypto.randomUUID();

export function list(user, kind) {
  return db.prepare('SELECT id,data_enc,created_at,updated_at FROM records WHERE user_id=? AND kind=? ORDER BY created_at').all(user.userId, kind)
    .map((r) => ({ ...JSON.parse(decrypt(user.dataKey, r.data_enc, aad(user.userId, kind))), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at }));
}
export function get(user, kind, id) {
  const r = db.prepare('SELECT id,data_enc,created_at,updated_at FROM records WHERE user_id=? AND kind=? AND id=?').get(user.userId, kind, id);
  return r ? { ...JSON.parse(decrypt(user.dataKey, r.data_enc, aad(user.userId, kind))), id: r.id, createdAt: r.created_at, updatedAt: r.updated_at } : null;
}
export function put(user, kind, data, id = newId()) {
  const { id: _i, createdAt, updatedAt, ...clean } = data;
  const now = Date.now();
  const blob = encrypt(user.dataKey, JSON.stringify(clean), aad(user.userId, kind));
  db.prepare(`INSERT INTO records (id,user_id,kind,data_enc,created_at,updated_at) VALUES (?,?,?,?,?,?)
              ON CONFLICT(id) DO UPDATE SET data_enc=excluded.data_enc, updated_at=excluded.updated_at WHERE user_id=excluded.user_id`)
    .run(id, user.userId, kind, blob, createdAt || now, now);
  return { ...clean, id, createdAt: createdAt || now, updatedAt: now };
}
export const remove = (user, kind, id) => db.prepare('DELETE FROM records WHERE user_id=? AND kind=? AND id=?').run(user.userId, kind, id).changes > 0;

// Singleton records (profile, state): one row per user+kind.
export function getSingleton(user, kind, fallback = {}) {
  const r = db.prepare('SELECT id FROM records WHERE user_id=? AND kind=?').get(user.userId, kind);
  return r ? get(user, kind, r.id) : { ...fallback };
}
export function putSingleton(user, kind, data) {
  const r = db.prepare('SELECT id FROM records WHERE user_id=? AND kind=?').get(user.userId, kind);
  return put(user, kind, data, r?.id);
}
