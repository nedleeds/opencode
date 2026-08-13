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

/**
 * The `__SOURCE` marker is what makes a hit in the 480 KB concatenated file
 * addressable: it names the original page, so hrbook_read has an exact path
 * and never has to guess one from heading levels.
 */
const BOOK_MD = [
  '\uFEFF[__SOURCE](README.md)',
  '# ${cont_model} 제어기 조작설명서 - TP630',
  '',
  '[__SOURCE](0-about-this-manual/precautions.md)',
  '# 사전 주의사항',
  '로봇 초기 설정 전에 안전 회로를 확인하십시오.',
  '![](../_assets/tp630/warn.png)',
  '',
  '[__SOURCE](3-setup/network/config.md)',
  '# 네트워크 설정',
  '조그 속도는 기본값 10%입니다.',
  '![구성도](../../_assets/image.png)',
  '자세한 내용은 [외부 문서](https://example.com/x.md)를 참고하십시오.',
].join('\n');

async function withIndex(fn) {
  const cache = await mkdtemp(path.join(tmpdir(), 'hrbook-test-'));
  try {
    process.env.HRBOOK_CACHE = cache;
    const lib = await import(`../plugins/hrbook/lib.js?cache=${encodeURIComponent(cache)}`);
    await mkdir(lib.INDEX_DIR, { recursive: true });
    await writeFile(lib.indexPath('doc-hi6-operation', 'ko-tp630'), BOOK_MD, 'utf8');
    await fn(lib);
  } finally {
    delete process.env.HRBOOK_CACHE;
    await rm(cache, { recursive: true, force: true });
  }
}

test('splitSections turns the concatenated book back into addressable pages', async () => {
  await withIndex(({ splitSections }) => {
    const s = splitSections(BOOK_MD);
    assert.deepEqual(s.map((x) => x.path), [
      'README.md',
      '0-about-this-manual/precautions.md',
      '3-setup/network/config.md',
    ]);
    assert.equal(s[1].heading, '사전 주의사항');
    // The BOM sits in front of the very first marker and must not stop it
    // matching, or the whole first page vanishes from the index.
    assert.equal(s[0].path, 'README.md');
  });
});

test('full-text search finds body text that matches no title and no alias', async () => {
  await withIndex(async ({ search }) => {
    // The query that returned nothing under catalogue keyword scoring: no
    // manual is titled "초기 설정" and no topic alias covers it.
    const r = await search('초기 설정', { lang: 'ko' });
    assert.equal(r.hits[0].path, '0-about-this-manual/precautions.md');
    assert.match(r.hits[0].snippet, /안전 회로/);
    // A page matching only "설정" still surfaces, but below the one matching
    // both terms — partial matches are worth ranking, not discarding.
    assert.equal(r.hits[1].path, '3-setup/network/config.md');
    assert.ok(r.hits[0].score > r.hits[1].score);
  });
});

test('search scopes to a language and to a single book', async () => {
  await withIndex(async ({ search }) => {
    assert.equal((await search('조그 속도', { lang: 'en' })).hits.length, 0, 'wrong language');
    assert.equal(
      (await search('조그 속도', { book: 'doc-hi6-open-api' })).hits.length,
      0,
      'wrong book',
    );
    assert.equal((await search('조그 속도', { lang: 'ko' })).hits.length, 1);
  });
});

test('reading a page resolves its images against the page that owned them', async () => {
  await withIndex(async ({ readPage }) => {
    // Concatenation left image links relative to the *original* page, at
    // whatever depth it sat. Lifted out of the index unchanged, every one of
    // them would point nowhere.
    const { text, url } = await readPage(
      'doc-hi6-operation',
      'ko-tp630',
      '3-setup/network/config.md',
      12000,
      { cont_model: 'Hi6' },
    );
    assert.match(
      text,
      /!\[구성도\]\(https:\/\/raw\.githubusercontent\.com\/hyundai-robotics\/doc-hi6-operation\/ko-tp630\/_assets\/image\.png\)/,
    );
    // Absolute links are somebody else's URL and must be left alone.
    assert.match(text, /\[외부 문서\]\(https:\/\/example\.com\/x\.md\)/);
    assert.match(url, /view\/doc-hi6-operation\/ko-tp630\/3-setup\/network\/config\?cont_model=Hi6$/);
  });
});

test('a page read substitutes GitBook variables', async () => {
  await withIndex(async ({ readPage }) => {
    const { text } = await readPage('doc-hi6-operation', 'ko-tp630', 'README.md', 12000, {
      cont_model: 'Hi6',
    });
    assert.match(text, /Hi6 제어기 조작설명서/);
    assert.doesNotMatch(text, /\$\{cont_model\}/);
  });
});

test('a page path that is not in the index is an error, never a guess', async () => {
  await withIndex(async ({ readPage }) => {
    await assert.rejects(
      () => readPage('doc-hi6-operation', 'ko-tp630', 'does/not/exist.md'),
      /page not in index/,
    );
  });
});

test('pendingFor skips both what is downloaded and what has no book.md', async () => {
  await withIndex(async ({ pendingFor, INDEX_DIR }) => {
    // A repository that publishes no book.md gets a marker; without it the
    // same 404 is re-requested on every question for the rest of time.
    await writeFile(path.join(INDEX_DIR, 'doc-manual-warning@ko.none'), '', 'utf8');
    const pending = pendingFor([
      { book: 'doc-hi6-operation', ver: 'ko-tp630' },
      { book: 'doc-manual-warning', ver: 'ko' },
      { book: 'doc-hrscript', ver: 'ko' },
    ]);
    assert.deepEqual(pending.map((p) => p.book), ['doc-hrscript']);
  });
});

test('booksForLang keeps one branch per language, not one per controller', async () => {
  await withIndex(({ booksForLang }) => {
    // ko-Hi6 and ko-Hi7 are the same prose branded twice: fetching both
    // doubles the bytes and then doubles every search result.
    const entries = booksForLang(INFOS, 'ko');
    const ids = entries.map((e) => `${e.book}/${e.ver}`);
    assert.equal(ids.filter((i) => i.startsWith('doc-industrial-communication')).length, 1);
    // The external-PDF entry has no repository to fetch from.
    assert.ok(!ids.some((i) => i.startsWith('doc-hi6-maintenance')));
  });
});
