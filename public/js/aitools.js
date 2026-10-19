import { h, api, modal, copy, download } from './util.js';

const ref = (x) => (x.applicationId ? { applicationId: x.applicationId } : { jobId: x.id });
const docView = (title, text) => modal(title, (b) => {
  b.append(h('pre', { style: { whiteSpace: 'pre-wrap', font: 'inherit', margin: 0 } }, text));
}, { footer: () => [h('button', { class: 'btn', onclick: () => copy(text) }, 'Copy'), h('button', { class: 'btn', onclick: () => download(`${title.slice(0, 40)}.txt`, text) }, 'Download'), h('span', { class: 'tiny muted' }, 'Saved in Documents')] });

const list = (items) => h('ul', (items || []).map((i) => h('li', String(i))));

export const aiTool = {
  async fit(x) {
    const { fit } = await api('/ai/fit', { method: 'POST', body: ref(x) });
    const tone = { strong: 'good', good: 'good', stretch: 'warn', weak: 'bad' }[fit.verdict] || '';
    modal(`Fit: ${x.title}`, (b) => b.append(
      h('div', { class: 'row' }, h('span', { class: `badge ${tone}` }, String(fit.verdict || '').toUpperCase()), h('span', fit.summary)),
      h('h3', { style: { marginTop: '1rem' } }, 'Strengths'), list(fit.strengths), h('h3', 'Gaps'), list(fit.gaps),
      fit.keywordsToAdd?.length ? [h('h3', 'Keywords to reflect (if true)'), h('div', { class: 'row' }, fit.keywordsToAdd.map((k) => h('span', { class: 'tag' }, k)))] : null,
      fit.redFlags?.length ? [h('h3', 'Watch-outs'), list(fit.redFlags)] : null, h('h3', 'Next step'), h('p', fit.nextStep)));
  },
  async cover(x) {
    const { document: d } = await api('/ai/cover-letter', { method: 'POST', body: { ...ref(x), tone: 'professional' } });
    docView(d.title, d.content);
  },
  async tailor(x) { const { document: d } = await api('/ai/tailor-resume', { method: 'POST', body: ref(x) }); docView(d.title, d.content); },
  async prep(x) { const { document: d } = await api('/ai/interview-prep', { method: 'POST', body: ref(x) }); docView(d.title, d.content); },
  async followUp(x) { const { text } = await api('/ai/follow-up', { method: 'POST', body: ref(x) }); docView('Follow-up email', text); },
};
