import { LANGS, detectLang } from './i18n.js';

const $ = (s) => document.querySelector(s);
const thread = $('#thread');
const hero = $('#hero');
const input = $('#composer-input');
const sendBtn = $('#send-btn');
const summaryBtn = $('#summary-btn');
const newBtn = $('#new-btn');
const langSelect = $('#lang-select');
const rail = $('#rail');
const emergencyToggle = $('#emergency-toggle');

// Conversation lives only in memory — nothing is stored in the browser or on the server.
let history = [];
let busy = false;
let lang = detectLang();

function t(key) {
  return (LANGS[lang] && LANGS[lang].ui[key]) || LANGS.en.ui[key] || key;
}

function applyLang() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  input.placeholder = t('placeholder');
  const chips = $('#chips');
  chips.innerHTML = '';
  for (const c of (LANGS[lang] || LANGS.en).chips) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = c;
    b.addEventListener('click', () => { input.value = c; input.focus(); autosize(); });
    chips.appendChild(b);
  }
}

for (const [code, l] of Object.entries(LANGS)) {
  const o = document.createElement('option');
  o.value = code;
  o.textContent = l.name;
  langSelect.appendChild(o);
}
langSelect.value = lang;
langSelect.addEventListener('change', () => { lang = langSelect.value; applyLang(); });
applyLang();

emergencyToggle.addEventListener('click', () => {
  const open = rail.classList.toggle('open');
  emergencyToggle.setAttribute('aria-expanded', String(open));
});

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, window.innerHeight * 0.4) + 'px';
}
input.addEventListener('input', autosize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#composer').requestSubmit(); }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = '';
  autosize();
  ask(text, 'chat');
});

summaryBtn.addEventListener('click', () => {
  if (busy || history.length === 0) return;
  ask(null, 'summary');
});

newBtn.addEventListener('click', () => {
  if (busy) return;
  history = [];
  thread.querySelectorAll('.msg').forEach((m) => m.remove());
  hero.hidden = false;
  summaryBtn.hidden = true;
  newBtn.hidden = true;
  input.focus();
});

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function md(text) {
  const html = window.marked ? window.marked.parse(text, { breaks: false, gfm: true }) : `<p>${esc(text)}</p>`;
  return window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] }) : esc(text);
}

function scrollDown() { thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' }); }

function answerLanguage() {
  const name = LANGS[lang]?.name || 'English';
  return `${name} (${lang}) — but if the user's latest message is clearly written in a different language, answer in that language`;
}

async function ask(text, mode) {
  busy = true;
  sendBtn.disabled = true;
  hero.hidden = true;

  if (text) {
    history.push({ role: 'user', content: text });
    const u = el('div', 'msg msg-user');
    const b = el('div', 'bubble');
    b.textContent = text;
    u.appendChild(b);
    thread.appendChild(u);
  }
  const box = el('div', 'msg msg-bot');
  const prog = el('div', 'progress');
  const list = el('ol');
  prog.appendChild(list);
  box.appendChild(prog);
  thread.appendChild(box);
  scrollDown();

  const addStep = (s) => { list.appendChild(el('li', '', esc(s))); scrollDown(); };
  addStep(t('working') + '…');

  const payloadHistory = mode === 'summary' ? history : history;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: payloadHistory, lang: answerLanguage(), mode }),
    });
    if (!res.ok || !res.body) {
      let msg = t('error');
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let result = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(raw)?.[1];
        const data = /^data: (.+)$/m.exec(raw)?.[1];
        if (!ev || !data) continue;
        const d = JSON.parse(data);
        if (ev === 'progress' && d.step !== 'done') addStep(d.text);
        if (ev === 'warning') box.appendChild(el('div', 'warning', esc(d.text)));
        if (ev === 'error') throw new Error(d.error);
        if (ev === 'answer') result = d;
      }
    }
    if (!result) throw new Error(t('error'));
    prog.remove();
    renderAnswer(box, result, mode);
    // Store the answer so follow-up questions have context. The case-sheet request itself is not stored.
    history.push({ role: 'assistant', content: result.answer });
    summaryBtn.hidden = false;
    newBtn.hidden = false;
  } catch (err) {
    prog.remove();
    const e = el('div', 'err');
    e.innerHTML = `<strong>${esc(t('error'))}</strong><br>${esc(err.message)} `;
    if (text) {
      const r = el('button', 'btn-quiet', esc(t('retry')));
      r.type = 'button';
      r.addEventListener('click', () => { box.remove(); history.pop(); thread.lastElementChild?.classList.contains('msg-user') && thread.lastElementChild.remove(); ask(text, mode); });
      e.appendChild(r);
    }
    box.appendChild(e);
  } finally {
    busy = false;
    sendBtn.disabled = false;
    scrollDown();
  }
}

function renderAnswer(box, r, mode) {
  const doc = el('article', 'doc');
  doc.innerHTML = md(r.answer);
  doc.querySelectorAll('a[href^="http"]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });

  const v = r.verification || {};
  const nArticles = r.sources?.articles?.length || 0;
  const problems = (v.unverifiedCitations?.length || 0) > 0 || v.status === 'insufficient_evidence';
  const cls = problems ? 'warn' : v.status === 'fixed' ? 'fixed' : '';
  const label = problems ? t('checkedWarn') : v.status === 'fixed' ? t('checkedFix') : t('checked');

  const row = el('div', 'stamp-row');
  row.innerHTML = `
    <div class="stamp ${cls}" role="img" aria-label="${esc(label)}"><div><b>${problems ? '!' : '法'}</b>${esc(problems ? 'CHECK' : 'law.go.kr')}</div></div>
    <div class="stamp-text"><strong>${esc(label)}</strong>${nArticles} · ${esc(t('sources'))}${v.citationsChecked?.length ? ` — ${esc(v.citationsChecked.slice(0, 4).join(', '))}${v.citationsChecked.length > 4 ? '…' : ''}` : ''}</div>`;
  doc.appendChild(row);

  if (v.unverifiedCitations?.length) {
    doc.appendChild(el('div', 'unverified', `<strong>${esc(t('unverified'))}:</strong> ${esc(v.unverifiedCitations.join(', '))}`));
  }

  const src = r.sources || {};
  if ((src.articles?.length || 0) + (src.precedents?.length || 0) > 0) {
    const d = el('details', 'more');
    d.appendChild(el('summary', '', esc(t('sources'))));
    const ul = el('ul', 'sources');
    for (const a of src.articles || []) {
      ul.appendChild(el('li', '', `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.law)} ${esc(a.label)}${a.title ? ` (${esc(a.title)})` : ''}</a>${a.lawEffectiveDate ? ` <span>· 시행 ${esc(fmtDate(a.lawEffectiveDate))}</span>` : ''}<span class="ex" lang="ko">${esc(a.excerpt)}</span>`));
    }
    for (const p of src.precedents || []) {
      ul.appendChild(el('li', '', `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.court)} ${esc(fmtDate(p.date))} ${esc(p.caseNumber)}</a> <span lang="ko">${esc(p.caseName)}</span>`));
    }
    d.appendChild(ul);
    doc.appendChild(d);
  }

  if (v.issues?.length) {
    const d = el('details', 'more');
    d.appendChild(el('summary', '', `${esc(t('corrections'))} (${v.issues.length})`));
    const ul = el('ul', 'issues');
    for (const i of v.issues) ul.appendChild(el('li', '', `<strong>${esc(i.claim)}</strong> — ${esc(i.problem)}${i.fix ? ` → ${esc(i.fix)}` : ''}`));
    d.appendChild(ul);
    doc.appendChild(d);
  }

  const actions = el('div', 'doc-actions');
  const copy = el('button', 'btn-quiet', esc(t('copy')));
  copy.type = 'button';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(r.answer); copy.textContent = t('copied'); setTimeout(() => (copy.textContent = t('copy')), 1500); } catch {}
  });
  actions.appendChild(copy);
  const print = el('button', 'btn-quiet', esc(t('print')));
  print.type = 'button';
  print.addEventListener('click', () => {
    box.classList.add('print-target');
    document.body.classList.add('printing');
    window.print();
    setTimeout(() => { document.body.classList.remove('printing'); box.classList.remove('print-target'); }, 500);
  });
  actions.appendChild(print);
  doc.appendChild(actions);

  box.appendChild(doc);
  if (mode === 'summary') box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function fmtDate(d) {
  const s = String(d || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}.${s.slice(4, 6)}.${s.slice(6)}` : s;
}

// Tell the user early if the server is not configured.
fetch('/api/health').then((r) => r.json()).then((h) => {
  if (!h.aiReady || !h.lawOc) {
    const w = el('div', 'warning', esc(`Server setup incomplete: ${!h.aiReady ? 'ANTHROPIC_API_KEY ' : ''}${!h.lawOc ? 'LAW_OC ' : ''}missing in .env`));
    hero.appendChild(w);
  }
}).catch(() => {});
