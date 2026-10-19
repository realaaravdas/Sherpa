import { h, api, clear, copy } from './util.js';

export function authScreen(root, onDone) {
  clear(root);
  let mode = 'login';
  const card = h('div', { class: 'card' });
  root.append(h('div', { class: 'auth' }, card));

  const render = () => {
    clear(card);
    const email = h('input', { type: 'email', autocomplete: 'username', required: true, placeholder: 'you@example.com', autofocus: true });
    const pw = h('input', { type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true, minlength: mode === 'login' ? 1 : 10 });
    const code = h('input', { placeholder: 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX', autocomplete: 'off' });
    const err = h('div', { class: 'err' });
    const submit = h('button', { class: 'btn primary', type: 'submit', style: { justifyContent: 'center' } }, mode === 'login' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Reset password');
    const form = h('form', { class: 'stack', onsubmit: async (e) => {
      e.preventDefault(); err.textContent = ''; submit.disabled = true;
      try {
        const body = { email: email.value, password: pw.value };
        if (mode === 'recover') { body.recoveryCode = code.value; body.newPassword = pw.value; delete body.password; }
        const r = await api(`/auth/${mode === 'recover' ? 'recover' : mode}`, { method: 'POST', body });
        if (r.recoveryCode) showRecovery(r.recoveryCode, () => onDone(r.user)); else onDone(r.user);
      } catch (ex) { err.textContent = ex.message; submit.disabled = false; }
    } },
    h('label', 'Email', email),
    mode === 'recover' && h('label', 'Recovery code', code),
    h('label', mode === 'recover' ? 'New password' : 'Password', pw),
    mode !== 'login' && h('div', { class: 'tiny muted' }, 'At least 10 characters. A passphrase works great.'),
    err, submit);

    card.append(
      h('div', { class: 'row' }, h('div', { class: 'logo' }, '⛰️'), h('b', { style: { fontSize: '1.2rem' } }, 'Sherpa')),
      h('h1', mode === 'login' ? 'Welcome back' : mode === 'register' ? 'Start your search' : 'Recover your account'),
      mode === 'register' && h('div', { class: 'hero-points' }, h('div', '🔍 Fresh jobs scraped from 60+ company boards & job sites'), h('div', '🎯 Matches ranked against your resume, with reasons'), h('div', '📋 A pipeline that keeps every application organised'), h('div', '🔒 Your data is encrypted with a key only your password unlocks')),
      form,
      h('div', { class: 'row small', style: { marginTop: '1rem' } },
        mode !== 'login' && h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = 'login'; render(); } }, 'Sign in'),
        mode !== 'register' && h('a', { href: '#', onclick: (e) => { e.preventDefault(); mode = 'register'; render(); } }, 'Create account'),
        mode === 'login' && h('a', { class: 'right', href: '#', onclick: (e) => { e.preventDefault(); mode = 'recover'; render(); } }, 'Forgot password?')));
  };

  function showRecovery(rc, done) {
    clear(card);
    const ok = h('input', { type: 'checkbox' });
    const btn = h('button', { class: 'btn primary', disabled: true, onclick: done }, 'Continue');
    ok.addEventListener('change', () => { btn.disabled = !ok.checked; });
    card.append(h('h1', 'Save your recovery code'),
      h('p', { class: 'muted' }, 'Your data is encrypted with a key derived from your password. If you forget it, this code is the only way back in — we can’t reset it for you.'),
      h('div', { class: 'recovery' }, rc),
      h('div', { class: 'row', style: { margin: '.8rem 0' } }, h('button', { class: 'btn sm', onclick: () => copy(rc) }, 'Copy'), h('button', { class: 'btn sm', onclick: () => window.print() }, 'Print')),
      h('label', { class: 'check' }, ok, 'I’ve stored it somewhere safe'), h('div', { style: { marginTop: '1rem' } }, btn));
  }
  render();
}
