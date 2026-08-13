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
    assert.equal(r.groups[0].pages[0].path, '0-about-this-manual/precautions.md');
    assert.match(r.groups[0].pages[0].snippet, /안전 회로/);
    assert.equal(r.groups[0].pages[0].tier, 'direct');
    assert.equal(r.partial, false);
  });
});

test('search scopes to a language and to a single book', async () => {
  await withIndex(async ({ search }) => {
    assert.equal((await search('조그 속도', { lang: 'en' })).total, 0, 'wrong language');
    assert.equal(
      (await search('조그 속도', { book: 'doc-hi6-open-api' })).total,
      0,
      'wrong book',
    );
    assert.equal((await search('조그 속도', { lang: 'ko' })).total, 1);
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

/**
 * The failure this pins: asked about "민첩 모드", the agent insisted the force
 * control manual had no such thing. The page did contain it — but ranking was
 * per-line, so dozens of Open API pages holding only "모드" tied with the one
 * page holding both terms, and the tie broke on filesystem order.
 */
const LONG_PAGE = [
  '[__SOURCE](api/mode.md)',
  '# Open API 모드 전환',
  '모드 파라미터를 전달합니다.',
  '',
  '[__SOURCE](api/status.md)',
  '# 상태 조회',
  '현재 모드를 반환합니다.',
  '',
  '[__SOURCE](3-params/control.md)',
  '# 제어 파라미터 설정',
  '응답 설정값이 낮을수록 민첩하게 도달합니다.',
  '',
  '##### **[민첩 모드]**',
  '민첩 모드는 추종 성능을 극대화합니다.',
  '설정 범위는 0~100 입니다.',
].join('\n');

async function withLongPage(fn) {
  const cache = await mkdtemp(path.join(tmpdir(), 'hrbook-test-'));
  try {
    process.env.HRBOOK_CACHE = cache;
    const lib = await import(`../plugins/hrbook/lib.js?long=${encodeURIComponent(cache)}`);
    await mkdir(lib.INDEX_DIR, { recursive: true });
    await writeFile(lib.indexPath('doc-hi6-force-control', 'ko'), LONG_PAGE, 'utf8');
    await fn(lib);
  } finally {
    delete process.env.HRBOOK_CACHE;
    await rm(cache, { recursive: true, force: true });
  }
}

test('a page carrying every term outranks pages carrying only one', async () => {
  await withLongPage(async ({ search }) => {
    const r = await search('민첩 모드', { lang: 'ko' });
    const [top] = r.groups[0].pages;
    assert.equal(top.path, '3-params/control.md');
    assert.equal(top.tier, 'direct');
    // The "모드"-only pages survive as context but are demoted, never mixed in
    // above the page that answers the question.
    const others = r.groups[0].pages.slice(1);
    assert.ok(others.every((p) => p.tier === 'partial'));
    assert.equal(r.partial, false);
  });
});

test('a hit reports the heading directly above it, not the page title', async () => {
  await withLongPage(async ({ search }) => {
    const [hit] = (await search('민첩 모드', { lang: 'ko' })).groups[0].pages;
    // "제어 파라미터 설정" is the page's opening heading and says nothing about
    // the query; reporting it is what made the result look irrelevant.
    assert.equal(hit.heading, '[민첩 모드]');
    assert.ok(hit.hits > 1, 'multiple matches on the page are counted');
  });
});

test('a snippet carries the lines around the hit, not the hit alone', async () => {
  await withLongPage(async ({ search }) => {
    const [hit] = (await search('민첩 모드', { lang: 'ko' })).groups[0].pages;
    assert.match(hit.snippet, /추종 성능/);
    assert.match(hit.snippet, /설정 범위/);
  });
});

test('a query no page fully covers falls back to partial matches, and says so', async () => {
  await withLongPage(async ({ search }) => {
    const r = await search('민첩 존재하지않는단어', { lang: 'ko' });
    assert.equal(r.partial, true, 'flagged so the model does not over-trust it');
    assert.ok(r.total > 0, 'still better than nothing');
  });
});

test('search can be restricted to an explicit set of books', async () => {
  await withLongPage(async ({ search }) => {
    // How the `product` filter reaches search: book ids are resolved from
    // bookinfos, because the files on disk carry no product metadata.
    assert.equal((await search('민첩 모드', { books: ['doc-hrscript'] })).bookCount, 0);
    const only = await search('민첩 모드', { books: ['doc-hi6-force-control'] });
    assert.equal(only.bookCount, 1);
    assert.equal(only.groups[0].book, 'doc-hi6-force-control');
  });
});

/**
 * Grouping by manual, not one flat ranked list.
 *
 * A flat list capped at N pages lets a verbose manual take every slot: the
 * Open API manual mentions "모드" everywhere, so the single force-control page
 * holding "민첩 모드" never surfaced at all. Per-manual quotas make a manual
 * that contains the term visible however loud its neighbours are.
 */
const NOISY = [
  ...Array.from({ length: 12 }, (_, i) =>
    [`[__SOURCE](api/p${i}.md)`, `# 모드 항목 ${i}`, '모드 파라미터를 전달합니다.', ''].join('\n'),
  ),
].join('\n');

const QUIET = [
  '[__SOURCE](3-params/control.md)',
  '# 제어 파라미터 설정',
  '##### **[민첩 모드]**',
  '민첩 모드는 추종 성능을 극대화합니다.',
].join('\n');

async function withTwoBooks(fn) {
  const cache = await mkdtemp(path.join(tmpdir(), 'hrbook-test-'));
  try {
    process.env.HRBOOK_CACHE = cache;
    const lib = await import(`../plugins/hrbook/lib.js?two=${encodeURIComponent(cache)}`);
    await mkdir(lib.INDEX_DIR, { recursive: true });
    await writeFile(lib.indexPath('doc-hi6-open-api', 'ko'), NOISY, 'utf8');
    await writeFile(lib.indexPath('doc-hi6-force-control', 'ko'), QUIET, 'utf8');
    await fn(lib);
  } finally {
    delete process.env.HRBOOK_CACHE;
    await rm(cache, { recursive: true, force: true });
  }
}

test('results are grouped per manual, with each manual counted separately', async () => {
  await withTwoBooks(async ({ search }) => {
    const r = await search('모드', { lang: 'ko' });
    assert.equal(r.bookCount, 2, 'both manuals reported, not just the loud one');
    const quiet = r.groups.find((g) => g.book === 'doc-hi6-force-control');
    assert.ok(quiet, 'the quiet manual is never crowded out');
    // Twelve pages exist in the noisy manual but only the quota is returned;
    // the true count still travels so the model knows the shape.
    const noisy = r.groups.find((g) => g.book === 'doc-hi6-open-api');
    assert.equal(noisy.pageTotal, 12);
    assert.equal(noisy.pages.length, 3, 'per-manual quota applied');
  });
});

test('a manual matching only a corpus-wide common word is treated as noise', async () => {
  await withTwoBooks(async ({ search }) => {
    const r = await search('민첩 모드', { lang: 'ko' });
    assert.equal(r.groups[0].book, 'doc-hi6-force-control');
    assert.equal(r.groups[0].tier, 'direct');
    // Here "모드" is on every page in the fixture, so it identifies nothing and
    // the pages carrying only it are dropped. This is rarity-relative, not a
    // fixed rule: where "모드" is uncommon those same pages would survive as
    // partial matches, which is what the LONG_PAGE case above checks.
    assert.equal(r.bookCount, 1);
    const rare = r.terms.find((t) => t.term === '민첩');
    const common = r.terms.find((t) => t.term === '모드');
    assert.ok(rare.idf > common.idf, 'the rarer term carries more weight');
  });
});

/**
 * The model writes the query, so the code cannot assume clean keywords. These
 * pin the normalisation that makes a sentence behave like the two nouns in it.
 */
test('extractTerms drops the words that appear on every page', async () => {
  const { extractTerms } = await import('../plugins/hrbook/lib.js');
  // "joint 관련 API 매뉴얼 찾아줘" — with 관련/매뉴얼/찾아줘 left in, no page
  // covers every term, the search degrades to partial matching, and pages
  // whose only qualification is the word "매뉴얼" flood the result.
  assert.deepEqual(
    extractTerms('joint 관련 API 매뉴얼 찾아줘').map((t) => t.text),
    ['joint', 'api'],
  );
});

test('extractTerms strips particles but keeps the original form too', async () => {
  const { extractTerms } = await import('../plugins/hrbook/lib.js');
  const [term] = extractTerms('튜닝을');
  assert.equal(term.text, '튜닝');
  assert.deepEqual(term.forms, ['튜닝', '튜닝을']);
  // Longest-first, or "으로" would be cut to "으" by the "로" rule.
  assert.equal(extractTerms('제어으로')[0].text, '제어');
});

test('extractTerms falls back to raw tokens rather than returning nothing', async () => {
  const { extractTerms } = await import('../plugins/hrbook/lib.js');
  // A query made entirely of stopwords still has to search something: a bad
  // search beats reporting "no results" for a question the manuals cover.
  assert.deepEqual(extractTerms('방법 알려줘').map((t) => t.text), ['방법', '알려줘']);
});

test('a compound written without spaces still matches the spaced text', async () => {
  await withLongPage(async ({ search }) => {
    // The manuals are not consistent about "민첩 모드" vs "민첩모드", and the
    // user is not going to guess which one a given page used.
    const r = await search('민첩모드', { lang: 'ko' });
    assert.equal(r.groups[0].pages[0].path, '3-params/control.md');
  });
});

test('a partial result reports which terms failed and which worked', async () => {
  await withLongPage(async ({ search }) => {
    const r = await search('민첩 존재하지않는단어', { lang: 'ko' });
    assert.equal(r.partial, true);
    const dead = r.terms.find((t) => t.term === '존재하지않는단어');
    const live = r.terms.find((t) => t.term === '민첩');
    assert.equal(dead.pages, 0, 'a term matching nothing is reported as such');
    assert.ok(live.pages > 0, 'so the model can retry with the term that worked');
  });
});

test('a question about which manual exists is routed to the catalogue', async () => {
  const { looksLikeCatalogueQuery } = await import('../plugins/hrbook/lib.js');
  // Detected in code rather than instructed in the prompt: a rule the model
  // has to remember is a rule it sometimes forgets.
  assert.equal(looksLikeCatalogueQuery('joint 관련 API 매뉴얼 찾아줘'), true);
  assert.equal(looksLikeCatalogueQuery('어떤 설명서가 있어?'), true);
  // Naming the source is not the same as asking about it — this one still
  // wants page content and must go to full-text search.
  assert.equal(looksLikeCatalogueQuery('조그 속도 기본값'), false);
});

test('safety hint blocks are flagged so a summary cannot quietly drop them', async () => {
  const { hasWarning } = await import('../plugins/hrbook/lib.js');
  assert.equal(hasWarning('{% hint style="danger" %}\n감전 위험\n{% endhint %}'), true);
  assert.equal(hasWarning('{% hint style="info" %}\n참고\n{% endhint %}'), false);
});

/**
 * Adding good keywords must help, not hurt. Requiring every term punished the
 * detailed query — five sound keywords rarely co-occur on one page, so the
 * search fell back to noise and the user learned to ask for less.
 */
const CORPUS = [
  '[__SOURCE](tune/gain.md)',
  '# 부가축 서보 튜닝',
  '부가축 서보 이득 파라미터를 설정합니다.',
  '',
  '[__SOURCE](general/setup.md)',
  '# 일반 설정',
  '설정 화면에서 파라미터를 확인합니다.',
  '',
  '[__SOURCE](general/misc.md)',
  '# 기타',
  '파라미터 설정은 관리자만 가능합니다.',
].join('\n');

async function withCorpus(fn) {
  const cache = await mkdtemp(path.join(tmpdir(), 'hrbook-test-'));
  try {
    process.env.HRBOOK_CACHE = cache;
    const lib = await import(`../plugins/hrbook/lib.js?corpus=${encodeURIComponent(cache)}`);
    await mkdir(lib.INDEX_DIR, { recursive: true });
    await writeFile(lib.indexPath('doc-add-axes', 'ko'), CORPUS, 'utf8');
    await fn(lib);
  } finally {
    delete process.env.HRBOOK_CACHE;
    await rm(cache, { recursive: true, force: true });
  }
}

test('a page missing only common terms still counts as directly relevant', async () => {
  await withCorpus(async ({ search }) => {
    // Five terms, and no page carries all five — "튜닝" and "이득" never share
    // a line with "설정". Under the old all-or-nothing rule this collapsed to
    // partial matching and the right page was buried.
    const r = await search('부가축 서보 튜닝 이득 파라미터 설정', { lang: 'ko' });
    assert.equal(r.groups[0].pages[0].path, 'tune/gain.md');
    assert.equal(r.groups[0].pages[0].tier, 'direct');
    assert.equal(r.partial, false);
  });
});

test('rarity decides the weighting, so common words cannot outvote rare ones', async () => {
  await withCorpus(async ({ search }) => {
    const r = await search('부가축 설정', { lang: 'ko' });
    const rare = r.terms.find((t) => t.term === '부가축');
    const common = r.terms.find((t) => t.term === '설정');
    assert.equal(rare.pages, 1);
    assert.ok(common.pages > rare.pages);
    assert.ok(rare.idf > common.idf);
    // The page with the rare term wins even though two pages match "설정".
    assert.equal(r.groups[0].pages[0].path, 'tune/gain.md');
  });
});
