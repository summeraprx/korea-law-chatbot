import * as law from './lawApi.js';
import { getProvider } from './llm.js';
import { ANSWER_SYSTEM, VERIFY_SYSTEM, CASE_SUMMARY_INSTRUCTION } from './prompts.js';
import { checkCitations } from './citations.js';

const MAX_TOOL_ROUNDS = 14;

const TOOLS = [
  {
    name: 'search_laws',
    description:
      'Search CURRENT Korean statutes, enforcement decrees and rules in the official law.go.kr database. Use Korean keywords. By default searches law titles (e.g. "출입국관리법"); set full_text=true to search inside article text (e.g. "체류기간 연장"). Returns law names with their mst id.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Korean search keywords' },
        full_text: { type: 'boolean', description: 'Search article text instead of titles' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_law_outline',
    description: 'Get the table of contents of one law: every article label and title. Use this to find the right article numbers before fetching them.',
    input_schema: {
      type: 'object',
      properties: { mst: { type: 'string', description: 'mst id from search_laws' } },
      required: ['mst'],
    },
  },
  {
    name: 'get_law_articles',
    description: 'Fetch the exact official text (all paragraphs/subparagraphs) of specific articles of one law. Only text fetched with this tool may be cited.',
    input_schema: {
      type: 'object',
      properties: {
        mst: { type: 'string', description: 'mst id from search_laws' },
        articles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Article numbers, e.g. ["17", "10의2", "94"]',
          maxItems: 15,
        },
      },
      required: ['mst', 'articles'],
    },
  },
  {
    name: 'search_precedents',
    description: 'Search Korean court precedents (판례) by Korean keywords. Returns case ids.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'get_precedent',
    description: 'Get the holding (판결요지), issues (판시사항) and referenced articles of one precedent.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'precedent id from search_precedents' } },
      required: ['id'],
    },
  },
];

/** Everything retrieved during one request. The verifier and citation check use only this. */
class Ledger {
  constructor() {
    this.articles = new Map(); // key "lawName|label"
    this.precedents = new Map();
  }
  addArticles(info, arts) {
    for (const a of arts) {
      this.articles.set(`${info.name}|${a.label}`, {
        law: info.name,
        lawEffectiveDate: info.effectiveDate,
        label: a.label,
        title: a.title,
        text: a.text,
        url: law.articleLink(info.name, a.label),
      });
    }
  }
  addPrecedent(p) {
    this.precedents.set(p.id, { ...p, url: `https://www.law.go.kr/precInfoP.do?precSeq=${encodeURIComponent(p.id)}` });
  }
  toEvidenceText() {
    const parts = [];
    for (const a of this.articles.values()) {
      parts.push(`### ${a.law} ${a.label}${a.title ? ` (${a.title})` : ''} — law effective ${a.lawEffectiveDate || 'n/a'}\n${a.text}`);
    }
    for (const p of this.precedents.values()) {
      parts.push(`### Precedent ${p.court} ${p.date} ${p.caseNumber} ${p.caseName}\n판시사항: ${p.issues}\n판결요지: ${p.holding}\n참조조문: ${p.referencedArticles}`);
    }
    return parts.join('\n\n') || '(no evidence was retrieved)';
  }
  sources() {
    return {
      articles: [...this.articles.values()].map(({ text, ...rest }) => ({ ...rest, excerpt: text.slice(0, 600) })),
      precedents: [...this.precedents.values()].map((p) => ({
        id: p.id, court: p.court, date: p.date, caseNumber: p.caseNumber, caseName: p.caseName, url: p.url,
      })),
    };
  }
}

async function runTool(name, input, ledger) {
  switch (name) {
    case 'search_laws': {
      const r = await law.searchLaws(input.query, { fullText: !!input.full_text });
      return r.length ? r : { results: [], note: 'No match. Try a different Korean keyword, the full official title, or full_text=true.' };
    }
    case 'get_law_outline': {
      const l = await law.getLaw(input.mst);
      return {
        law: l.info.name,
        effectiveDate: l.info.effectiveDate,
        articles: l.articles.map((a) => `${a.label}${a.title ? ` ${a.title}` : ''}`),
      };
    }
    case 'get_law_articles': {
      const l = await law.getLaw(input.mst);
      const { found, missing } = law.pickArticles(l, input.articles || []);
      ledger.addArticles(l.info, found);
      return {
        law: l.info.name,
        effectiveDate: l.info.effectiveDate,
        articles: found.map((a) => ({ label: a.label, title: a.title, text: a.text })),
        notFound: missing,
      };
    }
    case 'search_precedents': {
      const r = await law.searchPrecedents(input.query);
      return r.length ? r : { results: [], note: 'No precedents found.' };
    }
    case 'get_precedent': {
      const p = await law.getPrecedent(input.id);
      ledger.addPrecedent(p);
      return p;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

const PROGRESS = {
  search_laws: (i) => `Searching Korean law: ${i.query}`,
  get_law_outline: () => 'Reading the law’s table of contents',
  get_law_articles: (i) => `Reading articles ${(i.articles || []).join(', ')}`,
  search_precedents: (i) => `Searching court precedents: ${i.query}`,
  get_precedent: () => 'Reading a court precedent',
};

function textOf(content) {
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

/**
 * history: [{role:'user'|'assistant', content:string}]
 * onEvent: (type, data) => void   — progress events for the UI
 */
export async function answer({ history, lang = 'auto', mode = 'chat', onEvent = () => {} }) {
  const ledger = new Ledger();
  const system = ANSWER_SYSTEM.replace('{{TODAY}}', new Date().toISOString().slice(0, 10)).replace('{{LANG}}', lang) +
    '\n\nRe-fetch (with get_law_articles) every article you cite in this answer, even if it was discussed earlier in the conversation.';

  const ai = getProvider();
  const turns = history.map((m) => ({ role: m.role, content: String(m.content).slice(0, 12000) }));
  if (mode === 'summary') turns.push({ role: 'user', content: CASE_SUMMARY_INSTRUCTION });
  const state = ai.start(system, turns);

  // ---- 1. Research + draft (tool loop) ----
  onEvent('progress', { step: 'thinking', text: 'Understanding your situation' });
  let draft = '';
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const { text, calls } = await ai.step(state, TOOLS, { allowTools: round < MAX_TOOL_ROUNDS });
    if (calls.length === 0) {
      draft = text;
      break;
    }
    const results = [];
    for (const c of calls) {
      onEvent('progress', { step: c.name, text: (PROGRESS[c.name] || (() => c.name))(c.input || {}) });
      try {
        const out = await runTool(c.name, c.input || {}, ledger);
        results.push({ id: c.id, name: c.name, content: JSON.stringify(out).slice(0, ai.maxToolChars) });
      } catch (e) {
        results.push({ id: c.id, name: c.name, isError: true, content: String(e.message || e) });
        if (e instanceof law.LawApiError && /LAW_OC|did not return JSON/.test(e.message)) {
          onEvent('warning', { text: e.message });
        }
      }
    }
    ai.addToolResults(state, results);
  }
  if (!draft) throw new Error('The assistant could not finish an answer. Please try again.');

  // ---- 2. Independent verification against the retrieved evidence ----
  onEvent('progress', { step: 'verify', text: 'Double-checking every legal statement against the official text' });
  const lastUser = mode === 'summary'
    ? `${history.filter((m) => m.role === 'user').map((m) => m.content).join('\n---\n')}\n\n[Task] ${CASE_SUMMARY_INSTRUCTION}`
    : [...history].reverse().find((m) => m.role === 'user')?.content || '';
  const verification = await verify(ai, { question: lastUser, evidence: ledger.toEvidenceText(), draft });

  let final = verification.final_answer?.trim() || draft;

  // ---- 3. Mechanical citation check: every "법 제N조" must be in the ledger ----
  const citations = checkCitations(final, ledger);

  onEvent('progress', { step: 'done', text: 'Checked' });
  return {
    answer: final,
    verification: {
      status: verification.status,
      issues: verification.issues || [],
      citationsChecked: citations.checked,
      unverifiedCitations: citations.unverified,
    },
    sources: ledger.sources(),
  };
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['pass', 'fixed', 'insufficient_evidence'],
      description: 'pass = no problems; fixed = problems corrected; insufficient_evidence = key claims could not be verified',
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: { type: 'string' }, problem: { type: 'string' }, fix: { type: 'string' } },
        required: ['claim', 'problem', 'fix'],
      },
    },
    final_answer: { type: 'string', description: 'Full corrected answer in Markdown, same language as the draft' },
  },
  required: ['status', 'issues', 'final_answer'],
};

async function verify(ai, { question, evidence, draft }) {
  try {
    const out = await ai.structured({
      name: 'submit_verification',
      system: VERIFY_SYSTEM,
      schema: VERIFY_SCHEMA,
      user: `<question>\n${question}\n</question>\n\n<evidence>\n${evidence}\n</evidence>\n\n<draft>\n${draft}\n</draft>`,
    });
    if (!out || typeof out.final_answer !== 'string') throw new Error('bad verifier output');
    return out;
  } catch (e) {
    console.error('verification failed:', e.message);
    return {
      status: 'insufficient_evidence',
      issues: [{ claim: '-', problem: 'The checking step could not run', fix: 'Showing the unchecked draft with a warning' }],
      final_answer: draft,
    };
  }
}
