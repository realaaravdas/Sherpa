import { h, api, clear, toast, fail, busy, modal, field, copy, download, ago } from './util.js';

const csv = (a) => (a || []).join(', ');

export async function profileView(root) {
  const { profile: p, aiAvailable } = await api('/profile');
  const inp = (k, attrs) => h('input', { value: p[k] ?? '', ...attrs });
  const f = {
    name: inp('name'), headline: inp('headline', { placeholder: 'e.g. Full-stack engineer, 6 yrs, fintech' }), yearsExperience: inp('yearsExperience', { type: 'number', min: 0, max: 60 }),
    skills: h('textarea', { rows: 3, placeholder: 'python, react, kubernetes…' }, csv(p.skills)), targetRoles: inp('targetRoles', { value: csv(p.targetRoles), placeholder: 'Backend Engineer, Platform Engineer' }),
    locations: inp('locations', { value: csv(p.locations), placeholder: 'Berlin, London' }), countries: inp('countries', { value: csv(p.countries), placeholder: 'US, DE' }),
    minSalary: inp('minSalary', { type: 'number', step: 5000, placeholder: 'Annual, USD' }), excludeKeywords: inp('excludeKeywords', { value: csv(p.excludeKeywords), placeholder: 'intern, unpaid, php' }),
    blockedCompanies: inp('blockedCompanies', { value: csv(p.blockedCompanies) }), summary: h('textarea', { rows: 3 }, p.summary || ''), resume: h('textarea', { rows: 14, placeholder: 'Paste your resume text here, or upload a PDF/DOCX below.' }, p.resume || ''),
    workMode: h('select', [['any', 'Any'], ['remote', 'Remote only'], ['hybrid', 'Hybrid or remote'], ['onsite', 'On-site']].map(([v, l]) => h('option', { value: v, selected: (p.workMode || 'any') === v }, l))),
    seniority: h('select', ['', 'intern', 'junior', 'mid', 'senior', 'lead', 'staff', 'principal', 'director'].map((v) => h('option', { value: v, selected: (p.seniority || '') === v }, v || 'Auto'))),
  };
  const file = h('input', { type: 'file', accept: '.pdf,.docx,.txt,.md', class: 'hidden', onchange: async (e) => {
    const fl = e.target.files[0]; if (!fl) return;
    if (fl.size > 6e6) return toast('File too large (6 MB max)', true);
    const buf = new Uint8Array(await fl.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    try { const r = await api('/profile/resume-file', { method: 'POST', body: { filename: fl.name, data: btoa(bin) } }); f.resume.value = r.text; toast('Resume text extracted — review it, then Analyze'); } catch (ex) { fail(ex); }
    e.target.value = '';
  } });
  const collect = () => Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]));
  const save = h('button', { class: 'btn primary' }, 'Save profile');
  save.onclick = busy(save, async () => { await api('/profile', { method: 'PUT', body: collect() }); toast('Profile saved'); });
  const analyze = h('button', { class: 'btn' }, '✨ Analyze resume & fill profile');
  analyze.onclick = busy(analyze, async () => {
    const r = await api('/profile/analyze', { method: 'POST', body: { resume: f.resume.value } });
    Object.entries(r.profile).forEach(([k, v]) => { if (f[k] && v != null) f[k].value = Array.isArray(v) ? csv(v) : v; });
    toast(r.usedAi ? 'Profile filled in from your resume' : 'Skills detected from your resume (add an NVIDIA key for deeper analysis)');
  });

  root.append(h('div', { class: 'topbar' }, h('h1', 'Profile'), h('div', { class: 'grow' }), save),
    h('div', { class: `card small${aiAvailable ? ' hidden' : ''}`, style: { marginBottom: '1rem', background: 'var(--warn-soft)' } }, '⚠️ AI is off — add an NVIDIA API key in Settings to enable resume analysis, semantic matching, cover letters and the coach. Keyword matching still works.'),
    h('div', { class: 'stack' },
      h('div', { class: 'card stack' }, h('h2', 'Resume'), f.resume,
        h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => file.click() }, '📎 Upload PDF / DOCX / TXT'), file, analyze)),
      h('div', { class: 'card stack' }, h('h2', 'About you'), h('div', { class: 'grid3' }, field('Name', f.name), field('Headline', f.headline), field('Years of experience', f.yearsExperience)),
        field('Summary', f.summary), field('Skills (comma separated)', f.skills), h('div', { class: 'grid2' }, field('Level', f.seniority), field('Target roles', f.targetRoles))),
      h('div', { class: 'card stack' }, h('h2', 'What you want'), h('p', { class: 'small muted', style: { margin: 0 } }, 'These tune the match score. Deal-breakers below remove jobs entirely.'),
        h('div', { class: 'grid3' }, field('Work mode', f.workMode), field('Preferred cities', f.locations), field('Preferred countries (US, UK, DE…)', f.countries)),
        h('div', { class: 'grid3' }, field('Minimum salary (yearly)', f.minSalary), field('Exclude title keywords', f.excludeKeywords), field('Blocked companies', f.blockedCompanies)))));
}

export async function documentsView(root) {
  const { documents } = await api('/ai/documents');
  const list = h('div', { class: 'stack' });
  root.append(h('div', { class: 'topbar' }, h('h1', 'Documents')), list);
  const render = (docs) => {
    clear(list);
    if (!docs.length) list.append(h('div', { class: 'card empty' }, 'Cover letters, resume tailoring notes and interview prep you generate are saved here — encrypted.'));
    docs.forEach((d) => list.append(h('div', { class: 'card row' }, h('div', { class: 'grow' }, h('b', d.title), h('div', { class: 'tiny muted' }, `${d.kind} · ${ago(d.createdAt)}`)),
      h('button', { class: 'btn sm', onclick: () => view(d) }, 'Open'),
      h('button', { class: 'btn sm danger', onclick: async () => { await api(`/ai/documents/${d.id}`, { method: 'DELETE' }); render(docs.filter((x) => x.id !== d.id)); } }, 'Delete'))));
  };
  const view = (d) => modal(d.title, (b) => {
    const t = h('textarea', { rows: 20, style: { fontFamily: 'inherit' } }, d.content); b.append(t);
    b.dataset.t = '1'; b.t = t;
  }, { footer: (m) => [h('button', { class: 'btn', onclick: () => copy(m.body.t.value) }, 'Copy'), h('button', { class: 'btn', onclick: () => download(`${d.title.slice(0, 40)}.txt`, m.body.t.value) }, 'Download'),
    h('button', { class: 'btn primary', onclick: async () => { await api(`/ai/documents/${d.id}`, { method: 'PUT', body: { content: m.body.t.value } }); d.content = m.body.t.value; toast('Saved'); } }, 'Save')], wide: true });
  render(documents);
}

export async function settingsView(root, { me }) {
  const { profile: p, aiAvailable } = await api('/profile');
  const key = h('input', { type: 'password', placeholder: p.hasOwnKey ? '•••••••• (saved — enter a new one to replace)' : 'nvapi-…', autocomplete: 'off' });
  const saveKey = h('button', { class: 'btn primary' }, 'Save key');
  saveKey.onclick = busy(saveKey, async () => { await api('/profile', { method: 'PUT', body: { nvidiaKey: key.value } }); toast(key.value ? 'Key saved (encrypted)' : 'Key removed'); key.value = ''; });
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', autocomplete: 'new-password' });
  const chg = h('button', { class: 'btn' }, 'Change password');
  chg.onclick = busy(chg, async () => { await api('/auth/change-password', { method: 'POST', body: { currentPassword: cur.value, newPassword: nw.value } }); cur.value = nw.value = ''; toast('Password changed; other devices signed out'); });
  const rec = h('button', { class: 'btn' }, 'Generate new recovery code');
  rec.onclick = async () => {
    const pw = prompt('Confirm your password to generate a new recovery code'); if (!pw) return;
    try { const r = await api('/auth/new-recovery-code', { method: 'POST', body: { password: pw } }); modal('New recovery code', (b) => b.append(h('p', { class: 'muted' }, 'Your old code no longer works. Store this one safely.'), h('div', { class: 'recovery' }, r.recoveryCode))); } catch (e) { fail(e); }
  };
  const sess = h('div', { class: 'small' });
  api('/auth/sessions').then(({ sessions }) => sess.append(sessions.map((s) => h('div', { class: 'row', style: { padding: '.2rem 0' } }, h('span', s.current ? '● This device' : '○ Other'), h('span', { class: 'muted' }, `${(s.ua || '').slice(0, 60)} · ${s.ip || ''} · ${ago(s.createdAt)}`)))));
  const sources = h('div', { class: 'small muted' });
  api('/jobs/stats').then((s) => sources.textContent = `${s.sources.length} sources tracked · ${s.sources.filter((x) => x.failures).length} failing · ${s.embeddedJobs.toLocaleString()} jobs embedded for semantic search`).catch(() => {});

  root.append(h('div', { class: 'topbar' }, h('h1', 'Settings')), h('div', { class: 'stack', style: { maxWidth: '680px' } },
    h('div', { class: 'card stack' }, h('h2', 'NVIDIA NIM (AI)'), h('p', { class: 'small muted', style: { margin: 0 } }, aiAvailable ? (p.hasOwnKey ? 'Using your own API key.' : 'AI is available through this server’s key. You can use your own instead.') : 'AI is off. Get a free key at build.nvidia.com and paste it here. It is stored encrypted and only used for your requests.'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, key), saveKey), sources),
    h('div', { class: 'card stack' }, h('h2', 'Password & recovery'), h('div', { class: 'grid2' }, field('Current password', cur), field('New password (10+ chars)', nw)), h('div', { class: 'row' }, chg, rec)),
    h('div', { class: 'card stack' }, h('h2', 'Sessions'), sess, h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: async () => { await api('/auth/logout-others', { method: 'POST', body: {} }); toast('Signed out everywhere else'); } }, 'Sign out other devices'))),
    h('div', { class: 'card stack' }, h('h2', `Account · ${me.email}`),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { await api('/auth/logout', { method: 'POST', body: {} }); location.hash = ''; location.reload(); } }, 'Sign out'),
        h('button', { class: 'btn danger', onclick: async () => { const pw = prompt('Type your password to permanently delete your account and all data'); if (!pw) return; try { await api('/auth/account', { method: 'DELETE', body: { password: pw } }); location.reload(); } catch (e) { fail(e); } } }, 'Delete account')))));
}
