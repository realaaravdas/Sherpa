# ⛰️ Sherpa — an open-source AI job-search copilot

Sherpa is a self-hostable alternative to the "Jack" (candidate-side) half of Jack & Jill. It **finds** jobs from dozens of sources, **ranks** them against your resume with explanations, **tracks** every application in a pipeline, and gives you an **AI career coach** — powered by **NVIDIA NIM**.

Multi-user and safe to host publicly: every account has its own login, and all personal data is encrypted with a key only that user's password can unlock.

## Features

**Discover**
- Scrapes ~65 sources on a schedule: company boards on **Greenhouse, Lever, Ashby** (≈60 curated companies) plus **Remotive, RemoteOK, Himalayas, We Work Remotely, Arbeitnow, Jobicy and Hacker News "Who is hiring"**. ~13k open jobs after the first run.
- **Paste any careers link** and Sherpa auto-detects the ATS (Greenhouse, Lever, Ashby, Workable, Recruitee, SmartRecruiters) or reads `JobPosting` structured data from any other page (robots.txt respected, SSRF-guarded).
- Full-text search (SQLite FTS5) + filters: work mode, level, pay, country, posted date, hide-already-tracked.
- **Explainable match score (0-100)**: title fit, skills, seniority, location/work-mode, salary, recency — blended with NIM embedding similarity to your resume. Deal-breakers (excluded keywords, blocked companies, remote-only) remove jobs outright.
- ✨ **Ask AI**: "remote senior python roles over $150k posted this week" → structured filters.
- Per job: fit analysis, tailored resume bullets, cover letter, interview prep — all generated only from facts in your resume.

**Pipeline (applications)**
- Kanban board (drag & drop) or sortable table: Saved → Applied → Screening → Interview → Offer → Accepted / Rejected / Withdrawn.
- Sort by recent activity, **"needs attention"** (interviews soon › offers › follow-ups due › ghosted), date applied, follow-up date, priority, match score, company, stage.
- Auto-flags: follow-up due, 👻 no reply in 21+ days, interview this week. Default follow-up nudge 7 days after applying.
- Timeline per application (status changes + notes/calls/emails), contacts, tags, priority, job snapshot (survives the posting being taken down).
- Dashboard: funnel, response rate, interview rate, average time-to-reply, applications per week. CSV export (formula-injection safe).
- 📨 Paste a confirmation/rejection email or posting → AI fills in the application.

**Better scraping** (what's improved over a naive scraper)
- Uses each ATS's official public JSON API (no fragile HTML) with retries, backoff and `Retry-After`.
- **Real closed-job detection**: board scrapes are complete listings, so a job that disappears is closed immediately; aggregator jobs age out. "Still open?" re-checks the live page on demand.
- **Cross-board de-duplication**: the same role seen on a board and an aggregator is merged (fingerprint of company + cleaned title + city), keeping the direct-ATS apply link.
- Normalisation: HTML → clean text, salary parsing (k/ranges/hourly/currencies), seniority, remote/hybrid, country, ~150-term skill vocabulary.
- Source health tracking; flaky sources are auto-disabled after repeated failures and retried daily.

**Accounts & security**
- Passwords: **Argon2id** (OWASP parameters) over an HMAC-SHA256 *pepper* (server secret).
- Sessions: **Oslo** (`@oslojs/crypto`, `@oslojs/encoding`) — 160-bit random tokens; only `sha256(token)` is stored; HttpOnly + SameSite=Lax (+ `Secure`/`__Host-` in production); sliding 30-day expiry; sign-out-everywhere.
- **Encryption at rest**: profile, resume, applications, notes, documents, chats and a user's own API key are AES-256-GCM encrypted with a random per-user data key. That key is wrapped by a key derived (scrypt) from the password and by a one-time **recovery code** shown at sign-up. While you're signed in, it lives in your session row encrypted with a key derived from your cookie — so a stolen database yields nothing readable (and the server can't read your data while you're signed out). Records are bound to their owner via AES-GCM AAD.
- Rate limiting on login (per account+IP and per account), registration, recovery, AI; constant-time-ish login for unknown emails.
- CSRF defences (SameSite + same-origin check + JSON-only writes), strict CSP (no inline scripts), HSTS, frame/referrer/permissions headers, SSRF-safe fetcher (private-IP blocking at connect time, redirect re-validation, size caps), UI built with DOM APIs only (no `innerHTML`), AI prompts treat resumes/job text as untrusted data.
- Change password (re-wraps keys, revokes other sessions), rotate recovery code, delete account (cascades).

> ⚠️ Because data is encrypted with your password, **a forgotten password plus a lost recovery code means the data cannot be recovered** — by design.

## Quick start

Requires **Node ≥ 22.13**.

```bash
npm install
cp .env.example .env     # add NVIDIA_API_KEY (and APP_SECRET for production)
npm start                # http://localhost:3000
```

The first start scrapes the job pool in the background (about a minute). Without an NVIDIA key everything works except AI features and semantic matching (keyword matching remains).

```bash
npm test                 # 36 tests: parsing, scoring, tracker, auth, encryption, isolation, scraping, mocked NIM
```

### NVIDIA NIM
Uses the OpenAI-compatible endpoint `https://integrate.api.nvidia.com/v1`: chat completions for the coach/analysis/writing and `/embeddings` for semantic matching. Set `NVIDIA_API_KEY` on the server and/or let each user add their own key in **Settings** (stored encrypted, used only for their requests; the shared job index is only ever embedded with the server key). NVIDIA rotates its hosted catalogue, so Sherpa checks `/v1/models` and falls back to an available model if the configured one is retired. If the embedding model changes, job and profile embeddings are rebuilt automatically.

## Hosting publicly

1. Put it behind HTTPS (Caddy, nginx, Cloudflare Tunnel, Fly.io, Railway…). Set `NODE_ENV=production`, `TRUST_PROXY=1`, and a strong `APP_SECRET`.
2. Persist `DATA_DIR` (SQLite + generated secret). **Back it up, and keep `APP_SECRET` stable** — changing it invalidates every password.
3. Optional: `ALLOW_REGISTRATION=false` after creating accounts for an invite-only deployment.

```bash
docker build -t sherpa .
docker run -d -p 3000:3000 -v sherpa-data:/data --env-file .env sherpa
```

Caddy example: `jobs.example.com { reverse_proxy localhost:3000 }`

## Architecture

```
src/
  server.js            Express app, security middleware, scheduler
  security.js          Argon2id, Oslo sessions, AES-GCM, key hierarchy, rate limiter
  store.js             encrypted per-user record store
  nim.js               NVIDIA NIM client (chat, embeddings, model resolution)
  matching.js          explainable scoring · jobs.js  search/rank/embed · applications.js  tracker logic
  scraper/             adapters (ATS + aggregators + generic), normalisation, SSRF-safe http, orchestration
  routes/              auth · profile · jobs · applications · ai
public/                dependency-free SPA (ES modules)
tests/                 node:test suites
```

Adding a job source = one adapter returning `buildJob(...)` objects in `src/scraper/adapters.js` (+ company slugs in `companies.json`).

## Notes & limits
- Sherpa links you to the original posting and never auto-applies or scrapes behind logins (e.g. LinkedIn/Indeed are intentionally not scraped — they forbid it and block bots).
- SQLite (single node) comfortably serves a few thousand users; the job pool is shared, personal data is per user.
