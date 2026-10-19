import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-test-'));
Object.assign(process.env, { DATA_DIR: dir, DB_FILE: path.join(dir, 't.db'), NVIDIA_API_KEY: 'test-key', ALLOW_PRIVATE_FETCH: 'true', SCRAPE_INTERVAL_MIN: '0', COOKIE_SECURE: 'false', REGISTER_PER_HOUR_PER_IP: '1000' });

/* ── mock NVIDIA NIM (OpenAI-compatible) ── */
const nimCalls = [];
const nim = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    const j = JSON.parse(body || '{}'); nimCalls.push({ url: req.url, auth: req.headers.authorization, body: j });
    res.setHeader('content-type', 'application/json');
    // catalogue lacks the configured default chat model → client must fall back to a listed one
    if (req.url === '/v1/models') return res.end(JSON.stringify({ data: ['nvidia/llama-3.1-nemotron-70b-instruct', 'nvidia/llama-3.2-nv-embedqa-1b-v1'].map((id) => ({ id })) }));
    if (req.url === '/v1/embeddings') return res.end(JSON.stringify({ data: j.input.map((t, i) => ({ index: i, embedding: Array.from({ length: 8 }, (_, k) => /python/i.test(t) ? (k === 0 ? 1 : 0.1) : (k === 1 ? 1 : 0.1)) })) }));
    const last = j.messages.at(-1).content; let out;
    if (/Extract from this resume/.test(last)) out = '```json\n{"name":"Jane Doe","headline":"Backend engineer","skills":["Python","Django","PostgreSQL"],"targetRoles":["Backend Engineer"],"yearsExperience":7,"seniority":"senior","locations":["Berlin"],"summary":"Builds APIs."}\n```';
    else if (/Assess how well/.test(last)) out = 'Here you go: {"verdict":"strong","summary":"Great fit.","strengths":["Python"],"gaps":["Rust"],"keywordsToAdd":["gRPC"],"redFlags":[],"nextStep":"Apply"}';
    else if (/cover letter/.test(last)) out = 'Dear [Hiring Manager], I love Python.';
    else if (/parse|job application details/i.test(j.messages[0].content)) out = '{"company":"Initech","title":"Data Engineer","location":"Austin","status":"applied","url":"","note":"Confirmation email","interviewAt":null}';
    else if (/search filters/.test(j.messages[0].content)) out = '{"q":"python","remote":"remote","seniority":"senior","minSalary":150000,"country":"","postedWithin":7}';
    else out = 'Focus on following up with Acme.';
    res.end(JSON.stringify({ choices: [{ message: { content: out } }] }));
  });
});
await new Promise((r) => nim.listen(0, r));
process.env.NIM_CHAT_MODEL = 'meta/retired-model'; // not in the mock catalogue
process.env.NIM_BASE_URL = `http://127.0.0.1:${nim.address().port}/v1`;

/* ── fixture careers page for the generic scraper ── */
const page = http.createServer((req, res) => {
  if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\n');
  res.setHeader('content-type', 'text/html');
  res.end(`<html><head><script type="application/ld+json">${JSON.stringify([{ '@type': 'JobPosting', title: 'Site Reliability Engineer', description: '<p>Kubernetes and Terraform on AWS</p>', hiringOrganization: { name: 'Fixture Co' }, datePosted: new Date().toISOString(), jobLocation: { address: { addressLocality: 'Dublin', addressCountry: 'IE' } }, url: 'http://x/jobs/1' }, { '@type': 'JobPosting', title: 'Product Designer', description: 'Figma', hiringOrganization: { name: 'Fixture Co' }, jobLocationType: 'TELECOMMUTE', url: 'http://x/jobs/2' }, { '@type': 'JobPosting', title: 'Data Scientist', description: 'Python machine learning', hiringOrganization: { name: 'Fixture Co' }, url: 'http://x/jobs/3' }])}</script></head><body>careers</body></html>`);
});
await new Promise((r) => page.listen(0, r));

const { createApp } = await import('../src/server.js');
const { db } = await import('../src/db.js');
const { upsertJob, expireMissing } = await import('../src/scraper/index.js');
const { buildJob } = await import('../src/scraper/normalize.js');
const sec = await import('../src/security.js');

let server, base;
before(async () => { server = createApp().listen(0); await new Promise((r) => server.on('listening', r)); base = `http://127.0.0.1:${server.address().port}`; });
after(() => { server.close(); nim.close(); page.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    const sc = res.headers.getSetCookie?.() || [];
    for (const c of sc) { const [kv] = c.split(';'); if (/=;?$/.test(kv) || /Expires=Thu, 01 Jan 1970/.test(c)) cookie = ''; else cookie = kv; }
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, headers: res.headers, data: ct.includes('json') ? await res.json() : await res.text(), setCookie: sc };
  };
  return { get: (u) => call('GET', u), post: (u, b = {}, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b), del: (u, b) => call('DELETE', u, b), jar: () => cookie };
}
const PW = 'correct horse battery';
const signup = async (email) => { const c = client(); const r = await c.post('/api/auth/register', { email, password: PW }); assert.equal(r.status, 201, JSON.stringify(r.data)); return { c, recovery: r.data.recoveryCode, email }; };

/* seed public jobs */
const mk = (o) => buildJob({ source: 'test', sourceId: o.title, url: `https://jobs.example/${o.title.replace(/\W/g, '')}`, ...o });
before(() => {
  for (const j of [
    mk({ title: 'Senior Backend Engineer', company: 'Acme', location: 'Berlin, Germany', description: 'Python, Django, PostgreSQL on AWS. Salary $140k - $170k. Remote friendly.', postedAt: Date.now() - 3600_000 }),
    mk({ title: 'Account Executive', company: 'SalesCo', location: 'New York, NY', description: 'Salesforce, enterprise sales.', postedAt: Date.now() - 20 * 86400_000 }),
    mk({ title: 'Frontend Developer', company: 'Pixel', location: 'Remote', description: 'React, TypeScript, CSS.', postedAt: Date.now() - 86400_000 }),
  ]) upsertJob(j);
});

test('security headers + auth required', async () => {
  const c = client();
  const h = await c.get('/api/health');
  assert.match(h.headers.get('content-security-policy'), /default-src 'self'/); assert.equal(h.headers.get('x-frame-options'), 'DENY');
  assert.equal((await c.get('/api/applications')).status, 401);
  assert.equal((await c.get('/api/profile')).status, 401);
  assert.equal((await c.get('/api/jobs')).status, 401);
});

test('register / me / logout / login lifecycle', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/register', { email: 'bad', password: PW })).status, 400);
  assert.equal((await c.post('/api/auth/register', { email: 'a@ex.com', password: 'short' })).status, 400);
  const r = await c.post('/api/auth/register', { email: 'Life@Ex.com', password: PW });
  assert.equal(r.status, 201); assert.match(r.data.recoveryCode, /^([A-Z2-7]{4}-){5}[A-Z2-7]{4}$/);
  assert.match(r.setCookie[0], /HttpOnly/i); assert.match(r.setCookie[0], /SameSite=Lax/i);
  assert.equal((await c.get('/api/auth/me')).data.user.email, 'life@ex.com');
  assert.equal((await client().post('/api/auth/register', { email: 'life@ex.com', password: PW })).status, 409);
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).data.user, null);
  assert.equal((await c.post('/api/auth/login', { email: 'life@ex.com', password: 'wrong password!!' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'nobody@ex.com', password: PW })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: 'LIFE@ex.com', password: PW })).status, 200);
  assert.equal((await c.get('/api/applications')).status, 200);
});

test('passwords are argon2id and sessions are stored hashed', async () => {
  await signup('hash@ex.com');
  const u = db.prepare("SELECT * FROM users WHERE email='hash@ex.com'").get();
  assert.match(u.password_hash, /^\$argon2id\$/); assert.ok(!u.password_hash.includes(PW));
  const s = db.prepare('SELECT * FROM sessions WHERE user_id=?').get(u.id);
  assert.match(s.id, /^[0-9a-f]{64}$/); assert.match(s.key_enc, /^v1\./);
});

test('CSRF: cross-origin writes and non-JSON bodies are rejected', async () => {
  const { c } = await signup('csrf@ex.com');
  assert.equal((await c.post('/api/applications', { title: 'x', company: 'y' }, { origin: 'https://evil.example' })).status, 403);
  const raw = await fetch(base + '/api/applications', { method: 'POST', headers: { 'content-type': 'text/plain', cookie: c.jar() }, body: '{"title":"x","company":"y"}' });
  assert.equal(raw.status, 415);
});

test('personal data is encrypted at rest and isolated between users', async () => {
  const a = await signup('iso-a@ex.com'), b = await signup('iso-b@ex.com');
  const secret = 'ZebraUnicornCorp-7731';
  const r = await a.c.post('/api/applications', { title: 'Wizard', company: secret, notes: 'salary talk: 999999', status: 'applied' });
  assert.equal(r.status, 201);
  await a.c.put('/api/profile', { name: 'Alice Secretname', resume: 'My private resume with Fortran experience' });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const raw = fs.readFileSync(path.join(dir, 't.db')).toString('latin1');
  for (const needle of [secret, 'salary talk', 'Alice Secretname', 'Fortran']) assert.ok(!raw.includes(needle), `plaintext leak: ${needle}`);
  for (const row of db.prepare('SELECT data_enc FROM records').all()) assert.match(row.data_enc, /^v1\.[\w-]+\.[\w-]+\.[\w-]*$/);
  assert.equal((await b.c.get(`/api/applications/${r.data.application.id}`)).status, 404);
  assert.equal((await b.c.patch(`/api/applications/${r.data.application.id}`, { notes: 'hax' })).status, 404);
  assert.equal((await b.c.del(`/api/applications/${r.data.application.id}`)).data.ok, false);
  assert.equal((await b.c.get('/api/applications')).data.applications.length, 0);
  assert.equal((await a.c.get('/api/applications')).data.applications[0].company, secret);
  // records are bound to their owner via AAD: moving a ciphertext to another user's row must not decrypt
  const row = db.prepare("SELECT * FROM records WHERE kind='application'").get();
  assert.throws(() => sec.decrypt(sec.randomKey(), row.data_enc, `${row.user_id}:application`));
});

test('changing password re-wraps the key, revokes other sessions, keeps data', async () => {
  const a = await signup('chg@ex.com'); const other = client(); await other.post('/api/auth/login', { email: 'chg@ex.com', password: PW });
  await a.c.post('/api/applications', { title: 'Keep me', company: 'Co' });
  assert.equal((await a.c.post('/api/auth/change-password', { currentPassword: 'nope nope nope', newPassword: 'another long pass' })).status, 401);
  assert.equal((await a.c.post('/api/auth/change-password', { currentPassword: PW, newPassword: 'another long pass' })).status, 200);
  assert.equal((await other.get('/api/applications')).status, 401, 'other device signed out');
  assert.equal((await a.c.get('/api/applications')).status, 200, 'current session kept');
  const n = client();
  assert.equal((await n.post('/api/auth/login', { email: 'chg@ex.com', password: PW })).status, 401);
  assert.equal((await n.post('/api/auth/login', { email: 'chg@ex.com', password: 'another long pass' })).status, 200);
  assert.equal((await n.get('/api/applications')).data.applications[0].title, 'Keep me');
});

test('recovery code restores access without losing data, and rotates', async () => {
  const a = await signup('rec@ex.com');
  await a.c.post('/api/applications', { title: 'Survivor', company: 'Co' });
  const n = client();
  assert.equal((await n.post('/api/auth/recover', { email: 'rec@ex.com', recoveryCode: 'AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', newPassword: 'brand new passphrase' })).status, 401);
  const r = await n.post('/api/auth/recover', { email: 'rec@ex.com', recoveryCode: a.recovery.toLowerCase().replaceAll('-', ' '), newPassword: 'brand new passphrase' });
  assert.equal(r.status, 200); assert.notEqual(r.data.recoveryCode, a.recovery);
  assert.equal((await n.get('/api/applications')).data.applications[0].title, 'Survivor');
  assert.equal((await a.c.get('/api/applications')).status, 401, 'old sessions revoked');
  assert.equal((await client().post('/api/auth/recover', { email: 'rec@ex.com', recoveryCode: a.recovery, newPassword: 'yet another phrase' })).status, 401, 'old code dead');
});

test('login is rate limited per account', async () => {
  await signup('rl@ex.com'); const c = client(); let last;
  for (let i = 0; i < 10; i++) last = await c.post('/api/auth/login', { email: 'rl@ex.com', password: `wrong-${i}-password` });
  assert.equal(last.status, 429);
  assert.equal((await c.post('/api/auth/login', { email: 'rl@ex.com', password: PW })).status, 429, 'even the right password is refused while locked');
});

test('job search, filters, personalised ranking, hide', async () => {
  const { c } = await signup('jobs@ex.com');
  let r = (await c.get('/api/jobs?q=python')).data;
  assert.equal(r.total, 1); assert.equal(r.jobs[0].company, 'Acme'); assert.deepEqual(r.jobs[0].salary, { min: 140000, max: 170000, currency: 'USD' });
  assert.equal((await c.get('/api/jobs?remote=remote')).data.total, 2);
  assert.equal((await c.get('/api/jobs?minSalary=150000')).data.total, 1);
  assert.equal((await c.get('/api/jobs?postedWithin=2')).data.total, 2);
  assert.equal((await c.get('/api/jobs?q=salesforce+python')).data.total, 2, 'AND relaxes to OR when nothing matches');
  await c.put('/api/profile', { skills: 'python, django, postgres', targetRoles: 'Backend Engineer', seniority: 'senior' });
  r = (await c.get('/api/jobs')).data;
  assert.equal(r.jobs[0].title, 'Senior Backend Engineer'); assert.ok(r.jobs[0].match.score > r.jobs[2].match.score); assert.ok(r.jobs[0].match.matched.includes('python'));
  const id = r.jobs[0].id;
  await c.post(`/api/jobs/${id}/hide`);
  assert.ok(!(await c.get('/api/jobs')).data.jobs.some((j) => j.id === id));
  await c.post(`/api/jobs/${id}/unhide`);
  assert.ok((await c.get('/api/jobs')).data.jobs.some((j) => j.id === id));
  const d = (await c.get(`/api/jobs/${id}`)).data.job; assert.match(d.description, /Django/);
});

test('same job from two boards is merged, best link wins; closed jobs expire', async () => {
  const base_ = { title: 'Merge Engineer', company: 'MergeCo', location: 'Paris' };
  upsertJob(buildJob({ ...base_, source: 'remotive', sourceId: '1', url: 'https://agg/1', description: 'short' }));
  upsertJob(buildJob({ ...base_, source: 'greenhouse:mergeco', sourceId: '9', url: 'https://boards/9', description: 'a much longer description with Python' }));
  const rows = db.prepare("SELECT * FROM jobs WHERE company='MergeCo'").all();
  assert.equal(rows.length, 1); assert.equal(rows[0].url, 'https://boards/9'); assert.match(rows[0].description, /longer/);
  assert.equal(JSON.parse(rows[0].sources).length, 2);
  // Greenhouse no longer lists it → source dropped but aggregator copy keeps it alive
  expireMissing('greenhouse:mergeco', Date.now() + 1000);
  assert.equal(db.prepare("SELECT active FROM jobs WHERE company='MergeCo'").get().active, 1);
  expireMissing('remotive', Date.now() + 1000);
  assert.equal(db.prepare("SELECT active FROM jobs WHERE company='MergeCo'").get().active, 0);
});

test('application tracker lifecycle', async () => {
  const { c } = await signup('track@ex.com');
  const job = (await c.get('/api/jobs?q=backend')).data.jobs[0];
  const s = await c.post('/api/applications', { jobId: job.id });
  assert.equal(s.status, 201); assert.equal(s.data.application.status, 'saved'); assert.equal(s.data.application.company, 'Acme');
  const again = await c.post('/api/applications', { jobId: job.id }); assert.equal(again.data.existing, true);
  assert.equal((await c.get('/api/jobs?q=backend&hideApplied=1')).data.total, 0);
  assert.equal((await c.get('/api/jobs?q=backend')).data.jobs[0].state, 'saved');
  const id = s.data.application.id;
  let a = (await c.patch(`/api/applications/${id}`, { status: 'applied' })).data.application;
  assert.ok(a.appliedAt && a.followUpAt); assert.equal(a.events.at(-1).to, 'applied');
  a = (await c.post(`/api/applications/${id}/events`, { type: 'call', note: 'Recruiter screen booked' })).data.application;
  assert.equal(a.events.at(-1).note, 'Recruiter screen booked');
  a = (await c.patch(`/api/applications/${id}`, { status: 'interview', interviewAt: Date.now() + 86400_000, tags: ['dream'], priority: 1 })).data.application;
  assert.ok(a.interviewSoon);
  // manual add + duplicate guard
  assert.equal((await c.post('/api/applications', { title: 'Staff Eng', company: 'Globex', status: 'applied' })).status, 201);
  assert.equal((await c.post('/api/applications', { title: 'staff eng', company: 'GLOBEX' })).status, 409);
  const list = (await c.get('/api/applications?sort=attention')).data;
  assert.equal(list.applications[0].company, 'Acme'); assert.deepEqual(list.tags, ['dream']);
  assert.equal((await c.get('/api/applications?status=applied')).data.applications.length, 1);
  assert.equal((await c.get('/api/applications?q=globex')).data.applications.length, 1);
  const st = (await c.get('/api/applications/stats')).data; assert.equal(st.total, 2); assert.equal(st.interviewed, 1); assert.equal(st.responseRate, 50);
  const csv = await c.get('/api/applications/export.csv'); assert.match(csv.data, /Globex/); assert.match(csv.headers.get('content-disposition'), /attachment/);
  assert.equal((await c.post('/api/applications/bulk', { ids: [id], status: 'rejected' })).data.updated, 1);
  assert.equal((await c.get(`/api/applications/${id}`)).data.application.status, 'rejected');
  assert.equal((await c.del(`/api/applications/${id}`)).data.ok, true);
  assert.equal((await c.get(`/api/applications/${id}`)).status, 404);
});

test('generic career-page scraping via pasted URL (JSON-LD) + robots.txt', async () => {
  const { c } = await signup('src@ex.com');
  const url = `http://127.0.0.1:${page.address().port}/careers`;
  const r = await c.post('/api/jobs/sources', { url });
  assert.equal(r.status, 201, JSON.stringify(r.data)); assert.equal(r.data.found, 3);
  assert.equal((await c.get('/api/jobs?q=kubernetes')).data.jobs[0].company, 'Fixture Co');
  assert.equal((await c.get('/api/jobs/sources/mine')).data.sources.length, 1);
  assert.equal((await c.post('/api/jobs/sources', { url: 'http://127.0.0.1:1/nothing' })).status, 422);
  assert.equal((await c.post('/api/jobs/sources', { url: 'ftp://x/y' })).status, 400);
  await c.del('/api/jobs/sources/0'); assert.equal((await c.get('/api/jobs/sources/mine')).data.sources.length, 0);
});

test('AI features via NVIDIA NIM (mocked): analyze, fit, cover letter, chat, parse, intent', async () => {
  const { c } = await signup('ai@ex.com');
  const anyJob = (await c.get('/api/jobs?q=backend')).data.jobs[0];
  assert.equal((await c.post('/api/ai/fit', { jobId: anyJob.id })).status, 400, 'needs resume');
  const an = await c.post('/api/profile/analyze', { resume: 'Jane Doe. Senior backend engineer with 7 years of Python, Django and PostgreSQL experience in Berlin.' });
  assert.equal(an.status, 200, JSON.stringify(an.data)); assert.equal(an.data.usedAi, true);
  assert.ok(an.data.profile.skills.includes('python') && an.data.profile.skills.includes('postgres')); assert.deepEqual(an.data.profile.targetRoles, ['Backend Engineer']); assert.equal(an.data.profile.hasEmbedding, true);
  assert.ok(nimCalls.some((x) => x.auth === 'Bearer test-key' && x.url === '/v1/chat/completions' && x.body.model === 'nvidia/llama-3.1-nemotron-70b-instruct'), 'falls back to a model that exists in the catalogue');
  const emb = nimCalls.find((x) => x.url === '/v1/embeddings'); assert.equal(emb.body.input_type, 'query'); assert.ok(emb.body.model);
  const job = (await c.get('/api/jobs?q=backend')).data.jobs[0];
  assert.equal((await c.post('/api/ai/fit', { jobId: job.id })).data.fit.verdict, 'strong');
  const cl = await c.post('/api/ai/cover-letter', { jobId: job.id });
  assert.match(cl.data.document.content, /Hiring Manager/);
  assert.equal((await c.get('/api/ai/documents')).data.documents.length, 1);
  const ch1 = (await c.post('/api/ai/chat', { message: 'What next?' })).data;
  const ch2 = (await c.post('/api/ai/chat', { message: 'And then?', conversationId: ch1.conversationId })).data;
  assert.equal(ch1.conversationId, ch2.conversationId); assert.equal((await c.get('/api/ai/chats')).data.chats[0].messages.length, 4);
  assert.equal((await c.post('/api/ai/parse-application', { text: 'Thanks for applying to Initech for Data Engineer' })).data.application.company, 'Initech');
  assert.equal((await c.post('/api/ai/search-intent', { text: 'remote senior python over 150k' })).data.filters.minSalary, 150000);
  // injection-shaped job text is delimited as data
  const cover = nimCalls.find((x) => /cover letter/.test(x.body.messages?.at(-1).content)).body.messages; assert.match(cover[0].content, /untrusted data/); assert.match(cover.at(-1).content, /<job_posting>[\s\S]*<\/job_posting>/);
  // per-user key is stored encrypted and never returned
  await c.put('/api/profile', { nvidiaKey: 'nvapi-USERKEY' });
  const p = (await c.get('/api/profile')).data; assert.equal(p.profile.hasOwnKey, true); assert.ok(!JSON.stringify(p).includes('USERKEY'));
  await c.post('/api/ai/fit', { jobId: job.id }); assert.equal(nimCalls.at(-1).auth, 'Bearer nvapi-USERKEY');
});

test('resume upload extracts text; semantic scores use embeddings', async () => {
  const { c } = await signup('up@ex.com');
  const r = await c.post('/api/profile/resume-file', { filename: 'cv.txt', data: Buffer.from('Python developer with ten years building Django services.').toString('base64') });
  assert.match(r.data.text, /Django/);
  assert.equal((await c.post('/api/profile/resume-file', { filename: 'x.exe', data: 'AAAA' })).status, 415);
  const { embedPending } = await import('../src/jobs.js');
  assert.ok((await embedPending()) >= 3);
  await c.put('/api/profile', { resume: r.data.text, skills: 'python' });
  const jobs = (await c.get('/api/jobs?sort=match')).data.jobs;
  assert.ok(jobs[0].match.score >= jobs.at(-1).match.score);
});

test('account deletion removes everything', async () => {
  const a = await signup('del@ex.com'); await a.c.post('/api/applications', { title: 'T', company: 'C' });
  assert.equal((await a.c.del('/api/auth/account', { password: 'wrong wrong wrong' })).status, 401);
  assert.equal((await a.c.del('/api/auth/account', { password: PW })).status, 200);
  const id = db.prepare("SELECT id FROM users WHERE email='del@ex.com'").get(); assert.equal(id, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM records WHERE user_id NOT IN (SELECT id FROM users)').get().n, 0);
  assert.equal((await client().post('/api/auth/login', { email: 'del@ex.com', password: PW })).status, 401);
});
