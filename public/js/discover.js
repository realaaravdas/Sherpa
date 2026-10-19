import { h, api, qs, clear, toast, fail, busy, modal, ago, salaryText, REMOTE, cap, ring, debounce, STATUS_LABEL, STATUS_TONE } from './util.js';
import { aiTool } from './aitools.js';

const saved = (() => { try { return JSON.parse(sessionStorage.getItem('sherpa.filters') || '{}'); } catch { return {}; } })();

export async function discoverView(root, ctx) {
  const f = { q: '', remote: '', seniority: '', postedWithin: '', minSalary: '', country: '', hideApplied: '1', minMatch: '', sort: 'match', employment: '', ...saved };
  let page = 1, jobs = [], total = 0, selected = null, personalised = false;
  const list = h('div', { class: 'joblist' }), detail = h('div', { class: 'card detail' }, h('div', { class: 'empty' }, 'Select a job to see details'));
  const more = h('button', { class: 'btn', onclick: () => load(true) }, 'Load more');
  const summary = h('div', { class: 'muted small grow' });
  const statsLine = h('div', { class: 'tiny muted' });

  const search = h('input', { type: 'search', placeholder: 'Search roles, skills, companies…  e.g. “senior python”', value: f.q, oninput: debounce((e) => { f.q = e.target.value; load(); }, 350) });
  const sel = (key, opts) => h('select', { onchange: (e) => { f[key] = e.target.value; load(); } }, opts.map(([v, l]) => h('option', { value: v, selected: String(f[key]) === v }, l)));
  const aiBtn = h('button', { class: 'btn', title: 'Describe what you want in plain English' }, '✨ Ask AI');
  aiBtn.onclick = () => modal('Describe your ideal job', (b, m) => {
    const t = h('textarea', { placeholder: 'e.g. Remote senior backend roles in Go or Rust, paying over $170k, posted this week' });
    const go = h('button', { class: 'btn primary' }, 'Find jobs');
    go.onclick = busy(go, async () => {
      const { filters } = await api('/ai/search-intent', { method: 'POST', body: { text: t.value } });
      Object.assign(f, { q: filters.q || '', remote: filters.remote || '', seniority: filters.seniority || '', minSalary: filters.minSalary || '', country: filters.country || '', postedWithin: filters.postedWithin || '' });
      search.value = f.q; m.close(); syncSelects(); load();
    });
    b.append(h('div', { class: 'stack' }, t, go));
  });

  const bar = h('div', { class: 'filters' });
  const syncSelects = () => {
    clear(bar).append(
      sel('remote', [['', 'Any work mode'], ['remote', 'Remote'], ['hybrid', 'Hybrid'], ['onsite', 'On-site']]),
      sel('seniority', [['', 'Any level'], ['intern', 'Intern'], ['junior', 'Junior'], ['mid', 'Mid'], ['senior', 'Senior'], ['lead', 'Lead'], ['staff', 'Staff'], ['principal', 'Principal'], ['director', 'Director']]),
      sel('postedWithin', [['', 'Any time'], ['1', 'Past 24h'], ['3', 'Past 3 days'], ['7', 'Past week'], ['30', 'Past month']]),
      sel('minSalary', [['', 'Any pay'], ['60000', '$60k+'], ['100000', '$100k+'], ['150000', '$150k+'], ['200000', '$200k+']]),
      sel('country', [['', 'Anywhere'], ['US', 'United States'], ['UK', 'United Kingdom'], ['CA', 'Canada'], ['DE', 'Germany'], ['IN', 'India'], ['AU', 'Australia'], ['NL', 'Netherlands'], ['IE', 'Ireland']]),
      sel('minMatch', [['', 'Any match'], ['40', '40%+ match'], ['60', '60%+ match'], ['75', '75%+ match']]),
      sel('sort', [['match', 'Best match'], ['date', 'Newest'], ['salary', 'Highest pay']]),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: f.hideApplied === '1', onchange: (e) => { f.hideApplied = e.target.checked ? '1' : ''; load(); } }), 'Hide tracked'));
  };
  syncSelects();

  root.append(
    h('div', { class: 'topbar' }, h('h1', 'Discover'), h('div', { class: 'grow' }),
      h('button', { class: 'btn', onclick: () => sourcesModal(load) }, '🌐 Sources'), refreshBtn(load, statsLine)),
    h('div', { class: 'row' }, h('div', { class: 'grow' }, search), aiBtn), bar,
    h('div', { class: 'row', style: { marginBottom: '.6rem' } }, summary, statsLine),
    h('div', { class: 'jobs' }, h('div', list, h('div', { style: { textAlign: 'center', margin: '1rem' } }, more)), detail));

  async function load(append = false) {
    page = append ? page + 1 : 1;
    try { sessionStorage.setItem('sherpa.filters', JSON.stringify(f)); } catch { /* private mode */ }
    const sortParam = f.sort === 'match' && f.q ? 'relevance' : f.sort;
    const r = await api(`/jobs?${qs({ ...f, sort: sortParam, page, size: 25 })}`).catch((e) => { fail(e); return null; });
    if (!r) return;
    jobs = append ? [...jobs, ...r.jobs] : r.jobs; total = r.total; personalised = r.personalised;
    if (!append) { selected = null; clear(detail).append(h('div', { class: 'empty' }, 'Select a job to see details')); }
    renderList();
  }
  function renderList() {
    clear(list);
    if (!jobs.length) list.append(h('div', { class: 'card empty' }, 'No jobs match these filters.', h('br'), 'Try widening them, or add more company sources.'));
    jobs.forEach((j) => list.append(jobCard(j)));
    more.classList.toggle('hidden', jobs.length >= total);
    summary.textContent = `${total.toLocaleString()} job${total === 1 ? '' : 's'}${personalised ? ' · ranked for you' : ' · add skills & a resume in Profile to rank by match'}`;
  }
  function jobCard(j) {
    const meta = [j.state && h('span', { class: `badge ${STATUS_TONE[j.state]}` }, STATUS_LABEL[j.state]), h('span', { class: 'tag' }, REMOTE[j.remote] || 'On-site'), j.location && h('span', { class: 'tag' }, j.location.slice(0, 40)),
      j.salary && h('span', { class: 'tag m' }, salaryText(j.salary)), j.seniority && h('span', { class: 'tag' }, cap(j.seniority)), h('span', { class: 'tiny muted' }, ago(j.postedAt || j.firstSeen))];
    const el = h('div', { class: `job${selected === j.id ? ' sel' : ''}`, tabindex: 0, onclick: () => open(j, el), onkeydown: (e) => e.key === 'Enter' && open(j, el) },
      j.match ? ring(j.match.score) : null, h('div', { class: 'grow' }, h('h3', j.title), h('div', { class: 'small muted' }, j.company), h('div', { class: 'meta' }, meta)));
    return el;
  }
  async function open(j, el) {
    selected = j.id; list.querySelectorAll('.job').forEach((x) => x.classList.remove('sel')); el.classList.add('sel');
    clear(detail).append(h('div', { class: 'empty' }, h('span', { class: 'spinner' })));
    try { const { job } = await api(`/jobs/${j.id}`); renderDetail(job, j); } catch (e) { fail(e); }
  }
  function renderDetail(job, listItem) {
    const act = (label, fn, cls = '') => { const b = h('button', { class: `btn sm ${cls}` }, label); b.onclick = busy(b, fn); return b; };
    const track = (status) => async () => {
      const r = await api('/applications', { method: 'POST', body: { jobId: job.id, status } });
      if (r.existing && status !== 'saved') await api(`/applications/${r.application.id}`, { method: 'PATCH', body: { status } });
      toast(r.existing ? `Updated — ${STATUS_LABEL[status]}` : `Added to pipeline as ${STATUS_LABEL[status]}`);
      job.state = status; listItem.state = status; renderDetail(job, listItem); renderList();
    };
    const m = job.match;
    clear(detail).append(
      h('div', { class: 'row' }, m && ring(m.score), h('div', { class: 'grow' }, h('h2', job.title), h('div', { class: 'muted' }, `${job.company}${job.location ? ' · ' + job.location : ''}`))),
      h('div', { class: 'row', style: { margin: '.7rem 0' } },
        job.state ? h('span', { class: `badge ${STATUS_TONE[job.state]}` }, `In pipeline: ${STATUS_LABEL[job.state]}`) : null,
        !job.state && act('☆ Save', track('saved')), job.state !== 'applied' && act('✓ I applied', track('applied'), 'primary'),
        h('a', { class: 'btn sm', href: job.applyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Open posting ↗'),
        act('Still open?', async () => { const r = await api(`/jobs/${job.id}/verify`, { method: 'POST' }); toast(r.reason, !r.open); if (!r.open) { load(); } }),
        act('Hide', async () => { await api(`/jobs/${job.id}/hide`, { method: 'POST' }); toast('Hidden'); load(); })),
      h('div', { class: 'row small', style: { marginBottom: '.6rem' } }, job.salary && h('span', { class: 'badge good' }, salaryText(job.salary)), h('span', { class: 'badge' }, REMOTE[job.remote] || 'On-site'), job.employment && h('span', { class: 'badge' }, job.employment),
        job.department && h('span', { class: 'badge' }, job.department), h('span', { class: 'tiny muted' }, `Posted ${ago(job.postedAt || job.firstSeen)} · via ${[...new Set(job.alsoOn.map((s) => s.source.split(':')[0]))].join(', ')}`)),
      m && (m.reasons.length || m.warnings.length) ? h('div', { class: 'reasons', style: { marginBottom: '.7rem' } }, m.reasons.map((r) => h('div', { class: 'y' }, r)), m.warnings.map((r) => h('div', { class: 'n' }, r))) : null,
      job.skills.length ? h('div', { class: 'row', style: { gap: '.3rem', marginBottom: '.7rem' } }, job.skills.map((s) => h('span', { class: `tag${m?.matched.includes(s) ? ' m' : ''}` }, s))) : null,
      h('div', { class: 'row', style: { marginBottom: '.7rem' } },
        act('🎯 Fit analysis', () => aiTool.fit(job)), act('✉️ Cover letter', () => aiTool.cover(job)), act('📝 Tailor resume', () => aiTool.tailor(job)), act('🎤 Interview prep', () => aiTool.prep(job))),
      h('div', { class: 'desc' }, job.description || 'No description available — open the posting.'));
  }

  load();
  api('/jobs/stats').then((s) => { statsLine.textContent = `${s.activeJobs.toLocaleString()} open jobs · ${s.companies.toLocaleString()} companies${s.addedLast24h ? ` · ${s.addedLast24h.toLocaleString()} new today` : ''}${s.scraping ? ' · refreshing…' : ''}`; }).catch(() => {});
}

function refreshBtn(reload, statsLine) {
  const b = h('button', { class: 'btn' }, '↻ Refresh jobs');
  b.onclick = busy(b, async () => {
    const r = await api('/jobs/refresh', { method: 'POST', body: {} });
    toast(r.started ? `Scraping ${r.sources} sources…` : r.message);
    if (!r.started) return;
    statsLine.textContent = 'Refreshing…';
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      const s = await api('/jobs/stats');
      if (!s.scraping) { statsLine.textContent = `${s.activeJobs.toLocaleString()} open jobs`; toast(`Done — ${s.lastRun?.added ?? 0} new, ${s.lastRun?.expired ?? 0} closed`); reload(); return; }
    }
  });
  return b;
}

function sourcesModal(reload) {
  modal('Job sources', async (body) => {
    const list = h('div', { class: 'stack' });
    const url = h('input', { placeholder: 'Paste a careers page, e.g. https://jobs.lever.co/acme or https://acme.com/careers' });
    const add = h('button', { class: 'btn primary' }, 'Add');
    add.onclick = busy(add, async () => {
      const r = await api('/jobs/sources', { method: 'POST', body: { url: url.value } });
      toast(`Found ${r.found} jobs (${r.added} new)`); url.value = ''; refresh(); reload();
    });
    body.append(
      h('p', { class: 'muted small' }, 'Sherpa already watches ~60 company boards (Greenhouse, Lever, Ashby) and aggregators like Remotive, RemoteOK, Himalayas, We Work Remotely, Arbeitnow, Jobicy and Hacker News “Who is hiring”. Add any other company by pasting its careers link — we detect Greenhouse, Lever, Ashby, Workable, Recruitee & SmartRecruiters automatically, and read structured data from any other page.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, url), add), h('h3', { style: { margin: '1rem 0 .5rem' } }, 'Your sources'), list);
    async function refresh() {
      const { sources, curated } = await api('/jobs/sources/mine');
      clear(list);
      if (!sources.length) list.append(h('div', { class: 'muted small' }, 'None yet. Curated boards: ', Object.entries(curated).map(([k, v]) => `${v} ${k}`).join(', '), '.'));
      sources.forEach((s, i) => list.append(h('div', { class: 'row card', style: { padding: '.6rem .8rem' } },
        h('div', { class: 'grow' }, h('b', s.label), ' ', h('span', { class: 'tag' }, s.kind), h('div', { class: 'tiny muted' }, s.kind === 'page' ? s.arg : '', s.health ? ` ${s.health.last_count} jobs · ${s.health.failures ? 'failing: ' + (s.health.last_error || '') : 'healthy'}` : '')),
        h('button', { class: 'btn sm danger', onclick: async () => { await api(`/jobs/sources/${i}`, { method: 'DELETE' }); refresh(); } }, 'Remove'))));
    }
    refresh();
  });
}
