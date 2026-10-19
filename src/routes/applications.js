import { Router } from 'express';
import * as store from '../store.js';
import { requireAuth } from '../middleware.js';
import { getJobRow, presentJob } from '../jobs.js';
import { cleanApp, addEvent, filterAndSort, computeStats, decorate, toCsv, STATUSES } from '../applications.js';
import { prepareProfile, scoreJob } from '../matching.js';

const r = Router();
r.use(requireAuth);
const load = (user) => store.list(user, 'application');
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function snapshotOf(jobId, profile) {
  const row = getJobRow(jobId);
  if (!row) return null;
  const j = presentJob(row);
  const match = scoreJob({ ...row, skills: j.skills }, prepareProfile(profile || {}));
  return { title: j.title, company: j.company, url: j.applyUrl, location: j.location, matchScore: match.score,
    snapshot: { description: (row.description || '').slice(0, 8000), skills: j.skills, salary: j.salary, seniority: j.seniority, remote: j.remote, postedAt: j.postedAt } };
}

r.get('/', (req, res) => {
  const { status, q, tag, priority, sort, due, hideClosed } = req.query;
  const all = load(req.user);
  const list = filterAndSort(all, { status, q, tag, priority, sort, due: due === '1', hideClosed: hideClosed === '1' });
  // list payload omits heavy snapshot descriptions
  res.json({ applications: list.map(({ snapshot, ...a }) => ({ ...a, hasSnapshot: !!snapshot })), statuses: STATUSES, tags: [...new Set(all.flatMap((a) => a.tags || []))].sort() });
});

r.get('/stats', (req, res) => res.json(computeStats(load(req.user))));

r.get('/export.csv', (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="sherpa-applications.csv"' });
  res.send(toCsv(filterAndSort(load(req.user), { sort: 'applied' })));
});

r.get('/:id', (req, res) => {
  const a = store.get(req.user, 'application', req.params.id);
  if (!a) return res.status(404).json({ error: 'Not found' });
  res.json({ application: decorate(a) });
});

r.post('/', (req, res) => {
  const body = { ...(req.body || {}) };
  delete body.snapshot; // only the server may attach a job snapshot
  const profile = store.getSingleton(req.user, 'profile');
  const existing = load(req.user);
  if (body.jobId) {
    const dup = existing.find((a) => a.jobId === body.jobId);
    if (dup) return res.status(200).json({ application: decorate(dup), existing: true });
    const snap = snapshotOf(body.jobId, profile);
    if (!snap) return res.status(404).json({ error: 'That job is no longer in the pool — add it manually.' });
    Object.assign(body, { ...snap, ...body, title: body.title || snap.title, company: body.company || snap.company });
  } else {
    const dup = existing.find((a) => norm(a.company) === norm(body.company) && norm(a.title) === norm(body.title) && a.status !== 'rejected');
    if (dup && !body.force) return res.status(409).json({ error: 'You already track this role', application: decorate(dup) });
  }
  const app = cleanApp({ status: 'saved', ...body });
  if (app.status === 'applied' && !body.appliedAt) app.appliedAt = Date.now();
  res.status(201).json({ application: decorate(store.put(req.user, 'application', app)) });
});

r.patch('/:id', (req, res) => {
  const prev = store.get(req.user, 'application', req.params.id);
  if (!prev) return res.status(404).json({ error: 'Not found' });
  res.json({ application: decorate(store.put(req.user, 'application', cleanApp(req.body || {}, prev), prev.id)) });
});

r.post('/:id/events', (req, res) => {
  const prev = store.get(req.user, 'application', req.params.id);
  if (!prev) return res.status(404).json({ error: 'Not found' });
  if (!String(req.body?.note || '').trim() && req.body?.type !== 'followup') return res.status(400).json({ error: 'Add a note' });
  const a = addEvent(prev, req.body || {});
  if (req.body?.type === 'followup') a.followUpAt = null; // logged a follow-up → clear the nudge
  if (req.body?.nextFollowUp) a.followUpAt = Date.parse(req.body.nextFollowUp) || a.followUpAt;
  res.json({ application: decorate(store.put(req.user, 'application', a, prev.id)) });
});

r.delete('/:id/events/:eid', (req, res) => {
  const prev = store.get(req.user, 'application', req.params.id);
  if (!prev) return res.status(404).json({ error: 'Not found' });
  prev.events = (prev.events || []).filter((e) => e.id !== req.params.eid || e.type === 'status');
  res.json({ application: decorate(store.put(req.user, 'application', prev, prev.id)) });
});

r.post('/bulk', (req, res) => {
  const { ids = [], status, action } = req.body || {};
  let n = 0;
  for (const id of ids.slice(0, 200)) {
    const prev = store.get(req.user, 'application', id);
    if (!prev) continue;
    if (action === 'delete') { store.remove(req.user, 'application', id); n++; continue; }
    if (STATUSES.includes(status)) { store.put(req.user, 'application', cleanApp({ status }, prev), id); n++; }
  }
  res.json({ updated: n });
});

r.delete('/:id', (req, res) => res.json({ ok: store.remove(req.user, 'application', req.params.id) }));

export default r;
