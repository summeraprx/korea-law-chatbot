// Client for the Korean government's National Law Information Center Open API
// (국가법령정보센터 Open API, https://open.law.go.kr).
//
// Every legal text the chatbot shows comes from here — never from the model's memory.
// The API returns slightly different shapes (single object vs array, nested 항/호/목),
// so all parsing below is defensive.

const BASE = process.env.LAW_API_BASE || 'https://www.law.go.kr/DRF';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // laws change rarely; 6h cache keeps us current and fast
const cache = new Map();

export class LawApiError extends Error {}

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

function clean(text) {
  if (text === undefined || text === null) return '';
  if (Array.isArray(text)) return text.map(clean).filter(Boolean).join('\n');
  if (typeof text === 'object') return '';
  return String(text)
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

async function call(endpoint, params) {
  const oc = process.env.LAW_OC;
  if (!oc) throw new LawApiError('LAW_OC is not set. Add your law.go.kr Open API ID to .env');
  const url = new URL(`${BASE}/${endpoint}`);
  url.searchParams.set('OC', oc);
  url.searchParams.set('type', 'JSON');
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const res = await fetch(url, { headers: { 'User-Agent': 'KoreaLawHelper/1.0' }, signal: AbortSignal.timeout(20000) });
  const body = await res.text();
  if (!res.ok) throw new LawApiError(`law.go.kr returned HTTP ${res.status}`);
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    // Wrong OC / unregistered server IP returns an HTML page instead of JSON.
    throw new LawApiError(
      'law.go.kr did not return JSON. Check that LAW_OC is correct and that this server\'s IP/domain is registered at open.law.go.kr.'
    );
  }
  cache.set(key, { at: Date.now(), data });
  return data;
}

export function lawLink(name) {
  return `https://www.law.go.kr/법령/${encodeURIComponent(name)}`;
}

export function articleLink(name, label) {
  // e.g. https://www.law.go.kr/법령/출입국관리법/제17조
  return `https://www.law.go.kr/법령/${encodeURIComponent(name)}/${encodeURIComponent(label)}`;
}

/** Search current laws. fullText=true searches inside article text instead of titles. */
export async function searchLaws(query, { fullText = false, display = 10 } = {}) {
  const data = await call('lawSearch.do', { target: 'law', query, search: fullText ? 2 : 1, display });
  const root = data.LawSearch || data;
  return asArray(root.law).map((l) => ({
    mst: clean(l['법령일련번호']),
    lawId: clean(l['법령ID']),
    name: clean(l['법령명한글']),
    type: clean(l['법령구분명']),
    ministry: clean(l['소관부처명']),
    effectiveDate: clean(l['시행일자']),
    promulgationDate: clean(l['공포일자']),
  })).filter((l) => l.name && (l.mst || l.lawId));
}

/** Label like 제17조 or 제10조의2 */
export function articleLabel(num, branch) {
  const b = branch && String(branch) !== '0' ? `의${branch}` : '';
  return `제${num}조${b}`;
}

/** Turns one 조문단위 into readable text, including every 항 / 호 / 목 underneath. */
export function flattenArticle(unit) {
  const lines = [];
  const head = clean(unit['조문내용']);
  if (head) lines.push(head);
  for (const hang of asArray(unit['항'])) {
    const ht = clean(hang['항내용']);
    if (ht) lines.push(ht);
    for (const ho of asArray(hang['호'])) {
      const t = clean(ho['호내용']);
      if (t) lines.push('  ' + t);
      for (const mok of asArray(ho['목'])) {
        const mt = clean(mok['목내용']);
        if (mt) lines.push('    ' + mt);
      }
    }
  }
  return lines.join('\n');
}

/** Parses a lawService.do response into { info, articles[] }. Exported for tests. */
export function parseLawBody(data) {
  const law = data['법령'] || data.Law || data;
  const info = law['기본정보'] || {};
  const name = clean(info['법령명_한글'] || info['법령명한글'] || law['법령명_한글']);
  const units = asArray(law['조문'] && law['조문']['조문단위']);
  const articles = [];
  for (const u of units) {
    if (clean(u['조문여부']) && clean(u['조문여부']) !== '조문') continue; // skip chapter headings (전문)
    const num = clean(u['조문번호']);
    if (!num) continue;
    const branch = clean(u['조문가지번호']);
    articles.push({
      num,
      branch: branch && branch !== '0' ? branch : '',
      label: articleLabel(num, branch),
      title: clean(u['조문제목']),
      effectiveDate: clean(u['조문시행일자']),
      text: flattenArticle(u),
    });
  }
  return {
    info: {
      name,
      lawId: clean(info['법령ID']),
      effectiveDate: clean(info['시행일자']),
      promulgationDate: clean(info['공포일자']),
      ministry: clean(typeof info['소관부처'] === 'object' ? info['소관부처'].content : info['소관부처']),
    },
    articles,
  };
}

export async function getLaw(mst) {
  const data = await call('lawService.do', { target: 'law', MST: mst });
  const parsed = parseLawBody(data);
  if (!parsed.info.name && parsed.articles.length === 0) {
    throw new LawApiError(`No law found for MST ${mst}`);
  }
  return parsed;
}

/** Normalizes "17", "제17조", "10의2", "제10조의2" → { num, branch } */
export function parseArticleRef(ref) {
  const m = String(ref).replace(/\s/g, '').match(/^(?:제)?(\d+)(?:조)?(?:의(\d+))?$/);
  if (!m) return null;
  return { num: m[1], branch: m[2] || '' };
}

export function pickArticles(law, refs) {
  const out = [];
  const missing = [];
  for (const ref of refs) {
    const p = parseArticleRef(ref);
    const a = p && law.articles.find((x) => x.num === p.num && x.branch === p.branch);
    if (a) out.push(a); else missing.push(String(ref));
  }
  return { found: out, missing };
}

export async function searchPrecedents(query, { display = 8 } = {}) {
  const data = await call('lawSearch.do', { target: 'prec', query, display });
  const root = data.PrecSearch || data;
  return asArray(root.prec).map((p) => ({
    id: clean(p['판례일련번호']),
    caseName: clean(p['사건명']),
    caseNumber: clean(p['사건번호']),
    date: clean(p['선고일자']),
    court: clean(p['법원명']),
    kind: clean(p['판결유형']),
  })).filter((p) => p.id);
}

export async function getPrecedent(id) {
  const data = await call('lawService.do', { target: 'prec', ID: id });
  const p = data.PrecService || data;
  const full = clean(p['판례내용']);
  return {
    id,
    caseName: clean(p['사건명']),
    caseNumber: clean(p['사건번호']),
    date: clean(p['선고일자']),
    court: clean(p['법원명']),
    issues: clean(p['판시사항']),
    holding: clean(p['판결요지']),
    referencedArticles: clean(p['참조조문']),
    referencedCases: clean(p['참조판례']),
    excerpt: full.length > 4000 ? full.slice(0, 4000) + ' …(truncated)' : full,
  };
}
