import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  langKeyForTest,
  matchesLangForTest,
  rankBooks,
  substitute,
  viewerUrl,
} from '../plugins/hrbook/lib.js';

/**
 * Fixtures mirror the real shape of bookinfos.json, including the two ver_id
 * naming styles that coexist in it (`ko`/`zh` vs `korean`/`chinese`).
 */
const INFOS = [
  { book_id: 'doc-hi6-open-api', ver_id: 'en', title: 'Hi6 Controller Function Manual - Open API', products: ['hi6'], variables: { cont_model: 'Hi6' } },
  { book_id: 'doc-hi6-open-api', ver_id: 'ko', title: 'Hi6 제어기 기능 설명서 - Open API', products: ['hi6'], variables: { cont_model: 'Hi6' } },
  { book_id: 'doc-industrial-communication', ver_id: 'ko-Hi6', title: 'Hi6 제어기 기능 설명서 - 산업용 통신', products: ['hi6'], variables: { cont_model: 'Hi6' } },
  { book_id: 'doc-industrial-communication', ver_id: 'ko-Hi7', title: 'Hi7 제어기 기능 설명서 - 산업용 통신', products: ['hi7'], variables: { cont_model: 'Hi7' } },
  { book_id: 'doc-industrial-communication', ver_id: 'chinese-Hi6', title: 'Hi6 控制器 功能手册 - 工业通讯', products: ['hi6'], variables: { cont_model: 'Hi6' } },
  { book_id: 'doc-hrscript', ver_id: 'ko', title: 'Hi6 제어기 기능 설명서 - HRScript', products: ['hi6'], variables: { cont_model: 'Hi6' } },
  { book_id: 'doc-hi6-maintenance', ver_id: 'main', title: 'Maintenance', products: ['hi6'], url: 'https://github.com/x/y.pdf' },
];

test('viewerUrl drops the .md extension and passes cont_model', () => {
  assert.equal(
    viewerUrl('doc-hi6-open-api', 'en', '1-version/1-get/1-api_ver.md', 'Hi6'),
    'https://hrbook-hrc.web.app/#/view/doc-hi6-open-api/en/1-version/1-get/1-api_ver?cont_model=Hi6',
  );
  assert.equal(
    viewerUrl('b', 'ko', 'README.md'),
    'https://hrbook-hrc.web.app/#/view/b/ko/README',
  );
});

test('substitute fills GitBook variables and leaves unknown ones alone', () => {
  assert.equal(substitute('${cont_model} manual', { cont_model: 'Hi7' }), 'Hi7 manual');
  assert.equal(substitute('${nope}', { cont_model: 'Hi7' }), '${nope}');
  assert.equal(substitute('${cont_model}', undefined), '${cont_model}');
});

test('language filter covers both ver_id naming styles', () => {
  // The bug this guards: a bare prefix match works for ko/en by luck but
  // silently drops every `chinese*` manual under `zh`.
  assert.ok(matchesLangForTest('ko-Hi6', 'ko'));
  assert.ok(matchesLangForTest('korean-tp600', 'ko'));
  assert.ok(matchesLangForTest('chinese-Hi6', 'zh'));
  assert.ok(matchesLangForTest('zh-tp630', 'zh'));
  assert.ok(matchesLangForTest('german-Hi7', 'de'));
  assert.ok(!matchesLangForTest('en', 'ko'));
  assert.ok(matchesLangForTest('anything', undefined));
});

test('langKey collapses controller variants but keeps TP variants apart', () => {
  assert.equal(langKeyForTest('ko-Hi6'), 'ko');
  assert.equal(langKeyForTest('ko-Hi7'), 'ko');
  assert.equal(langKeyForTest('ko-tp630'), 'ko-tp630');
  assert.equal(langKeyForTest('korean'), 'korean');
});

test('rankBooks bridges vocabulary gaps via topic aliases', () => {
  // "EtherNet/IP" shares no keyword with "산업용 통신".
  const [top] = rankBooks('ethernet ip 어댑터', INFOS, { lang: 'ko' });
  assert.equal(top.book_id, 'doc-industrial-communication');
});

test('rankBooks matches book_id segments as words, not substrings', () => {
  // "ip" is a substring of "hrscript"; it must not outrank the real manual.
  const ranked = rankBooks('ethernet ip', INFOS, { lang: 'ko', limit: 5 });
  assert.notEqual(ranked[0].book_id, 'doc-hrscript');
});

test('rankBooks returns one controller variant per language', () => {
  const ranked = rankBooks('산업용 통신', INFOS, { lang: 'ko', limit: 5 });
  const keys = ranked.map((e) => `${e.book_id}/${langKeyForTest(e.ver_id)}`);
  assert.equal(new Set(keys).size, keys.length, 'Hi6 and Hi7 must not both be returned');
});

test('rankBooks skips entries served from an external url', () => {
  const ranked = rankBooks('maintenance', INFOS, { limit: 5 });
  assert.ok(!ranked.some((e) => e.book_id === 'doc-hi6-maintenance'));
});

test('rankBooks honours the product filter', () => {
  const ranked = rankBooks('산업용 통신', INFOS, { product: 'hi7', limit: 5 });
  assert.ok(ranked.every((e) => e.products.includes('hi7')));
});

test('rankBooks returns nothing for a query of only stopword-length tokens', () => {
  assert.deepEqual(rankBooks('a b', INFOS), []);
});
