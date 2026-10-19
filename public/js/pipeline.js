import { h, api, qs, clear, toast, fail, busy, modal, ago, STATUS_LABEL, STATUS_TONE, field, dateInput, fromDateInput, debounce, cap } from './util.js';
import { aiTool } from './aitools.js';

const BOARD = ['saved', 'applied', 'screening', 'interview', 'offer'];
const CLOSED = ['accepted', 'rejected', 'withdrawn'];
const ui = { view: 'board', sort: 'recent', q: '', status: '', tag: '', hideClosed: false, due: false };

export async function pipelineView(root) {
  let apps = [], stats = null, tags = [];
  const content = h('div'), top = h('div'), strip = h('div');
  const search = h('input', { type: 'search', placeholder: 'Search company, title, notes…', value: ui.q, oninput: debounce((e) => { ui.q = e.target.value; load(); }, 250) });
  const sort = h('select', { onchange: (e) => { ui.sort = e.target.value; load(); } },
    [['recent', 'Recent activity'], ['attention', 'Needs attention'], ['applied', 'Date applied'], ['followup', 'Follow-up date'], ['priority', 'Priority'], ['match', 'Match score'], ['company', 'Company A–Z'], ['status', 'Stage']].map(([v, l]) => h('option', { value: v, selected: v === ui.sort }, l)));
  const tagSel = h('select', { onchange: (e) => { ui.tag = e.target.value; load(); } });
  const viewBtns = ['board', 'list'].map((v) => h('button', { class: `chip${ui.view === v ? ' on' : ''}`, onclick: () => { ui.view = v; viewBtns.forEach((b, i) => b.classList.toggle('on', ['board', 'list'][i] === v)); render(); } }, cap(v)));
  const dueChip = h('button', { class: `chip${ui.due ? ' on' : ''}`, onclick: (e) => { ui.due = !ui.due; e.target.classList.toggle('on', ui.due); load(); } }, '⏰ Needs action');
  const closedChip = h('button', { class: `chip${ui.hideClosed ? ' on' : ''}`, onclick: (e) => { ui.hideClosed = !ui.hideClosed; e.target.classList.toggle('on', ui.hideClosed); load(); } }, 'Hide closed');

  root.append(
    h('div', { class: 'topbar' }, h('h1', 'Pipeline'), h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => importModal(load) }, '📨 Paste email/posting'), h('button', { class: 'btn', onclick: () => window.open('/api/applications/export.csv') }, '⬇ CSV'),
      h('button', { class: 'btn primary', onclick: () => editModal(null, load) }, '+ Add application')),
    top, strip,
    h('div', { class: 'filters' }, h('div', { style: { flex: '1 1 220px' } }, search), sort, tagSel, dueChip, closedChip, h('div', { class: 'row', style: { marginLeft: 'auto', gap: '.3rem' } }, viewBtns)),
    content);

  async function load() {
    const [a, s] = await Promise.all([api(`/applications?${qs({ q: ui.q, sort: ui.sort, tag: ui.tag, due: ui.due ? '1' : '', hideClosed: ui.hideClosed ? '1' : '' })}`), api('/applications/stats')]).catch((e) => { fail(e); return []; });
    if (!a) return;
    apps = a.applications; tags = a.tags; stats = s;
    clear(tagSel).append(h('option', { value: '' }, 'All tags'), tags.map((t) => h('option', { value: t, selected: t === ui.tag }, t)));
    renderTop(); render();
  }

  function renderTop() {
    clear(top);
    if (!stats.total) return;
    const stat = (n, label, tone) => h('div', { class: 'card stat' }, h('b', { class: tone ? `badge ${tone}` : '', style: tone ? { fontSize: '1.4rem' } : null }, n ?? '–'), h('span', label));
    top.append(h('div', { class: 'stats' },
      stat(stats.active, 'Active'), stat(stats.applied, 'Applied'), stat(stats.responseRate != null ? `${stats.responseRate}%` : '–', 'Response rate'),
      stat(stats.interviewed, 'Interviews'), stat(stats.offers, 'Offers'), stat(stats.avgDaysToResponse != null ? `${stats.avgDaysToResponse}d` : '–', 'Avg. time to reply')));
    clear(strip);
    const chips = [];
    if (stats.interviewsSoon) chips.push(h('span', { class: 'badge warn' }, `🎤 ${stats.interviewsSoon} interview${stats.interviewsSoon > 1 ? 's' : ''} this week`));
    if (stats.dueFollowUps) chips.push(h('span', { class: 'badge info' }, `⏰ ${stats.dueFollowUps} follow-up${stats.dueFollowUps > 1 ? 's' : ''} due`));
    if (stats.stale) chips.push(h('span', { class: 'badge bad' }, `👻 ${stats.stale} with no reply in 3+ weeks`));
    if (chips.length) strip.append(h('div', { class: 'attn' }, chips));
  }

  function render() {
    clear(content);
    if (!apps.length) {
      content.append(h('div', { class: 'card empty' }, stats?.total ? 'Nothing matches those filters.' : ['Your pipeline is empty.', h('br'), 'Save jobs from Discover, or add an application you already sent.']));
      return;
    }
    content.append(ui.view === 'board' ? board() : table());
    if (stats.total > 2) content.append(insights());
  }

  function board() {
    const cols = ui.hideClosed ? BOARD : [...BOARD, ...CLOSED];
    const el = h('div', { class: 'board' });
    for (const st of cols) {
      const items = apps.filter((a) => a.status === st);
      const col = h('div', { class: 'col', 'data-st': st,
        ondragover: (e) => { e.preventDefault(); col.classList.add('over'); }, ondragleave: () => col.classList.remove('over'),
        ondrop: async (e) => { e.preventDefault(); col.classList.remove('over'); const id = e.dataTransfer.getData('text/plain'); const a = apps.find((x) => x.id === id); if (a && a.status !== st) { await move(a, st); } } },
      h('h3', STATUS_LABEL[st], h('span', items.length)), items.map(card));
      el.append(col);
    }
    return el;
  }
  async function move(a, st) {
    try {
      const patch = { status: st };
      await api(`/applications/${a.id}`, { method: 'PATCH', body: patch });
      toast(`${a.company} → ${STATUS_LABEL[st]}`); load();
      if (st === 'interview' && !a.interviewAt) editModal(a, load, 'Set the interview date');
    } catch (e) { fail(e); }
  }
  function card(a) {
    return h('div', { class: `acard pri${a.priority}`, draggable: 'true', tabindex: 0, ondragstart: (e) => e.dataTransfer.setData('text/plain', a.id), onclick: () => detailModal(a.id, load), onkeydown: (e) => e.key === 'Enter' && detailModal(a.id, load) },
      h('h4', a.title), h('div', { class: 'small muted' }, a.company),
      h('div', { class: 'meta' },
        a.matchScore != null && h('span', { class: 'badge accent' }, `${a.matchScore}%`),
        a.interviewSoon && h('span', { class: 'badge warn' }, `🎤 ${new Date(a.interviewAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`),
        a.followUpDue && h('span', { class: 'badge info' }, '⏰ follow up'), a.stale && h('span', { class: 'badge bad' }, `👻 ${a.idleDays}d quiet`),
        a.appliedAt && !a.stale && h('span', { class: 'tiny muted' }, `applied ${ago(a.appliedAt)}`), (a.tags || []).slice(0, 2).map((t) => h('span', { class: 'tag' }, t))));
  }
  function table() {
    const th = (label, key) => h('th', { onclick: () => { ui.sort = key; sort.value = key; load(); } }, label);
    return h('div', { class: 'card', style: { overflowX: 'auto', padding: 0 } }, h('table',
      h('thead', h('tr', th('Company', 'company'), h('th', 'Role'), th('Stage', 'status'), th('Applied', 'applied'), h('th', 'Last activity'), th('Follow-up', 'followup'), th('Match', 'match'), th('Priority', 'priority'))),
      h('tbody', apps.map((a) => h('tr', { class: 'click', onclick: () => detailModal(a.id, load) },
        h('td', h('b', a.company)), h('td', a.title), h('td', h('span', { class: `badge ${STATUS_TONE[a.status]}` }, STATUS_LABEL[a.status]), a.stale && ' 👻'),
        h('td', a.appliedAt ? ago(a.appliedAt) : '—'), h('td', ago(a.lastActivityAt)), h('td', a.followUpAt ? h('span', { class: a.followUpDue ? 'badge info' : '' }, new Date(a.followUpAt).toLocaleDateString()) : '—'),
        h('td', a.matchScore != null ? `${a.matchScore}%` : '—'), h('td', ['', '🔴 High', 'Normal', 'Low'][a.priority]))))));
  }
  function insights() {
    const funnel = [['Applied', stats.applied], ['Heard back', stats.responded], ['Interviewed', stats.interviewed], ['Offers', stats.offers]];
    const max = Math.max(1, stats.applied);
    const wmax = Math.max(1, ...stats.weekly.map((w) => w.applied));
    return h('div', { class: 'grid2', style: { marginTop: '1rem' } },
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '.7rem' } }, 'Funnel'), h('div', { class: 'funnel' }, funnel.map(([l, n]) => h('div', { class: 'row' }, h('span', { class: 'small muted', style: { width: '85px' } }, l), h('div', { class: 'bar', style: { width: `${Math.max(8, (n / max) * 100)}%` } }, n))))),
      h('div', { class: 'card' }, h('h3', { style: { marginBottom: '.7rem' } }, 'Applications per week (12 wks)'), h('div', { class: 'weekly' }, stats.weekly.map((w) => h('i', { style: { height: `${Math.max(3, (w.applied / wmax) * 100)}%` }, title: `${new Date(w.weekStart).toLocaleDateString()}: ${w.applied}` })))));
  }
  load();
}

/* ───────── add / edit ───────── */
export function editModal(a, done, hint) {
  const v = a || { status: 'saved', priority: 2, tags: [], contacts: [] };
  const inp = (k, attrs = {}) => h('input', { value: v[k] ?? '', ...attrs });
  const title = inp('title', { required: true }), company = inp('company', { required: true }), url = inp('url', { type: 'url', placeholder: 'https://…' }), loc = inp('location');
  const status = h('select', ['saved', 'applied', 'screening', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn'].map((s) => h('option', { value: s, selected: s === v.status }, STATUS_LABEL[s])));
  const prio = h('select', [[1, 'High'], [2, 'Normal'], [3, 'Low']].map(([n, l]) => h('option', { value: n, selected: n === v.priority }, l)));
  const applied = h('input', { type: 'date', value: dateInput(v.appliedAt) }), follow = h('input', { type: 'date', value: dateInput(v.followUpAt) }), interview = h('input', { type: 'date', value: dateInput(v.interviewAt) });
  const tags = h('input', { value: (v.tags || []).join(', '), placeholder: 'dream-job, referral' });
  const notes = h('textarea', { rows: 4 }, v.notes || '');
  const contacts = h('textarea', { rows: 2, placeholder: 'One per line: Name, role, email' }, (v.contacts || []).map((c) => [c.name, c.role, c.email].filter(Boolean).join(', ')).join('\n'));
  modal(a?.id ? 'Edit application' : hint || 'Add application', (b, m) => {
    b.append(h('div', { class: 'stack' },
      h('div', { class: 'grid2' }, field('Job title *', title), field('Company *', company)),
      h('div', { class: 'grid2' }, field('Posting URL', url), field('Location', loc)),
      h('div', { class: 'grid3' }, field('Stage', status), field('Priority', prio), field('Applied on', applied)),
      h('div', { class: 'grid2' }, field('Follow up on', follow), field('Interview date', interview)),
      field('Tags (comma separated)', tags), field('Notes', notes), field('Contacts', contacts)));
  }, { footer: (m) => {
    const save = h('button', { class: 'btn primary' }, 'Save');
    save.onclick = busy(save, async () => {
      const body = {
        title: title.value, company: company.value, url: url.value, location: loc.value, status: status.value, priority: +prio.value, appliedAt: fromDateInput(applied.value), followUpAt: fromDateInput(follow.value), interviewAt: fromDateInput(interview.value),
        tags: tags.value.split(',').map((s) => s.trim()).filter(Boolean), notes: notes.value,
        contacts: contacts.value.split('\n').map((l) => { const [name, role, email] = l.split(',').map((s) => s.trim()); return { name, role: email ? role : '', email: email || (role && role.includes('@') ? role : '') }; }).filter((c) => c.name),
      };
      if (a?.id) await api(`/applications/${a.id}`, { method: 'PATCH', body }); else await api('/applications', { method: 'POST', body: { ...body, force: true } });
      m.close(); toast('Saved'); done();
    });
    return [h('button', { class: 'btn', onclick: m.close }, 'Cancel'), save];
  } });
}

/* ───────── detail ───────── */
function detailModal(id, done) {
  modal('Application', async (b, m) => {
    const render = async () => {
      const { application: a } = await api(`/applications/${id}`);
      clear(b);
      const stage = h('select', { onchange: async (e) => { await api(`/applications/${id}`, { method: 'PATCH', body: { status: e.target.value } }); toast('Stage updated'); render(); done(); } },
        ['saved', 'applied', 'screening', 'interview', 'offer', 'accepted', 'rejected', 'withdrawn'].map((s) => h('option', { value: s, selected: s === a.status }, STATUS_LABEL[s])));
      const note = h('input', { placeholder: 'Log a note, call, email…' });
      const kind = h('select', ['note', 'email', 'call', 'interview', 'followup', 'assessment'].map((k) => h('option', { value: k }, cap(k))));
      const addEv = h('button', { class: 'btn sm primary' }, 'Log');
      addEv.onclick = busy(addEv, async () => { await api(`/applications/${id}/events`, { method: 'POST', body: { type: kind.value, note: note.value } }); render(); done(); });
      const tool = (label, fn) => { const x = h('button', { class: 'btn sm' }, label); x.onclick = busy(x, () => fn({ id: a.jobId, applicationId: a.id, title: a.title })); return x; };
      b.append(
        h('div', { class: 'row' }, h('div', { class: 'grow' }, h('h2', a.title), h('div', { class: 'muted' }, `${a.company}${a.location ? ' · ' + a.location : ''}`)), stage),
        h('div', { class: 'row', style: { margin: '.7rem 0' } },
          a.url && h('a', { class: 'btn sm', href: a.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open posting ↗'),
          a.matchScore != null && h('span', { class: 'badge accent' }, `${a.matchScore}% match`), a.stale && h('span', { class: 'badge bad' }, `👻 No reply in ${a.idleDays} days`), a.followUpDue && h('span', { class: 'badge info' }, '⏰ Follow-up due'),
          a.appliedAt && h('span', { class: 'tiny muted' }, `Applied ${new Date(a.appliedAt).toLocaleDateString()}`), a.followUpAt && h('span', { class: 'tiny muted' }, `· follow up ${new Date(a.followUpAt).toLocaleDateString()}`),
          a.interviewAt && h('span', { class: 'tiny muted' }, `· interview ${new Date(a.interviewAt).toLocaleDateString()}`)),
        h('div', { class: 'row', style: { marginBottom: '.8rem' } }, tool('✉️ Cover letter', aiTool.cover), tool('📝 Tailor resume', aiTool.tailor), tool('🎤 Interview prep', aiTool.prep), tool('📧 Follow-up email', aiTool.followUp), tool('🎯 Fit', aiTool.fit)),
        a.notes && h('div', { class: 'card', style: { boxShadow: 'none', marginBottom: '.8rem', whiteSpace: 'pre-wrap' } }, a.notes),
        a.contacts?.length ? h('div', { style: { marginBottom: '.8rem' } }, h('h3', 'Contacts'), a.contacts.map((c) => h('div', { class: 'small' }, `${c.name}${c.role ? ` — ${c.role}` : ''} `, c.email && h('a', { href: `mailto:${c.email}` }, c.email)))) : null,
        (a.tags || []).length ? h('div', { class: 'row', style: { marginBottom: '.8rem', gap: '.3rem' } }, a.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
        h('h3', { style: { marginBottom: '.5rem' } }, 'Timeline'),
        h('div', { class: 'row', style: { marginBottom: '.7rem' } }, kind, h('div', { class: 'grow' }, note), addEv),
        h('div', { class: 'timeline' }, [{ id: 'c', type: 'created', at: a.createdAt, note: 'Added to pipeline' }, ...(a.events || [])].reverse().map((e) => h('div', { class: 'ev' },
          h('b', e.type === 'status' ? `${STATUS_LABEL[e.from]} → ${STATUS_LABEL[e.to]}` : cap(e.type)), ' ', h('span', { class: 'tiny muted' }, new Date(e.at).toLocaleString()), e.note && h('div', { class: 'small' }, e.note)))));
      m.setFooter([h('button', { class: 'btn danger', onclick: async () => { if (confirm('Delete this application?')) { await api(`/applications/${id}`, { method: 'DELETE' }); m.close(); done(); } } }, 'Delete'),
        h('div', { class: 'grow' }), h('button', { class: 'btn', onclick: () => { m.close(); editModal(a, done); } }, 'Edit'), h('button', { class: 'btn primary', onclick: m.close }, 'Done')]);
    };
    await render();
  }, { wide: true });
}

/* ───────── paste email / posting ───────── */
function importModal(done) {
  modal('Paste an email or job posting', (b, m) => {
    const t = h('textarea', { rows: 10, placeholder: 'Paste a confirmation email, recruiter message, rejection or job description…' });
    const go = h('button', { class: 'btn primary' }, 'Extract with AI');
    go.onclick = busy(go, async () => {
      const { application: p } = await api('/ai/parse-application', { method: 'POST', body: { text: t.value } });
      m.close();
      editModal({ ...p, status: p.status || 'applied', interviewAt: p.interviewAt ? Date.parse(p.interviewAt) : null, notes: p.note || '', tags: [], contacts: [] }, done, 'Review & save');
    });
    b.append(h('div', { class: 'stack' }, t, go));
  });
}
