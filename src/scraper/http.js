import dns from 'node:dns/promises';
import net from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { config } from '../config.js';

const UA = config.scrape.userAgent;

/** Fetch JSON/text from a *fixed, trusted* API host. Uses global fetch (honours NODE_USE_ENV_PROXY). */
export async function apiFetch(url, { json = true, headers = {}, timeoutMs = 20000, retries = 2, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await withDeadline(fetch(url, {
        method, body,
        headers: { 'user-agent': UA, accept: json ? 'application/json' : '*/*', ...headers },
        signal: AbortSignal.timeout(timeoutMs),
      }), timeoutMs + 2000, 'request');
      if (res.status === 404) { const e = new Error('not found (404)'); e.status = 404; e.fatal = true; throw e; }
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get('retry-after')) || 0;
        const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.retryAfter = retryAfter; throw e;
      }
      if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; e.fatal = true; throw e; }
      return await withDeadline(json ? res.json() : res.text(), timeoutMs + 2000, 'response body');
    } catch (e) {
      lastErr = e;
      if (e.fatal || attempt === retries) break;
      await sleep(Math.min((e.retryAfter || 2 ** attempt) * 1000, 8000) + Math.random() * 300);
    }
  }
  throw lastErr;
}
/** Hard deadline that doesn't depend on the underlying socket honouring an abort signal. */
export const withDeadline = (promise, ms, label = 'operation') => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
  promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ───────── SSRF-safe fetch for user supplied URLs ───────── */
export function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb');
}

// The guard runs inside the socket's DNS lookup, so it applies to the address actually connected to (no rebinding gap).
const guardedLookup = (hostname, opts, cb) => {
  dns.lookup(hostname, { all: true }).then((addrs) => {
    const ok = config.scrape.allowPrivate ? addrs : addrs.filter((a) => !isPrivateIp(a.address));
    if (!ok.length) return cb(new Error(`blocked address for ${hostname}`));
    if (opts?.all) return cb(null, ok);
    cb(null, ok[0].address, ok[0].family);
  }, cb);
};
const agent = new Agent({ connect: { lookup: guardedLookup, timeout: 10000 }, headersTimeout: 15000, bodyTimeout: 20000 });

export function assertPublicUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  if (u.username || u.password) throw new Error('URLs with credentials are not allowed');
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && !config.scrape.allowPrivate && isPrivateIp(u.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Blocked address');
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(u.hostname) && !config.scrape.allowPrivate) throw new Error('Blocked host');
  return u;
}

/** GET a page (html/xml/json) from any public URL: SSRF-guarded, redirect-validated, size-capped. */
export async function safeGet(url, { maxBytes = 2_500_000, timeoutMs = 15000, accept = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' } = {}) {
  let current = assertPublicUrl(url).href;
  for (let hop = 0; hop < 5; hop++) {
    const res = await undiciFetch(current, {
      dispatcher: agent, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { 'user-agent': UA, accept, 'accept-language': 'en' },
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = assertPublicUrl(new URL(res.headers.get('location'), current).href).href;
      continue;
    }
    if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
    const chunks = []; let size = 0;
    for await (const c of res.body) { size += c.length; if (size > maxBytes) break; chunks.push(c); }
    return { url: current, status: res.status, contentType: res.headers.get('content-type') || '', text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new Error('Too many redirects');
}

/* ───────── robots.txt (minimal, cached) ───────── */
const robotsCache = new Map();
export async function allowedByRobots(url) {
  const u = new URL(url);
  let rules = robotsCache.get(u.origin);
  if (!rules || Date.now() - rules.at > 3_600_000) {
    rules = { at: Date.now(), disallow: [], allow: [] };
    try {
      const { text } = await safeGet(`${u.origin}/robots.txt`, { maxBytes: 200_000, timeoutMs: 6000, accept: 'text/plain' });
      let applies = false, seenAgent = false;
      for (const raw of text.split('\n')) {
        const line = raw.split('#')[0].trim();
        const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
        if (!m) continue;
        const k = m[1].toLowerCase(), v = m[2].trim();
        if (k === 'user-agent') { if (!seenAgent) { applies = false; } seenAgent = true; if (v === '*' || /sherpa/i.test(v)) applies = true; }
        else { seenAgent = false; if (applies && k === 'disallow' && v) rules.disallow.push(v); if (applies && k === 'allow' && v) rules.allow.push(v); }
      }
    } catch { /* no robots.txt → allowed */ }
    robotsCache.set(u.origin, rules);
  }
  const path = u.pathname + u.search;
  const longest = (arr) => Math.max(-1, ...arr.filter((p) => path.startsWith(p.replace(/\*$/, ''))).map((p) => p.length));
  return longest(rules.allow) >= longest(rules.disallow);
}

/** Run async fn over items with a concurrency cap. */
export async function pool(items, limit, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx).catch((e) => ({ error: e })); }
  }));
  return out;
}
