import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  langKeyForTest,
  matchesLangForTest,
  parseToc,
  rankBooks,
  rawUrl,
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

// ------------------------------------------------------- remote fallback

test('rawUrl builds a raw content path and normalises separators', () => {
  assert.equal(
    rawUrl('doc-hi6-open-api', 'ko', '1-version/1-get/1-api_ver.md'),
    'https://raw.githubusercontent.com/hyundai-robotics/doc-hi6-open-api/ko/1-version/1-get/1-api_ver.md',
  );
  // Paths come back from Windows filesystem walks with backslashes.
  assert.equal(
    rawUrl('b', 'ko', '1-a\\2-b.md'),
    'https://raw.githubusercontent.com/hyundai-robotics/b/ko/1-a/2-b.md',
  );
});

test('parseToc pulls every page out of a GitBook SUMMARY.md', () => {
  // This is what lets an uncached manual still answer a question: one HTTP
  // round trip yields every page path, so hrbook_read has somewhere to go.
  const summary = [
    '# Table of contents',
    '',
    '* [${cont_model} 제어기](README.md)',
    '  * [사전 주의사항](0-about-this-manual/precautions.md)',
    '* [1.1.1 api_ver](./1-version/1-get/1-api_ver.md)',
    '* [외부 링크](https://example.com/x.md)',
    '* [이미지](assets/diagram.png)',
  ].join('\n');

  assert.deepEqual(parseToc(summary), [
    { title: '${cont_model} 제어기', path: 'README.md' },
    { title: '사전 주의사항', path: '0-about-this-manual/precautions.md' },
    { title: '1.1.1 api_ver', path: '1-version/1-get/1-api_ver.md' },
  ]);
});

test('parseToc tolerates a BOM and returns nothing for an empty summary', () => {
  assert.deepEqual(parseToc('\uFEFF# Table of contents\n'), []);
});

// ------------------------------------------------------- completion marker

test('a book counts as cached only once the marker is written', async () => {
  // The failure this guards: quitting mid-clone leaves a valid `.git` with an
  // empty working tree. Judged by directory presence that looks cached, so the
  // book is skipped forever and silently never becomes searchable.
  const cache = await mkdtemp(path.join(tmpdir(), 'hrbook-test-'));
  try {
    process.env.HRBOOK_CACHE = cache;
    // Imported after the env var is set — CACHE is resolved at module load.
    const { isBookComplete, BOOKS_DIR } = await import(
      `../plugins/hrbook/lib.js?cache=${encodeURIComponent(cache)}`
    );

    assert.equal(isBookComplete('doc-hi6-open-api'), false, 'nothing on disk');

    // An interrupted clone: repo present, working tree empty, no marker.
    await mkdir(path.join(BOOKS_DIR, 'doc-hi6-open-api', '.git'), { recursive: true });
    assert.equal(isBookComplete('doc-hi6-open-api'), false, 'interrupted clone is not cached');

    await writeFile(
      path.join(BOOKS_DIR, 'doc-hi6-open-api', '.hrbook-ok'),
      JSON.stringify({ ver: 'ko', pages: 109 }),
      'utf8',
    );
    assert.equal(isBookComplete('doc-hi6-open-api'), true, 'marker means cached');
  } finally {
    delete process.env.HRBOOK_CACHE;
    await rm(cache, { recursive: true, force: true });
  }
});
