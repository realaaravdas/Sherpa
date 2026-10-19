import { Router } from 'express';
import { db } from '../db.js';
import * as store from '../store.js';
import { requireAuth, limit } from '../middleware.js';
import { findCandidates, rank, presentJob, getJobRow, stats } from '../jobs.js';
import { prepareProfile, scoreJob } from '../matching.js';
import { scrapeAll, scrapeSource, isScraping, defaultTasks } from '../scraper/index.js';
import { detectSource, COMPANIES } from '../scraper/adapters.js';
import { safeGet, assertPublicUrl } from '../scraper/http.js';
import { fromBlob, cosine } from '../nim.js';

const r = Router();
r.use(requireAuth);

const stateOf = (u) => store.getSingleton(u, 'state', { hidden: [], sources: [] });
const CLOSED_RE = /no longer (accepting|available|open)|position (has been|is) (filled|closed)|job (is )?(not found|closed|expired|no longer)|this (job|position|role) (has|is) (been )?(closed|filled|expired|removed)|posting (has )?expired|page (you are looking for )?(was )?not found/i;

r.get('/', (req, res) => {
  const q = req.query;
  const profile = store.getSingleton(req.user, 'profile');
  const state = stateOf(req.user);
  const apps = store.list(req.user, 'application');
  const appState = new Map(apps.filter((a) => a.jobId).map((a) => [a.jobId, a.status]));
  const rows = findCandidates({
    q: String(q.q || '').slice(0, 120), remote: q.remote, country: q.country, seniority: q.seniority, employment: q.employment,
    minSalary: q.minSalary, postedWithin: q.postedWithin, company: q.company, source: q.source,
  });
  // The profile's own work-mode preference only applies when the user hasn't picked a filter explicitly.
  const useProfile = q.personalise === '0' ? {} : { ...profile, workMode: q.remote ? 'any' : profile.workMode };
  let list = rank(rows, useProfile, { sort: q.sort || (q.q ? 'relevance' : 'match'), hidden: new Set(state.hidden), states: appState });
  if (q.hideApplied === '1') list = list.filter((j) => !j.state);
  if (q.minMatch) list = list.filter((j) => (j.match?.score ?? 100) >= +q.minMatch);
  const page = Math.max(1, +q.page || 1), size = Math.min(100, Math.max(5, +q.size || 25));
  res.json({ total: list.length, page, size, jobs: list.slice((page - 1) * size, page * size), personalised: !!list[0]?.match });
});

r.get('/stats', (req, res) => res.json({
  ...stats(), scraping: isScraping(),
  sources: db.prepare('SELECT source,kind,last_ok,failures,last_count,disabled,last_error FROM source_health ORDER BY kind,source').all(),
}));

r.get('/:id', (req, res) => {
  const row = getJobRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  const profile = store.getSingleton(req.user, 'profile');
  const P = prepareProfile(profile);
  const j = presentJob(row);
  const sem = profile.embedding && row.embedding ? cosine(fromBlob(Buffer.from(profile.embedding, 'base64')), fromBlob(row.embedding)) : null;
  const app = store.list(req.user, 'application').find((a) => a.jobId === row.id);
  res.json({ job: { ...j, description: row.description, match: scoreJob({ ...row, skills: j.skills }, P, { semantic: sem }), state: app?.status || null, applicationId: app?.id || null,
    alsoOn: JSON.parse(row.sources).map((s) => ({ source: s.key, url: s.url })) } });
});

/** Is this posting still open? Checks the live page; closes the job for everybody if it's gone. */
r.post('/:id/verify', limit('verify', 40, 3_600_000), async (req, res) => {
  const row = getJobRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  let open = true, reason = 'Posting is live';
  try {
    const page = await safeGet(row.apply_url || row.url, { maxBytes: 600_000, timeoutMs: 12000 });
    const text = page.text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ');
    if (CLOSED_RE.test(text.slice(0, 20000)) && text.length < 20000) { open = false; reason = 'The page says this role is closed'; }
  } catch (e) {
    if (e.status === 404 || e.status === 410) { open = false; reason = `Page returned ${e.status}`; }
    else reason = 'Could not verify (site blocked or slow) — assuming still open';
  }
  if (!open) db.prepare('UPDATE jobs SET active=0 WHERE id=?').run(row.id);
  res.json({ open, reason });
});

r.post('/:id/hide', (req, res) => {
  const s = stateOf(req.user);
  s.hidden = [...new Set([...(s.hidden || []), req.params.id])].slice(-5000);
  store.putSingleton(req.user, 'state', s);
  res.json({ ok: true });
});
r.post('/:id/unhide', (req, res) => {
  const s = stateOf(req.user);
  s.hidden = (s.hidden || []).filter((x) => x !== req.params.id);
  store.putSingleton(req.user, 'state', s);
  res.json({ ok: true });
});

/* ───────── scraping controls ───────── */
let lastGlobalKick = 0;
r.post('/refresh', limit('refresh', 6, 3_600_000), async (req, res) => {
  const s = stateOf(req.user);
  const mine = (s.sources || []).map((x) => ({ kind: x.kind, arg: x.arg }));
  if (isScraping()) return res.status(202).json({ started: false, message: 'A refresh is already running' });
  const fullAllowed = Date.now() - lastGlobalKick > 30 * 60_000;
  if (fullAllowed) lastGlobalKick = Date.now();
  const tasks = fullAllowed ? [...defaultTasks(), ...mine] : mine;
  if (!tasks.length) return res.status(429).json({ error: 'Jobs were refreshed moments ago — try again in a few minutes.' });
  scrapeAll(tasks).catch(() => {});
  res.status(202).json({ started: true, sources: tasks.length, full: fullAllowed });
});

r.get('/sources/mine', (req, res) => {
  const s = stateOf(req.user);
  const h = new Map(db.prepare('SELECT * FROM source_health').all().map((x) => [x.source, x]));
  res.json({
    sources: (s.sources || []).map((x) => ({ ...x, health: h.get(x.kind === 'page' ? `page:${new URL(x.arg).hostname}` : `${x.kind}:${x.arg}`) || null })),
    curated: { greenhouse: COMPANIES.greenhouse.length, lever: COMPANIES.lever.length, ashby: COMPANIES.ashby.length },
  });
});

// Paste any company careers URL (or board slug) → we detect the ATS, test-scrape it, then follow it.
r.post('/sources', limit('addsrc', 20, 3_600_000), async (req, res) => {
  const input = String(req.body?.url || '').trim().slice(0, 400);
  if (!input) return res.status(400).json({ error: 'Paste a careers page URL' });
  let src;
  try { src = detectSource(input); if (!src) throw new Error('Enter a valid http(s) link'); if (src.kind === 'page') assertPublicUrl(src.arg); } catch (e) { return res.status(400).json({ error: e.message }); }
  const result = await scrapeSource(src);
  if (result.error) return res.status(422).json({ error: `Couldn't read jobs from that page: ${result.error}` });
  if (!result.found) return res.status(422).json({ error: 'No job postings found there. Try the direct link to the company\'s job board.' });
  const s = stateOf(req.user);
  if (!(s.sources || []).some((x) => x.kind === src.kind && x.arg === src.arg)) s.sources = [...(s.sources || []), { ...src, label: String(req.body?.label || '').slice(0, 60) || src.arg, addedAt: Date.now() }].slice(-60);
  store.putSingleton(req.user, 'state', s);
  res.status(201).json({ source: src, found: result.found, added: result.added });
});

r.delete('/sources/:index', (req, res) => {
  const s = stateOf(req.user);
  s.sources = (s.sources || []).filter((_, i) => i !== +req.params.index);
  store.putSingleton(req.user, 'state', s);
  res.json({ ok: true });
});

export default r;
