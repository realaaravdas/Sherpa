import { config } from './config.js';
import { validateSession, hit } from './security.js';

export const COOKIE = config.cookieSecure ? '__Host-sherpa' : 'sherpa_session';

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
export function setSessionCookie(res, token, expires) {
  res.cookie(COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/', expires });
}
export const clearSessionCookie = (res) => res.clearCookie(COOKIE, { httpOnly: true, secure: config.cookieSecure, sameSite: 'lax', path: '/' });

export function securityHeaders(req, res, next) {
  res.set({
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  if (config.cookieSecure) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

/** CSRF defence in depth: SameSite=Lax cookie + same-origin check + JSON-only bodies on writes. */
export function csrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let ok = false;
    try { ok = new URL(origin).host === req.get('host'); } catch { /* bad origin */ }
    if (!ok) return res.status(403).json({ error: 'Cross-origin request blocked' });
  }
  if (req.headers['content-length'] !== '0' && req.headers['content-length'] !== undefined && !req.is('application/json'))
    return res.status(415).json({ error: 'JSON required' });
  next();
}

export function loadUser(req, res, next) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  const s = token && validateSession(token);
  if (s) {
    req.user = s; req.token = token;
    if (s.refreshed) setSessionCookie(res, token, s.refreshed);
  } else if (token) clearSessionCookie(res);
  next();
}
export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in' });
  next();
}
export const limit = (name, max, windowMs, by = 'user') => (req, res, next) => {
  const id = by === 'ip' ? req.ip : (req.user?.userId || req.ip);
  if (!hit(`${name}:${id}`, max, windowMs)) return res.status(429).json({ error: 'Too many requests — slow down and try again shortly.' });
  next();
};
