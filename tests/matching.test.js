import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareProfile, scoreJob, hardReject } from '../src/matching.js';
import { cleanApp, addEvent, decorate, filterAndSort, computeStats, toCsv } from '../src/applications.js';

const job = (o = {}) => ({ title: 'Senior Backend Engineer', company: 'Acme', location: 'Berlin', country: 'DE', remote: 2, skills: ['python', 'postgres', 'aws'], seniority: 'senior', posted_at: Date.now() - 86400000, salary_max: 140000, ...o });
const profile = prepareProfile({ skills: ['Python', 'Postgres', 'AWS'], targetRoles: ['Backend Engineer'], seniority: 'senior', workMode: 'remote', minSalary: 120000 });

test('good match scores high with reasons; poor match scores low', () => {
  const good = scoreJob(job(), profile);
  assert.ok(good.score >= 80, `score ${good.score}`);
  assert.ok(good.reasons.some((r) => /skill/.test(r)));
  const bad = scoreJob(job({ title: 'Sales Development Rep', skills: ['salesforce'], seniority: 'junior', salary_max: 50000 }), profile);
  assert.ok(bad.score < good.score - 35, `bad ${bad.score} vs ${good.score}`);
  assert.ok(bad.warnings.length > 0);
});
test('related roles are partially credited', () => {
  const p = prepareProfile({ targetRoles: ['Software Engineer'] });
  const a = scoreJob(job({ title: 'Platform Engineer' }), p).score, b = scoreJob(job({ title: 'Account Executive' }), p).score;
  assert.ok(a > b);
});
test('hard filters', () => {
  assert.equal(hardReject(job({ remote: 0 }), profile), 'not remote');
  assert.equal(hardReject(job({ title: 'PHP Developer' }), prepareProfile({ excludeKeywords: ['php'] })), 'excluded keyword');
  assert.equal(hardReject(job(), prepareProfile({ blockedCompanies: ['acme'] })), 'blocked company');
  assert.equal(hardReject(job(), profile), null);
});
test('semantic similarity lifts score', () => {
  const base = scoreJob(job({ skills: [] }), prepareProfile({ skills: ['python'] })).score;
  assert.ok(scoreJob(job({ skills: [] }), prepareProfile({ skills: ['python'] }), { semantic: 0.7 }).score > base);
});

/* ── tracker ── */
const DAY = 86400000;
test('status changes append events and set dates', () => {
  const now = Date.now();
  let a = cleanApp({ title: 'Dev', company: 'Acme' }, null, now);
  assert.equal(a.status, 'saved');
  a = cleanApp({ status: 'applied' }, a, now + 1000);
  assert.equal(a.events.length, 1); assert.equal(a.events[0].to, 'applied'); assert.equal(a.appliedAt, now + 1000); assert.ok(a.followUpAt > now);
  a = cleanApp({ status: 'applied' }, a); assert.equal(a.events.length, 1, 'no-op status change adds no event');
  assert.throws(() => cleanApp({ title: '' }, a), /title/i);
});
test('derived flags: stale / follow-up due / interview soon', () => {
  const now = Date.now();
  const stale = decorate({ status: 'applied', lastActivityAt: now - 25 * DAY, priority: 2 }, now);
  assert.ok(stale.stale); assert.equal(stale.idleDays, 25);
  assert.ok(decorate({ status: 'applied', followUpAt: now - 1, lastActivityAt: now, priority: 2 }, now).followUpDue);
  assert.ok(!decorate({ status: 'rejected', followUpAt: now - 1, lastActivityAt: now - 40 * DAY, priority: 2 }, now).stale);
  assert.ok(decorate({ status: 'interview', interviewAt: now + 2 * DAY, lastActivityAt: now, priority: 2 }, now).interviewSoon);
});
test('filter, sort and "needs attention" ordering', () => {
  const now = Date.now();
  const mk = (o) => ({ id: o.company, title: 'T', priority: 2, tags: [], events: [], notes: '', lastActivityAt: now, ...o });
  const apps = [mk({ company: 'A', status: 'saved' }), mk({ company: 'B', status: 'applied', lastActivityAt: now - 30 * DAY }), mk({ company: 'C', status: 'interview', interviewAt: now + DAY }), mk({ company: 'D', status: 'rejected' })];
  assert.deepEqual(filterAndSort(apps, { sort: 'attention' }, now).map((a) => a.company), ['C', 'B', 'A', 'D']);
  assert.deepEqual(filterAndSort(apps, { status: 'applied,saved', sort: 'company' }, now).map((a) => a.company), ['A', 'B']);
  assert.deepEqual(filterAndSort(apps, { due: true }, now).map((a) => a.company).sort(), ['B', 'C']);
  assert.equal(filterAndSort(apps, { hideClosed: true }, now).length, 3);
  assert.equal(filterAndSort(apps, { q: 'c' }, now)[0].company, 'C');
});
test('stats: funnel & response metrics', () => {
  const now = Date.now();
  let a = cleanApp({ title: 'x', company: 'A', status: 'applied', appliedAt: now - 10 * DAY }, null, now - 10 * DAY);
  a = cleanApp({ status: 'interview' }, a, now - 5 * DAY);
  const b = cleanApp({ title: 'y', company: 'B', status: 'applied' }, null, now - 3 * DAY);
  const c = cleanApp({ title: 'z', company: 'C', status: 'saved' }, null, now);
  const s = computeStats([a, b, c], now);
  assert.equal(s.applied, 2); assert.equal(s.interviewed, 1); assert.equal(s.responseRate, 50); assert.equal(s.avgDaysToResponse, 5); assert.equal(s.count.saved, 1);
  assert.equal(s.weekly.reduce((n, w) => n + w.applied, 0), 2);
});
test('events and CSV (formula-injection safe)', () => {
  let a = cleanApp({ title: '=HYPERLINK("x")', company: 'A, Inc' });
  a = addEvent(a, { type: 'call', note: 'Recruiter screen' });
  assert.equal(a.events[0].type, 'call');
  const csv = toCsv([a]);
  assert.ok(csv.includes('"\'=HYPERLINK(""x"")"') && csv.includes('"A, Inc"'));
});
