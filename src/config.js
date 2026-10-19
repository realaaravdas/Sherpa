import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Minimal .env loader (no dependency). Real environment variables win.
try {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const env = process.env;
const dataDir = path.resolve(env.DATA_DIR || 'data');
fs.mkdirSync(dataDir, { recursive: true });

// Server-side secret used as a password "pepper". Provide APP_SECRET in production;
// otherwise one is generated once and stored (0600) next to the database.
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return Buffer.from(env.APP_SECRET);
  const file = path.join(dataDir, 'app.secret');
  if (fs.existsSync(file)) return Buffer.from(fs.readFileSync(file, 'utf8').trim());
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return Buffer.from(s);
}

const isProd = env.NODE_ENV === 'production';

export const config = {
  isProd,
  port: Number(env.PORT || 3000),
  dataDir,
  dbFile: env.DB_FILE || path.join(dataDir, 'sherpa.db'),
  secret: loadSecret(),
  // Secure cookies need HTTPS. Default on in production; set COOKIE_SECURE=false for plain-http testing.
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProd,
  trustProxy: env.TRUST_PROXY ? (isNaN(env.TRUST_PROXY) ? env.TRUST_PROXY : Number(env.TRUST_PROXY)) : false,
  allowRegistration: env.ALLOW_REGISTRATION !== 'false',
  sessionDays: Number(env.SESSION_DAYS || 30),
  registerPerHourPerIp: Number(env.REGISTER_PER_HOUR_PER_IP || 8),
  nim: {
    apiKey: env.NVIDIA_API_KEY || '',
    baseUrl: (env.NIM_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, ''),
    chatModel: env.NIM_CHAT_MODEL || 'nvidia/llama-3.1-nemotron-70b-instruct',
    embedModel: env.NIM_EMBED_MODEL || 'nvidia/llama-3.2-nv-embedqa-1b-v1',
    timeoutMs: Number(env.NIM_TIMEOUT_MS || 60000),
  },
  scrape: {
    // Background refresh of the global job pool (minutes). 0 disables.
    intervalMin: Number(env.SCRAPE_INTERVAL_MIN ?? 180),
    onStart: env.SCRAPE_ON_START !== 'false',
    staleAfterDays: Number(env.JOB_STALE_DAYS || 10),
    allowPrivate: env.ALLOW_PRIVATE_FETCH === 'true', // tests only
    userAgent: env.SCRAPER_UA || 'SherpaBot/1.0 (+job-search-assistant; respects robots.txt)',
  },
};
