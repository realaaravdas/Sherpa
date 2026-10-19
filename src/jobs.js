import { db } from './db.js';
import { prepareProfile, hardReject, scoreJob } from './matching.js';
import { embed, toBlob, fromBlob, cosine, nimAvailable, resolveModel } from './nim.js';

const COLS = 'j.rowid AS rid, j.id,j.title,j.company,j.location,j.country,j.remote,j.url,j.apply_url,j.salary_min,j.salary_max,j.salary_cur,j.employment,j.seniority,j.skills,j.department,j.sources,j.posted_at,j.first_seen,j.active,j.embedding';

export function ftsQuery(q) {
  const toks = String(q || '').toLowerCase().match(/[\p{L}\p{N}+#.]+/gu)?.map((t) => t.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean) || [];
  return toks.slice(0, 8).map((t) => `"${t}"*`);
}

export function presentJob(r, extra = {}) {
  return {
    id: r.id, title: r.title, company: r.company, location: r.location, country: r.country, remote: r.remote,
    url: r.url, applyUrl: r.apply_url || r.url,
    salary: r.salary_min ? { min: r.salary_min, max: r.salary_max, currency: r.salary_cur || 'USD' } : null,
    employment: r.employment, seniority: r.seniority, skills: JSON.parse(r.skills || '[]'), department: r.department,
    sources: JSON.parse(r.sources || '[]').map((s) => s.key.split(':')[0] === 'page' ? s.key : s.key), postedAt: r.posted_at, firstSeen: r.first_seen, active: !!r.active,
    ...extra,
  };
}

/**
 * Search the job pool.
 * filters: q, remote (any|remote|hybrid|onsite), country, seniority, employment, minSalary, postedWithin (days), company, source
 * Returns candidate rows already filtered; scoring/sorting happens in rank().
 */
export function findCandidates(f = {}, cap = 3000) {
  const where = ['j.active=1'], args = [];
  let join = '', order = 'ORDER BY COALESCE(j.posted_at,j.first_seen) DESC';
  const terms = ftsQuery(f.q);
  if (terms.length) { join = 'JOIN jobs_fts ON jobs_fts.rowid=j.rowid'; where.push('jobs_fts MATCH ?'); args.push(terms.join(' ')); order = 'ORDER BY bm25(jobs_fts, 6.0, 3.0, 2.0, 1.0)'; }
  if (f.remote === 'remote') where.push('j.remote=2'); else if (f.remote === 'hybrid') where.push('j.remote=1'); else if (f.remote === 'onsite') where.push('j.remote<2');
  if (f.country) { where.push('(j.country=? OR j.remote=2)'); args.push(String(f.country).toUpperCase()); }
  if (f.seniority) { where.push('j.seniority=?'); args.push(f.seniority); }
  if (f.employment) { where.push('j.employment=?'); args.push(f.employment); }
  if (f.minSalary) { where.push('j.salary_max>=?'); args.push(+f.minSalary); }
  if (f.postedWithin) { where.push('COALESCE(j.posted_at,j.first_seen)>=?'); args.push(Date.now() - +f.postedWithin * 86_400_000); }
  if (f.company) { where.push('j.company_key LIKE ?'); args.push(`%${String(f.company).toLowerCase().replace(/[^a-z0-9 ]/g, '')}%`); }
  if (f.source) { where.push('j.sources LIKE ?'); args.push(`%"key":"${String(f.source).replace(/[^a-z0-9:._-]/gi, '')}%`); }
  const sql = `SELECT ${COLS} FROM jobs j ${join} WHERE ${where.join(' AND ')} ${order} LIMIT ${cap}`;
  let rows = db.prepare(sql).all(...args);
  if (!rows.length && terms.length > 1) { // relax AND → OR so multi-word searches still return near matches
    rows = db.prepare(sql).all(...args.map((a) => (a === terms.join(' ') ? terms.join(' OR ') : a)));
  }
  return rows;
}

/** Score & sort candidates for a user. profile may be empty → date order. */
export function rank(rows, profile, { sort = 'match', hidden = new Set(), states = new Map() } = {}) {
  const P = prepareProfile(profile || {});
  const qvec = profile?.embedding ? fromBlob(Buffer.from(profile.embedding, 'base64')) : null;
  const personalised = !!(P.skills.length || P.roles.length || P.resumeSkills.length || qvec);
  const out = [];
  for (const r of rows) {
    if (hidden.has(r.id)) continue;
    const job = { ...r, skills: JSON.parse(r.skills || '[]') };
    if (hardReject(job, P)) continue;
    const sem = qvec && r.embedding ? cosine(qvec, fromBlob(r.embedding)) : null; // null → keyword-only scoring
    const match = personalised ? scoreJob(job, P, { semantic: sem }) : null;
    out.push(presentJob(r, { match, state: states.get(r.id) || null }));
  }
  const date = (j) => j.postedAt || j.firstSeen;
  if (sort === 'match' && personalised) out.sort((a, b) => b.match.score - a.match.score || date(b) - date(a));
  else if (sort === 'salary') out.sort((a, b) => (b.salary?.max || 0) - (a.salary?.max || 0));
  else if (sort === 'date' || !personalised) { /* rows already ordered by relevance (FTS) or date */ if (sort === 'date') out.sort((a, b) => date(b) - date(a)); }
  return out;
}

/* ───────── background embedding of new jobs (server key only; the shared pool never uses a user's key) ───────── */
let embedding = false;
export async function embedPending(batch = 48) {
  if (embedding || !nimAvailable()) return 0;
  embedding = true;
  try {
    // Embeddings from different models can't be compared: when the model changes, start over.
    const model = await resolveModel('embed');
    const cur = db.prepare("SELECT v FROM meta WHERE k='embed_model'").get()?.v;
    if (cur !== model) { db.prepare('UPDATE jobs SET embedding=NULL').run(); db.prepare("INSERT INTO meta(k,v) VALUES('embed_model',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(model); }
    const rows = db.prepare('SELECT rowid AS rid,id,title,company,skills,description FROM jobs WHERE active=1 AND embedding IS NULL ORDER BY COALESCE(posted_at,first_seen) DESC LIMIT ?').all(batch);
    if (!rows.length) return 0;
    const vecs = await embed(rows.map((r) => `${r.title} at ${r.company}. Skills: ${JSON.parse(r.skills).join(', ')}. ${(r.description || '').slice(0, 1500)}`), { type: 'passage' });
    const upd = db.prepare('UPDATE jobs SET embedding=? WHERE id=?');
    rows.forEach((r, i) => upd.run(toBlob(vecs[i]), r.id));
    return rows.length;
  } finally { embedding = false; }
}
export function startEmbedder(log = console) {
  if (!nimAvailable()) return;
  const t = setInterval(() => embedPending().catch((e) => log.error('[embed]', e.message)), 45_000);
  t.unref();
}

export const getJobRow = (id) => db.prepare('SELECT j.*, j.rowid AS rid FROM jobs j WHERE j.id=?').get(id);

export function stats() {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    activeJobs: one('SELECT COUNT(*) n FROM jobs WHERE active=1').n,
    companies: one('SELECT COUNT(DISTINCT company_key) n FROM jobs WHERE active=1').n,
    addedLast24h: one('SELECT COUNT(*) n FROM jobs WHERE first_seen>?', Date.now() - 86_400_000).n,
    lastRun: db.prepare('SELECT * FROM scrape_runs ORDER BY id DESC LIMIT 1').get() || null,
    embeddedJobs: one('SELECT COUNT(*) n FROM jobs WHERE embedding IS NOT NULL AND active=1').n,
    semanticSearch: nimAvailable(),
  };
}
