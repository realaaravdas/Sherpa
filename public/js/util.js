// Make Element.append ignore null/undefined/false so conditional children (`cond && node`) never render as the text "null"/"false".
const nativeAppend = Element.prototype.append;
Element.prototype.append = function (...kids) { return nativeAppend.apply(this, kids.flat(Infinity).filter((k) => k != null && k !== false && k !== '')); };

// Tiny DOM + API helpers. Everything is built with textContent/DOM nodes, never innerHTML, so job/AI text can't inject markup.
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => { if (c == null || c === false) return; if (Array.isArray(c)) c.forEach(add); else el.append(c instanceof Node ? c : document.createTextNode(String(c))); };
  kids.forEach(add);
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const clear = (el) => { while (el.firstChild) el.firstChild.remove(); return el; };

export class ApiError extends Error { constructor(m, status, data) { super(m); this.status = status; this.data = data; } }
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : await res.text();
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('sherpa:signed-out'));
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data);
  }
  return data;
}
export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null && v !== false)).toString();

export function toast(msg, bad = false) {
  const t = h('div', { class: `toast${bad ? ' bad' : ''}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3500);
}
export const fail = (e) => toast(e.message || 'Something went wrong', true);

export function modal(title, bodyFn, { footer, wide } = {}) {
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => e.key === 'Escape' && close();
  const body = h('div', { class: 'body' });
  const box = h('div', { class: 'modal', style: wide ? { width: 'min(980px,100%)' } : null, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('header', h('h2', { class: 'grow' }, title), h('button', { class: 'btn ghost sm', onclick: close, 'aria-label': 'Close' }, '✕')), body);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => e.target === overlay && close() }, box);
  document.body.append(overlay); document.addEventListener('keydown', onKey);
  const api_ = { close, body, box, setFooter(nodes) { box.querySelector('footer')?.remove(); box.append(h('footer', nodes)); } };
  bodyFn(body, api_);
  if (footer) api_.setFooter(footer(api_));
  return api_;
}

export function busy(btn, fn) {
  return async (...a) => {
    const old = btn.textContent; btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), ' Working…');
    try { return await fn(...a); } catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = old; }
  };
}

export const money = (n, cur = 'USD') => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur, maximumFractionDigits: 0, notation: n >= 100000 ? 'compact' : 'standard' }).format(n); } catch { return `${n}`; } };
export const salaryText = (s) => (s ? `${money(s.min, s.currency)}${s.max && s.max !== s.min ? ` – ${money(s.max, s.currency)}` : ''}` : '');
export function ago(t) {
  if (!t) return '';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d <= 0) { const hrs = Math.floor((Date.now() - t) / 3600000); return hrs <= 0 ? 'just now' : `${hrs}h ago`; }
  return d === 1 ? 'yesterday' : d < 30 ? `${d}d ago` : d < 365 ? `${Math.floor(d / 30)}mo ago` : `${Math.floor(d / 365)}y ago`;
}
export const dateInput = (t) => (t ? new Date(t).toISOString().slice(0, 10) : '');
export const fromDateInput = (v) => (v ? Date.parse(`${v}T12:00:00Z`) : null);
export const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
export const REMOTE = ['', 'Hybrid', 'Remote'];
export const STATUS_LABEL = { saved: 'Saved', applied: 'Applied', screening: 'Screening', interview: 'Interview', offer: 'Offer', accepted: 'Accepted', rejected: 'Rejected', withdrawn: 'Withdrawn' };
export const STATUS_TONE = { saved: '', applied: 'info', screening: 'accent', interview: 'warn', offer: 'good', accepted: 'good', rejected: 'bad', withdrawn: '' };

export function field(label, input) { return h('label', label, input); }
export function copy(text) { navigator.clipboard?.writeText(text).then(() => toast('Copied'), () => toast('Copy failed', true)); }
export function download(name, text, type = 'text/plain') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }); document.body.append(a); a.click(); a.remove();
}
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export function ring(score) {
  const c = score >= 75 ? 'var(--good)' : score >= 50 ? 'var(--accent)' : score >= 30 ? 'var(--warn)' : 'var(--muted)';
  return h('div', { class: 'ring', style: { '--p': score, '--c': c }, title: `${score}% match` }, h('span', score));
}
