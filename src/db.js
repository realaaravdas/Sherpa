import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

export const db = new DatabaseSync(config.dbFile);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,           -- argon2id(HMAC(pepper, password))
  kek_salt      BLOB NOT NULL,           -- salt for password-derived key-encryption key
  wrapped_key   TEXT NOT NULL,           -- data key wrapped by password-derived KEK
  rec_salt      BLOB NOT NULL,
  rec_wrapped   TEXT NOT NULL,           -- data key wrapped by recovery-code-derived KEK
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,           -- sha256(token) hex; the token itself lives only in the cookie
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_enc    TEXT NOT NULL,              -- data key encrypted with a key derived from the session token
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip         TEXT,
  ua         TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Every piece of personal data (profile, applications, documents, chats) is an
-- AES-256-GCM encrypted JSON blob under the user's data key.
CREATE TABLE IF NOT EXISTS records (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,              -- profile | state | application | document | chat
  data_enc   TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS records_user_kind ON records(user_id, kind);

-- Public job pool shared by everyone (contains no personal data).
CREATE TABLE IF NOT EXISTS jobs (
  id           TEXT PRIMARY KEY,         -- fingerprint of company+title+location
  title        TEXT NOT NULL,
  company      TEXT NOT NULL,
  company_key  TEXT NOT NULL,
  location     TEXT,
  country      TEXT,
  remote       INTEGER NOT NULL DEFAULT 0, -- 0 unknown/onsite, 1 hybrid, 2 remote
  url          TEXT NOT NULL,
  apply_url    TEXT,
  description  TEXT,
  salary_min   INTEGER,
  salary_max   INTEGER,
  salary_cur   TEXT,
  employment   TEXT,
  seniority    TEXT,
  skills       TEXT NOT NULL DEFAULT '[]',
  department   TEXT,
  sources      TEXT NOT NULL DEFAULT '[]', -- [{source, url, id}]
  posted_at    INTEGER,
  first_seen   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  active       INTEGER NOT NULL DEFAULT 1,
  embedding    BLOB
);
CREATE INDEX IF NOT EXISTS jobs_active_posted ON jobs(active, posted_at DESC);
CREATE INDEX IF NOT EXISTS jobs_company ON jobs(company_key);

CREATE VIRTUAL TABLE IF NOT EXISTS jobs_fts USING fts5(title, company, skills, description, tokenize='porter unicode61');

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

CREATE TABLE IF NOT EXISTS source_health (
  source      TEXT PRIMARY KEY,          -- e.g. greenhouse:stripe
  kind        TEXT NOT NULL,
  last_run    INTEGER,
  last_ok     INTEGER,
  failures    INTEGER NOT NULL DEFAULT 0,
  last_error  TEXT,
  last_count  INTEGER NOT NULL DEFAULT 0,
  disabled    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS scrape_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  sources INTEGER, found INTEGER, added INTEGER, updated INTEGER, expired INTEGER, errors INTEGER
);
`);

export const tx = (fn) => {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
};
