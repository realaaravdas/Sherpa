import { h, $, api, clear, toast } from './util.js';
import { authScreen } from './auth.js';
import { discoverView } from './discover.js';
import { pipelineView } from './pipeline.js';
import { coachView } from './coach.js';
import { profileView, documentsView, settingsView } from './profile.js';

const app = $('#app');
let me = null;
export const state = { aiAvailable: false };

const ROUTES = {
  discover: ['🔍', 'Discover', discoverView],
  pipeline: ['📋', 'Pipeline', pipelineView],
  coach: ['💬', 'Coach', coachView],
  documents: ['📄', 'Documents', documentsView],
  profile: ['👤', 'Profile', profileView],
  settings: ['⚙️', 'Settings', settingsView],
};

async function boot() {
  try { ({ user: me } = await api('/auth/me')); } catch { me = null; }
  me ? shell() : authScreen(app, async (user) => { me = user; shell(); });
}

function shell() {
  clear(app);
  const view = h('main');
  const nav = h('nav', { class: 'nav' }, Object.entries(ROUTES).map(([k, [icon, label]]) => h('a', { href: `#/${k}`, 'data-k': k }, h('span', icon), label)));
  app.append(h('div', { class: 'shell' },
    h('aside', { class: 'side' },
      h('div', { class: 'brand' }, h('div', { class: 'logo' }, svgLogo()), 'Sherpa'), nav, h('div', { class: 'spacer grow' }),
      h('div', { class: 'small muted', style: { padding: '.5rem' } }, me.email)), view));
  const go = () => {
    const k = (location.hash.match(/^#\/(\w+)/) || [])[1];
    const key = ROUTES[k] ? k : 'discover';
    nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.k === key));
    clear(view);
    ROUTES[key][2](view, { me, state, navigate: (r) => { location.hash = `#/${r}`; } }).catch?.((e) => view.append(h('p', { class: 'err' }, e.message)));
  };
  window.onhashchange = go;
  go();
}

const svgLogo = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 32 32'); s.setAttribute('width', '20'); s.setAttribute('height', '20'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M5 25l8-14 4 7 3-4 7 11z'); p.setAttribute('fill', '#fff'); s.append(p); return s; };

window.addEventListener('sherpa:signed-out', () => { if (me) { me = null; toast('Your session expired — please sign in again', true); boot(); } });
boot();
