// NVIDIA NIM client (OpenAI-compatible API at integrate.api.nvidia.com).
import { config } from './config.js';

export class NimError extends Error { constructor(msg, status) { super(msg); this.status = status; } }

/* ───── model resolution ─────
 * NVIDIA rotates its hosted catalogue. If the configured model has been retired we pick the first
 * available entry from a preference list instead of failing every AI request. */
const CHAT_FALLBACKS = ['nvidia/llama-3.1-nemotron-70b-instruct', 'meta/llama-3.3-70b-instruct', 'meta/llama-3.1-70b-instruct', 'mistralai/mistral-large-2-instruct', 'nvidia/llama-3.1-nemotron-ultra-253b-v1', 'mistralai/mixtral-8x22b-instruct-v0.1'];
const EMBED_FALLBACKS = ['nvidia/llama-3.2-nv-embedqa-1b-v1', 'nvidia/nv-embedqa-e5-v5', 'nvidia/nv-embedqa-mistral-7b-v2', 'nvidia/embed-qa-4'];
let catalog = { ids: null, at: 0 };
async function loadCatalog() {
  if (catalog.ids && Date.now() - catalog.at < 3_600_000) return catalog.ids;
  try {
    const res = await fetch(`${config.nim.baseUrl}/models`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) catalog = { ids: new Set((await res.json()).data.map((m) => m.id)), at: Date.now() };
  } catch { catalog.at = Date.now() - 3_000_000; /* retry in ~10 min; meanwhile trust the configured name */ }
  return catalog.ids;
}
const warned = new Set();
export async function resolveModel(kind) {
  const wanted = kind === 'embed' ? config.nim.embedModel : config.nim.chatModel;
  const ids = await loadCatalog();
  if (!ids || ids.has(wanted)) return wanted;
  const alt = (kind === 'embed' ? EMBED_FALLBACKS : CHAT_FALLBACKS).find((m) => ids.has(m));
  if (alt && !warned.has(wanted)) { warned.add(wanted); console.warn(`[nim] model "${wanted}" is not in the NVIDIA catalogue; using "${alt}"`); }
  return alt || wanted;
}

const keyFor = (userKey) => userKey || config.nim.apiKey;
export const nimAvailable = (userKey) => !!keyFor(userKey);

async function call(path, body, { userKey, timeoutMs = config.nim.timeoutMs, retries = 2 } = {}) {
  const key = keyFor(userKey);
  if (!key) throw new NimError('AI is not configured. Add an NVIDIA API key in Settings (or set NVIDIA_API_KEY on the server).', 503);
  let last;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${config.nim.baseUrl}${path}`, {
        method: 'POST', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) return await res.json();
      const txt = (await res.text()).slice(0, 300);
      if (res.status === 401 || res.status === 403) throw Object.assign(new NimError('The NVIDIA API key was rejected.', 502), { fatal: true });
      if (res.status === 429 || res.status >= 500) { last = new NimError(`NVIDIA NIM busy (${res.status})`, 503); await new Promise((r) => setTimeout(r, 1000 * 2 ** i)); continue; }
      throw Object.assign(new NimError(`NVIDIA NIM error ${res.status}: ${txt}`, 502), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;
      last = e instanceof NimError ? e : new NimError(`NVIDIA NIM request failed: ${e.message}`, 502);
      if (i < retries) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

/** messages: [{role, content}] → string */
export async function chat(messages, { userKey, temperature = 0.4, maxTokens = 1800, model } = {}) {
  const d = await call('/chat/completions', { model: model || await resolveModel('chat'), messages, temperature, top_p: 0.9, max_tokens: maxTokens, stream: false }, { userKey });
  return (d.choices?.[0]?.message?.content || '').trim();
}

/** Tolerant JSON extraction: models wrap JSON in prose/fences. */
export function parseJson(text) {
  const t = String(text).replace(/```(?:json)?/gi, '');
  const start = t.search(/[\[{]/);
  if (start < 0) throw new NimError('The AI did not return structured data. Try again.', 502);
  for (let end = t.length; end > start; end = t.lastIndexOf(t[start] === '{' ? '}' : ']', end - 1) + 1) {
    if (end <= 0) break;
    try { return JSON.parse(t.slice(start, end)); } catch { /* shrink */ }
  }
  throw new NimError('The AI returned malformed JSON. Try again.', 502);
}

export async function chatJson(messages, opts = {}) {
  const msgs = [...messages];
  msgs[0] = { ...msgs[0], content: `${msgs[0].content}\n\nRespond with ONLY valid JSON. No commentary, no markdown fences.` };
  return parseJson(await chat(msgs, { temperature: 0.2, ...opts }));
}

/** Embeddings (asymmetric model: use type 'query' for profiles/queries and 'passage' for jobs). */
export async function embed(texts, { type = 'passage', userKey } = {}) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const d = await call('/embeddings', { model: await resolveModel('embed'), input: texts.slice(i, i + 32).map((t) => t.slice(0, 6000)), input_type: type, encoding_format: 'float', truncate: 'END' }, { userKey });
    for (const row of d.data.sort((a, b) => a.index - b.index)) out.push(Float32Array.from(row.embedding));
  }
  return out;
}
export const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
export const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
export function cosine(a, b) {
  if (a.length !== b.length) return null; // vectors from different embedding models are not comparable
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? d / Math.sqrt(na * nb) : 0;
}
