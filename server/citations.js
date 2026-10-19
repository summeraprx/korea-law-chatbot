// Mechanical safety net after the AI verifier: finds every Korean-style citation
// ("출입국관리법 제17조", "형법 제260조의2") in the final answer and confirms that exact
// law + article was actually fetched from law.go.kr during this request.

const CITE_RE = /([가-힣][가-힣·ㆍ\s]{0,40}?(?:법률|특례법|법|시행령|시행규칙|규칙|령))\s*(?:\([^)\n]{0,30}\)\s*)?제\s*(\d+)\s*조(?:\s*의\s*(\d+))?/g;

const norm = (s) => s.replace(/[\s·ㆍ]/g, '');

export function checkCitations(text, ledger) {
  const lawNames = [...new Set([...ledger.articles.values()].map((a) => a.law))];
  const have = new Set([...ledger.articles.values()].map((a) => `${norm(a.law)}|${a.label}`));
  const checked = [];
  const unverified = [];
  const seen = new Set();

  const plain = text.replace(/[「」『』“”"*]/g, ' ');
  for (const m of plain.matchAll(CITE_RE)) {
    const raw = norm(m[1]);
    const label = `제${m[2]}조${m[3] ? `의${m[3]}` : ''}`;
    if (/(같은법|동법|이법)$/.test(raw)) continue; // "same Act" back-references can't be resolved mechanically
    // The regex may grab preceding words ("따라서출입국관리법"); match the longest known law name at the end.
    const lawName = lawNames
      .filter((n) => raw.endsWith(norm(n)))
      .sort((a, b) => b.length - a.length)[0];
    const display = `${lawName || m[1].trim()} ${label}`;
    if (seen.has(display)) continue;
    seen.add(display);
    if (lawName && have.has(`${norm(lawName)}|${label}`)) checked.push(display);
    else unverified.push(display);
  }
  return { checked, unverified };
}
