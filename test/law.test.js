import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLawBody, pickArticles, parseArticleRef } from '../server/lawApi.js';
import { checkCitations } from '../server/citations.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/law-detail.json', import.meta.url)));

test('parses law info and skips chapter headings', () => {
  const law = parseLawBody(fixture);
  assert.equal(law.info.name, '출입국관리법');
  assert.equal(law.info.ministry, '법무부');
  assert.deepEqual(law.articles.map((a) => a.label), ['제1조', '제17조', '제25조의2']);
});

test('flattens paragraphs, subparagraphs and items (single object or array)', () => {
  const law = parseLawBody(fixture);
  const a17 = law.articles.find((a) => a.label === '제17조');
  assert.match(a17.text, /체류자격과 체류기간의 범위/);
  assert.match(a17.text, /정치활동/);
  const a25 = law.articles.find((a) => a.label === '제25조의2');
  assert.match(a25.text, /가정폭력/);
  assert.match(a25.text, /가\. 예시 목/);
});

test('article references are normalized', () => {
  assert.deepEqual(parseArticleRef('제10조의2'), { num: '10', branch: '2' });
  assert.deepEqual(parseArticleRef('17'), { num: '17', branch: '' });
  assert.deepEqual(parseArticleRef('25의2'), { num: '25', branch: '2' });
  assert.equal(parseArticleRef('abc'), null);
  const law = parseLawBody(fixture);
  const { found, missing } = pickArticles(law, ['17', '제25조의2', '99']);
  assert.equal(found.length, 2);
  assert.deepEqual(missing, ['99']);
});

test('citation checker flags articles that were never retrieved', () => {
  const ledger = { articles: new Map([['출입국관리법|제17조', { law: '출입국관리법', label: '제17조' }]]) };
  const text = '따라서 「출입국관리법」 제17조제1항에 따라 ... 또한 출입국관리법 제94조 위반 시 ... 형법 제260조. 같은 법 제18조';
  const r = checkCitations(text, ledger);
  assert.deepEqual(r.checked, ['출입국관리법 제17조']);
  assert.ok(r.unverified.includes('출입국관리법 제94조'));
  assert.ok(r.unverified.some((x) => x.endsWith('형법 제260조')));
  assert.ok(!r.unverified.some((x) => x.includes('제18조')));
});

test('enforcement decree is not confused with the Act', () => {
  const ledger = { articles: new Map([['출입국관리법|제5조', { law: '출입국관리법', label: '제5조' }]]) };
  const r = checkCitations('출입국관리법 시행령 제5조', ledger);
  assert.deepEqual(r.checked, []);
  assert.equal(r.unverified.length, 1);
});
