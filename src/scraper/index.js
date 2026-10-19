import { db, tx } from '../db.js';
import { config } from '../config.js';
import { COMPANIES, runAdapter, isComplete, aggregators, sourceKey } from './adapters.js';
import { pool, withDeadline } from './http.js';

const MAX_FAILURES = 6;
const PRIORITY = { greenhouse: 5, lever: 5, ashby: 5, workable: 5, recruitee: 5, smartrecruiters: 5, page: 4, hackernews: 1 }; // ATS links beat aggregator links

const getJob = db.prepare('SELECT rowid AS rid, * FROM jobs WHERE id=?');
const insJob = db.prepare(`INSERT INTO jobs (id,title,company,company_key,location,country,remote,url,apply_url,description,salary_min,salary_max,salary_cur,employment,seniority,skills,department,sources,posted_at,first_seen,last_seen,active)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);
const updJob = db.prepare(`UPDATE jobs SET title=?,url=?,apply_url=?,description=?,location=?,country=?,remote=?,salary_min=?,salary_max=?,salary_cur=?,employment=?,seniority=?,skills=?,department=?,sources=?,posted_at=?,last_seen=?,active=1,embedding=? WHERE id=?`);
const ftsDel = db.prepare('DELETE FROM jobs_fts WHERE rowid=?');
const ftsIns = db.prepare('INSERT INTO jobs_fts(rowid,title,company,skills,description) VALUES (?,?,?,?,?)');

const srcKind = (k) => k.split(':')[0];
const rank = (s) => PRIORITY[srcKind(s.key)] ?? 2;

/** Insert a scraped job or merge it into the existing record (same job seen on several boards). */
export function upsertJob(j, now = Date.now()) {
  const entry = { key: j.source.source, id: j.source.id, url: j.source.url };
  const ex = getJob.get(j.id);
  if (!ex) {
    const r = insJob.run(j.id, j.title, j.company, j.companyKey, j.location, j.country, j.remote, j.url, j.applyUrl, j.description,
      j.salary?.min ?? null, j.salary?.max ?? null, j.salary?.currency ?? null, j.employment, j.seniority, JSON.stringify(j.skills), j.department,
      JSON.stringify([entry]), j.postedAt, now, now);
    ftsIns.run(r.lastInsertRowid, j.title, j.company, j.skills.join(' '), j.description.slice(0, 8000));
    return 'added';
  }
  const sources = JSON.parse(ex.sources).filter((s) => s.key !== entry.key);
  sources.push(entry);
  sources.sort((a, b) => rank(b) - rank(a));
  const best = sources[0];
  const mine = rank(entry) >= rank(best); // this source is (one of) the best → it supplies the canonical url
  const longer = (j.description?.length || 0) > (ex.description?.length || 0);
  const desc = longer ? j.description : ex.description;
  const skills = [...new Set([...JSON.parse(ex.skills), ...j.skills])];
  const sal = j.salary || (ex.salary_min ? { min: ex.salary_min, max: ex.salary_max, currency: ex.salary_cur } : null);
  const url = mine ? j.url : ex.url, apply = mine ? j.applyUrl : ex.apply_url;
  updJob.run(j.title.length >= ex.title.length || mine ? j.title : ex.title, url, apply, desc, j.location || ex.location, j.country || ex.country, Math.max(j.remote, ex.remote ? ex.remote : 0),
    sal?.min ?? null, sal?.max ?? null, sal?.currency ?? null, j.employment || ex.employment, j.seniority || ex.seniority, JSON.stringify(skills), j.department || ex.department,
    JSON.stringify(sources), Math.min(j.postedAt ?? Infinity, ex.posted_at ?? Infinity) === Infinity ? null : Math.min(j.postedAt ?? Infinity, ex.posted_at ?? Infinity),
    now, longer ? null : ex.embedding, j.id);
  ftsDel.run(ex.rid);
  ftsIns.run(ex.rid, j.title, j.company, skills.join(' '), desc.slice(0, 8000));
  return 'updated';
}

/** After a *complete* board scrape, anything not seen is closed: drop this source from it; deactivate if no source remains. */
export function expireMissing(sourceKeyStr, runStart) {
  const rows = db.prepare(`SELECT id,sources FROM jobs WHERE active=1 AND last_seen<? AND EXISTS (SELECT 1 FROM json_each(sources) WHERE json_extract(value,'$.key')=?)`).all(runStart, sourceKeyStr);
  let n = 0;
  for (const r of rows) {
    const rest = JSON.parse(r.sources).filter((s) => s.key !== sourceKeyStr);
    if (rest.length) db.prepare('UPDATE jobs SET sources=? WHERE id=?').run(JSON.stringify(rest), r.id);
    else { db.prepare('UPDATE jobs SET active=0,sources=? WHERE id=?').run(JSON.stringify(rest), r.id); n++; }
  }
  return n;
}

const health = {
  ok: db.prepare(`INSERT INTO source_health (source,kind,last_run,last_ok,failures,last_count) VALUES (?,?,?,?,0,?) ON CONFLICT(source) DO UPDATE SET last_run=excluded.last_run,last_ok=excluded.last_ok,failures=0,last_error=NULL,last_count=excluded.last_count,disabled=0`),
  fail: db.prepare(`INSERT INTO source_health (source,kind,last_run,failures,last_error) VALUES (?,?,?,1,?) ON CONFLICT(source) DO UPDATE SET last_run=excluded.last_run,failures=failures+1,last_error=excluded.last_error,disabled=CASE WHEN failures+1>=? THEN 1 ELSE disabled END`),
  get: db.prepare('SELECT * FROM source_health WHERE source=?'),
};

/** Scrape one source and persist the result. Safe to call concurrently for different sources. */
export async function scrapeSource({ kind, arg }) {
  const key = sourceKey(kind, kind === 'page' || (kind in aggregators) ? (kind === 'page' ? new URL(arg).hostname : '') : arg);
  const start = Date.now();
  const h = health.get.get(key);
  if (h?.disabled && start - h.last_run < 24 * 3_600_000) return { key, skipped: 'disabled after repeated failures' };
  try {
    const jobs = (await withDeadline(runAdapter(kind, arg), 180_000, 'source')).filter(Boolean);
    let added = 0, updated = 0, expired = 0;
    tx(() => {
      for (const j of jobs) { if (upsertJob(j, start) === 'added') added++; else updated++; }
      if (isComplete(kind) && jobs.length) expired = expireMissing(key, start);
    });
    health.ok.run(key, kind, start, start, jobs.length);
    return { key, found: jobs.length, added, updated, expired };
  } catch (e) {
    health.fail.run(key, kind, start, String(e.message).slice(0, 300), MAX_FAILURES);
    return { key, error: e.message };
  }
}

export function defaultTasks() {
  const t = [];
  for (const kind of ['greenhouse', 'lever', 'ashby']) for (const arg of COMPANIES[kind] || []) t.push({ kind, arg });
  for (const kind of Object.keys(aggregators)) t.push({ kind });
  return t;
}

let running = null;
export const isScraping = () => !!running;

/** Run a batch of tasks (default: the whole curated set). Only one global run at a time. */
export function scrapeAll(tasks = defaultTasks(), { concurrency = 6 } = {}) {
  if (running) return running;
  running = (async () => {
    const started = Date.now();
    const results = await pool(tasks, concurrency, (t) => scrapeSource(t));
    const staleBefore = started - config.scrape.staleAfterDays * 86_400_000;
    // aggregator jobs have no completeness guarantee → age them out
    const aged = db.prepare(`UPDATE jobs SET active=0 WHERE active=1 AND last_seen<?`).run(staleBefore).changes;
    const sum = (k) => results.reduce((a, r) => a + (r?.[k] || 0), 0);
    const errors = results.filter((r) => r?.error).length;
    db.prepare('INSERT INTO scrape_runs (started_at,finished_at,sources,found,added,updated,expired,errors) VALUES (?,?,?,?,?,?,?,?)')
      .run(started, Date.now(), tasks.length, sum('found'), sum('added'), sum('updated'), sum('expired') + aged, errors);
    return { sources: tasks.length, found: sum('found'), added: sum('added'), updated: sum('updated'), expired: sum('expired') + aged, errors, failures: results.filter((r) => r?.error).map((r) => `${r.key}: ${r.error}`) };
  })().finally(() => { running = null; });
  return running;
}

let timer;
export function startScheduler(log = console) {
  if (!config.scrape.intervalMin) return;
  const go = () => scrapeAll().then((r) => log.log(`[scrape] ${r.found} found, ${r.added} new, ${r.expired} closed, ${r.errors} source errors`)).catch((e) => log.error('[scrape]', e));
  const last = db.prepare('SELECT MAX(started_at) m FROM scrape_runs').get().m || 0;
  if (config.scrape.onStart && Date.now() - last > config.scrape.intervalMin * 30_000) setTimeout(go, 1500);
  timer = setInterval(go, config.scrape.intervalMin * 60_000);
  timer.unref();
}
