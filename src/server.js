import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { db } from './db.js';
import { loadUser, csrf, securityHeaders, limit } from './middleware.js';
import { purgeExpiredSessions } from './security.js';
import auth from './routes/auth.js';
import profile from './routes/profile.js';
import jobs from './routes/jobs.js';
import applications from './routes/applications.js';
import ai from './routes/ai.js';
import { startScheduler } from './scraper/index.js';
import { startEmbedder } from './jobs.js';
import { nimAvailable } from './nim.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(securityHeaders);
  app.use('/api/profile/resume-file', express.json({ limit: '9mb' })); // only the upload route accepts big bodies
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', csrf, loadUser, limit('api', 600, 60_000, 'ip'));
  app.get('/api/health', (_req, res) => res.json({ ok: true, ai: nimAvailable() }));
  app.use('/api/auth', auth);
  app.use('/api/profile', profile);
  app.use('/api/jobs', jobs);
  app.use('/api/applications', applications);
  app.use('/api/ai', ai);
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
  app.use(express.static(pub, { maxAge: config.isProd ? '1h' : 0, index: 'index.html' }));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(pub, 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    const status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500 && status !== 502 && status !== 503) console.error(err);
    res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
  });
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  const server = app.listen(config.port, () => {
    console.log(`Sherpa running on http://localhost:${config.port}  (AI: ${nimAvailable() ? 'NVIDIA NIM enabled' : 'no NVIDIA_API_KEY — keyword matching only'})`);
    if (!config.cookieSecure) console.warn('! Cookies are not marked Secure. Serve over HTTPS and set NODE_ENV=production for public hosting.');
  });
  startScheduler();
  startEmbedder();
  setInterval(purgeExpiredSessions, 3_600_000).unref();
  const stop = () => { server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
