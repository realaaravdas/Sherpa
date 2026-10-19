import { h, api, clear, fail, busy } from './util.js';

const STARTERS = ['What should I focus on this week?', 'How can I improve my response rate?', 'Help me answer “Tell me about yourself”', 'Which of my applications should I follow up on?', 'How do I negotiate an offer?'];

export async function coachView(root) {
  let convId = null;
  const msgs = h('div', { class: 'msgs' });
  const input = h('textarea', { rows: 2, placeholder: 'Ask your career coach anything…', style: { minHeight: '52px' }, onkeydown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.click(); } } });
  const send = h('button', { class: 'btn primary' }, 'Send');
  const bubble = (role, text) => { const m = h('div', { class: `msg ${role}` }, text); msgs.append(m); msgs.scrollTop = msgs.scrollHeight; return m; };

  send.onclick = async () => {
    const text = input.value.trim(); if (!text) return;
    input.value = ''; bubble('user', text);
    const wait = bubble('assistant', '…'); send.disabled = true;
    try {
      const r = await api('/ai/chat', { method: 'POST', body: { message: text, conversationId: convId } });
      convId = r.conversationId; wait.textContent = r.reply;
    } catch (e) { wait.remove(); fail(e); } finally { send.disabled = false; msgs.scrollTop = msgs.scrollHeight; }
  };

  const hist = h('select', { onchange: (e) => load(e.target.value) });
  let chats = [];
  async function refreshHist() {
    ({ chats } = await api('/ai/chats'));
    clear(hist).append(h('option', { value: '' }, 'New conversation'), chats.map((c) => h('option', { value: c.id, selected: c.id === convId }, c.title)));
  }
  function load(id) {
    convId = id || null; clear(msgs);
    const c = chats.find((x) => x.id === id);
    if (!c) return intro();
    c.messages.forEach((m) => bubble(m.role, m.content));
  }
  function intro() {
    msgs.append(h('div', { class: 'card' }, h('h2', 'Your career coach'), h('p', { class: 'muted' }, 'I know your profile and your pipeline. Ask about strategy, interviews, negotiation, or how to position yourself.'),
      h('div', { class: 'sugg' }, STARTERS.map((s) => h('button', { class: 'chip', onclick: () => { input.value = s; send.click(); } }, s)))));
  }
  const del = h('button', { class: 'btn sm danger' }, 'Delete');
  del.onclick = busy(del, async () => { if (convId) { await api(`/ai/chats/${convId}`, { method: 'DELETE' }); convId = null; await refreshHist(); load(''); } });

  root.append(h('div', { class: 'topbar' }, h('h1', 'Coach'), h('div', { class: 'grow' }), h('div', { style: { minWidth: '220px' } }, hist), del),
    h('div', { class: 'chat card' }, msgs, h('div', { class: 'row', style: { flexWrap: 'nowrap', alignItems: 'flex-end' } }, h('div', { class: 'grow' }, input), send)));
  await refreshHist(); intro();
}
