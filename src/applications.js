// Application tracker domain logic (pure functions over decrypted records).
import { newId } from './store.js';

export const STATUSES = ['saved', 'applied', 'screening', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn'];
export const ACTIVE = new Set(['saved', 'applied', 'screening', 'interview', 'offer']);
const RESPONDED = new Set(['screening', 'interview', 'offer', 'accepted']); // got past the resume black hole
const ORDER = Object.fromEntries(STATUSES.map((s, i) => [s, i]));
export const STALE_DAYS = 21;
const DAY = 86_400_000;

const str = (v, n) => String(v ?? '').trim().slice(0, n);
const ts = (v) => { if (v === null || v === '' || v === undefined) return null; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isNaN(t) ? null : t; };

export function cleanApp(b, prev = null, now = Date.now()) {
  const a = prev ? { ...prev } : { status: 'saved', priority: 2, tags: [], contacts: [], events: [], notes: '' };
  const set = (k, v) => { a[k] = v; };
  if ('title' in b) set('title', str(b.title, 200));
  if ('company' in b) set('company', str(b.company, 120));
  if ('url' in b) set('url', str(b.url, 600));
  if ('location' in b) set('location', str(b.location, 160));
  if ('jobId' in b) set('jobId', b.jobId ? str(b.jobId, 40) : null);
  if ('notes' in b) set('notes', str(b.notes, 10000));
  if ('priority' in b) set('priority', [1, 2, 3].includes(+b.priority) ? +b.priority : 2);
  if ('tags' in b) set('tags', (Array.isArray(b.tags) ? b.tags : []).map((t) => str(t, 30)).filter(Boolean).slice(0, 12));
  if ('contacts' in b) set('contacts', (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 12).map((c) => ({ name: str(c.name, 80), role: str(c.role, 80), email: str(c.email, 120), linkedin: str(c.linkedin, 200) })).filter((c) => c.name || c.email));
  if ('followUpAt' in b) set('followUpAt', ts(b.followUpAt));
  if ('interviewAt' in b) set('interviewAt', ts(b.interviewAt));
  if ('appliedAt' in b) set('appliedAt', ts(b.appliedAt));
  if ('salary' in b) set('salary', b.salary && (+b.salary.min || +b.salary.max) ? { min: +b.salary.min || 0, max: +b.salary.max || 0, currency: str(b.salary.currency || 'USD', 4) } : null);
  if ('offer' in b) set('offer', b.offer && typeof b.offer === 'object' ? { base: +b.offer.base || null, bonus: +b.offer.bonus || null, equity: str(b.offer.equity, 80), deadline: ts(b.offer.deadline) } : null);
  if ('snapshot' in b && b.snapshot) set('snapshot', b.snapshot);
  if ('matchScore' in b) set('matchScore', Number.isFinite(+b.matchScore) ? +b.matchScore : null);
  if ('resumeDocId' in b) set('resumeDocId', b.resumeDocId || null);
  if ('coverDocId' in b) set('coverDocId', b.coverDocId || null);

  if ('status' in b && STATUSES.includes(b.status) && b.status !== a.status) {
    a.events = [...(a.events || []), { id: newId(), type: 'status', at: now, from: a.status, to: b.status, note: str(b.statusNote, 500) }];
    if (b.status === 'applied' && !a.appliedAt) a.appliedAt = now;
    if (['screening', 'interview', 'offer', 'accepted'].includes(b.status) && !a.appliedAt) a.appliedAt = now;
    if (b.status === 'applied' && !a.followUpAt) a.followUpAt = now + 7 * DAY; // default nudge
    a.status = b.status;
    a.lastActivityAt = now;
  }
  if (!a.title) throw Object.assign(new Error('Job title is required'), { status: 400 });
  if (!a.company) throw Object.assign(new Error('Company is required'), { status: 400 });
  a.lastActivityAt ??= now;
  return a;
}

export function addEvent(a, { type = 'note', note = '', at = Date.now() }, now = Date.now()) {
  const allowed = ['note', 'email', 'call', 'interview', 'followup', 'assessment'];
  const e = { id: newId(), type: allowed.includes(type) ? type : 'note', at: ts(at) ?? now, note: str(note, 2000) };
  a.events = [...(a.events || []), e];
  a.lastActivityAt = Math.max(a.lastActivityAt || 0, e.at);
  return a;
}

/** Derived, non-persisted flags the UI uses to organise work. */
export function decorate(a, now = Date.now()) {
  const last = a.lastActivityAt || a.updatedAt || a.createdAt;
  const idleDays = Math.floor((now - last) / DAY);
  const waiting = a.status === 'applied' || a.status === 'screening';
  return {
    ...a,
    idleDays,
    stale: waiting && idleDays >= STALE_DAYS,
    followUpDue: ACTIVE.has(a.status) && a.followUpAt != null && a.followUpAt <= now,
    interviewSoon: a.status === 'interview' && a.interviewAt != null && a.interviewAt >= now - DAY && a.interviewAt <= now + 7 * DAY,
    daysSinceApplied: a.appliedAt ? Math.floor((now - a.appliedAt) / DAY) : null,
  };
}

const SORTS = {
  recent: (a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0),
  applied: (a, b) => (b.appliedAt || 0) - (a.appliedAt || 0),
  company: (a, b) => a.company.localeCompare(b.company),
  title: (a, b) => a.title.localeCompare(b.title),
  status: (a, b) => ORDER[a.status] - ORDER[b.status] || (b.lastActivityAt || 0) - (a.lastActivityAt || 0),
  priority: (a, b) => a.priority - b.priority || (b.lastActivityAt || 0) - (a.lastActivityAt || 0),
  match: (a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1),
  followup: (a, b) => (a.followUpAt ?? Infinity) - (b.followUpAt ?? Infinity),
  // "What should I do next?": due follow-ups, soon interviews, then oldest waiting
  attention: (a, b) => attention(b) - attention(a),
};
function attention(a) {
  let s = 0;
  if (a.interviewSoon) s += 100;
  if (a.status === 'offer') s += 90;
  if (a.followUpDue) s += 60;
  if (a.stale) s += 30;
  if (a.status === 'saved') s += 10 + (4 - a.priority);
  return s + Math.min(a.idleDays || 0, 20) / 20;
}

export function filterAndSort(apps, { status, q, tag, priority, sort = 'recent', due, hideClosed } = {}, now = Date.now()) {
  let list = apps.map((a) => decorate(a, now));
  if (status) { const set = new Set(String(status).split(',')); list = list.filter((a) => set.has(a.status)); }
  if (hideClosed) list = list.filter((a) => ACTIVE.has(a.status));
  if (tag) list = list.filter((a) => a.tags?.includes(tag));
  if (priority) list = list.filter((a) => a.priority === +priority);
  if (due) list = list.filter((a) => a.followUpDue || a.stale || a.interviewSoon);
  if (q) {
    const needle = String(q).toLowerCase();
    list = list.filter((a) => `${a.title} ${a.company} ${a.location} ${a.notes} ${(a.tags || []).join(' ')} ${(a.contacts || []).map((c) => c.name).join(' ')}`.toLowerCase().includes(needle));
  }
  list.sort(SORTS[sort] || SORTS.recent);
  return list;
}

export function computeStats(apps, now = Date.now()) {
  const dec = apps.map((a) => decorate(a, now));
  const count = Object.fromEntries(STATUSES.map((s) => [s, dec.filter((a) => a.status === s).length]));
  const everApplied = dec.filter((a) => a.appliedAt || a.status !== 'saved');
  const reached = (set) => dec.filter((a) => (a.events || []).some((e) => e.type === 'status' && set.has(e.to)) || set.has(a.status));
  const responded = reached(RESPONDED).length;
  const interviewed = reached(new Set(['interview', 'offer', 'accepted'])).length;
  const offers = reached(new Set(['offer', 'accepted'])).length;
  const days = [];
  for (const a of dec) {
    if (!a.appliedAt) continue;
    const first = (a.events || []).find((e) => e.type === 'status' && RESPONDED.has(e.to));
    if (first) days.push((first.at - a.appliedAt) / DAY);
  }
  const weeks = Array.from({ length: 12 }, (_, i) => ({ weekStart: startOfWeek(now - (11 - i) * 7 * DAY), applied: 0 }));
  for (const a of everApplied) {
    if (!a.appliedAt) continue;
    const w = weeks.find((x) => a.appliedAt >= x.weekStart && a.appliedAt < x.weekStart + 7 * DAY);
    if (w) w.applied++;
  }
  const rate = (n, d) => (d ? Math.round((n / d) * 100) : null);
  return {
    total: dec.length, count, active: dec.filter((a) => ACTIVE.has(a.status)).length,
    applied: everApplied.length, responded, interviewed, offers,
    responseRate: rate(responded, everApplied.length), interviewRate: rate(interviewed, everApplied.length), offerRate: rate(offers, interviewed),
    avgDaysToResponse: days.length ? Math.round((days.reduce((a, b) => a + b, 0) / days.length) * 10) / 10 : null,
    dueFollowUps: dec.filter((a) => a.followUpDue).length, stale: dec.filter((a) => a.stale).length, interviewsSoon: dec.filter((a) => a.interviewSoon).length,
    weekly: weeks,
  };
}
function startOfWeek(t) { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return +d; }

export function toCsv(apps) {
  const esc = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; }; // also neutralises spreadsheet formula injection
  const iso = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
  const rows = [['Company', 'Title', 'Status', 'Priority', 'Applied', 'Last activity', 'Follow-up', 'Location', 'URL', 'Tags', 'Notes']];
  for (const a of apps) rows.push([a.company, a.title, a.status, a.priority, iso(a.appliedAt), iso(a.lastActivityAt), iso(a.followUpAt), a.location, a.url, (a.tags || []).join('; '), a.notes]);
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
