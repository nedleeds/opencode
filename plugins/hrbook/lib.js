import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Everything the agent does at query time reads from a local cache. Nothing
 * touches the network except `sync`, which is an explicit, human-triggered
 * step. That is what keeps answers instant on a corporate network where
 * github.com may be slow, proxied, or blocked outright — and it means a single
 * person can sync once and share the cache directory with the whole team.
 */
export const CACHE = process.env.HRBOOK_CACHE || path.join(homedir(), '.cache', 'hrbook');
export const BOOKS_DIR = path.join(CACHE, 'books');
export const BOOKINFOS = path.join(CACHE, 'bookinfos.json');

/** Overridable so an internal mirror can be used instead of github.com. */
const TARBALL_BASE =
  process.env.HRBOOK_TARBALL_BASE || 'https://codeload.github.com/hyundai-robotics';
const BOOKINFOS_URL =
  process.env.HRBOOK_BOOKINFOS_URL ||
  'https://raw.githubusercontent.com/hyundai-robotics/hrbookinfos/master/bookinfos.json';
const VIEWER_BASE = process.env.HRBOOK_VIEWER_BASE || 'https://hrbook-hrc.web.app';

/**
 * `curl` rather than fetch(): Node's fetch ignores HTTP_PROXY/HTTPS_PROXY, and
 * a proxy is the normal case on an internal network. curl honours those plus
 * .curlrc and the system CA store, so it works where fetch silently hangs.
 */
async function download(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  const REVOKE = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];

  await run('curl', ['-sSL', '--fail', ...REVOKE, '--max-time', '180', '-o', dest, url]);
}

/**
 * Every file in these repos starts with a UTF-8 BOM. Left in place it breaks
 * JSON.parse on bookinfos.json and — worse — corrupts tool results: OpenCode
 * rejects the whole call with `JSON Parse error: Unrecognized token`.
 */
async function readText(file) {
  return (await readFile(file, 'utf8')).replace(/^﻿/, '');
}

export async function loadBookinfos() {
  if (!existsSync(BOOKINFOS)) {
    throw new Error(`bookinfos.json not cached. Run: npx hrbook-sync --refresh`);
  }
  return JSON.parse(await readText(BOOKINFOS));
}

/** Deep link into the HRBook web viewer for a cached page. */
export function viewerUrl(book, ver, relPath, contModel) {
  const page = relPath.replace(/\.md$/i, '');
  const q = contModel ? `?cont_model=${encodeURIComponent(contModel)}` : '';
  return `${VIEWER_BASE}/#/view/${book}/${ver}/${page}${q}`;
}

/** GitBook templating: `${cont_model}` etc. come from the bookinfos entry. */
export function substitute(text, variables) {
  if (!variables) return text;
  return text.replace(/\$\{(\w+)\}/g, (m, key) =>
    Object.hasOwn(variables, key) ? String(variables[key]) : m,
  );
}

export async function listCached() {
  if (!existsSync(BOOKS_DIR)) return [];
  const out = [];
  for (const book of await readdir(BOOKS_DIR)) {
    const bookDir = path.join(BOOKS_DIR, book);
    if (!(await stat(bookDir)).isDirectory()) continue;
    for (const ver of await readdir(bookDir)) {
      if ((await stat(path.join(bookDir, ver))).isDirectory()) out.push({ book, ver });
    }
  }
  return out;
}

async function walkMarkdown(dir, base = dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walkMarkdown(full, base, acc);
    else if (entry.name.toLowerCase().endsWith('.md')) acc.push(path.relative(base, full));
  }
  return acc;
}

/**
 * `book.md` is the entire manual concatenated into one file (up to ~470 KB, or
 * >100k tokens). Every line in it is duplicated from a real page, so indexing
 * it only produces noisy hits that point at a file no agent should ever read.
 */
const SKIP_FILES = new Set(['book.md']);

/** Nearest markdown heading above `line`, used to label a hit. */
function headingFor(lines, line) {
  for (let i = line; i >= 0; i--) {
    const m = /^#{1,6}\s+(.*)$/.exec(lines[i]);
    if (m) return m[1].trim();
  }
  return '';
}

/**
 * Pick the line covering the most query terms rather than the first line
 * touching any of them — with a multi-word query the first loose match is
 * usually the least informative one on the page.
 */
function bestLine(lines, terms) {
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].toLowerCase();
    if (!l.trim()) continue;
    const n = terms.filter((t) => l.includes(t)).length;
    if (n > bestScore) {
      bestScore = n;
      best = i;
    }
    if (n === terms.length) break;
  }
  return { line: best < 0 ? 0 : best, matched: bestScore };
}

function meta(infos, book, ver) {
  return infos.find((e) => e.book_id === book && e.ver_id === ver);
}

/**
 * ver_id encodes language in two styles — `ko` / `en` / `zh` on newer manuals
 * and `korean` / `english` / `chinese` / `german` on older ones. Matching on a
 * bare prefix works by luck for ko and en but silently drops every `chinese*`
 * manual for `zh`, and leaves German unreachable entirely.
 */
const LANG_ALIASES = {
  ko: ['ko', 'korean'],
  en: ['en', 'english'],
  zh: ['zh', 'chinese'],
  de: ['de', 'german'],
};

function matchesLang(ver, lang) {
  if (!lang) return true;
  const l = lang.toLowerCase();
  return (LANG_ALIASES[l] ?? [l]).some((p) => ver.toLowerCase().startsWith(p));
}

/**
 * Hi6 and Hi7 editions of a manual are separate branches whose markdown is
 * byte-identical — only the `cont_model` variable differs. Collapsing them
 * under one key stops the same page filling two result slots.
 */
function langKey(ver) {
  return ver.replace(/-hi\d[a-z]?$/i, '').toLowerCase();
}

/** @internal Exported for tests only — see test/lib.test.js. */
export const matchesLangForTest = matchesLang;
/** @internal Exported for tests only — see test/lib.test.js. */
export const langKeyForTest = langKey;

/** Entries whose content lives in a git branch we can fetch, not an external URL. */
function fetchable(entry) {
  return !entry.url;
}

/**
 * Titles alone cannot bridge the vocabulary gap: a user asks about
 * "EtherNet/IP" but the manual is titled "산업용 통신 / Industrial
 * communication", sharing no keyword. These aliases encode that domain
 * knowledge once, in code, for zero tokens per request.
 */
const TOPIC_ALIASES = [
  {
    book: 'doc-industrial-communication',
    terms: ['ethernet', 'ethernet/ip', 'profinet', 'profibus', 'cc-link', 'cclink',
      'devicenet', 'modbus', 'fieldbus', 'industrial', '산업용', '통신', '필드버스'],
  },
  { book: 'doc-hi6-open-api', terms: ['api', 'rest', 'http', 'json', 'openapi'] },
  { book: 'doc-hrscript', terms: ['script', 'hrscript', '스크립트'] },
  { book: 'doc-hi6-operation', terms: ['jog', '조그', 'teach', '티칭', 'tp', '조작'] },
];

/**
 * Score bookinfos entries against a query so the *code* can pick which manual
 * to fetch. Doing this in the model instead would mean putting the catalogue
 * in context — 5.4k tokens compacted, 13.7k raw, on every single request — to
 * replace matching that is both free and deterministic here.
 */
export function rankBooks(query, infos, opts = {}) {
  const { product, lang, limit = 2 } = opts;
  const lowered = query.toLowerCase();
  const terms = lowered.split(/[\s/]+/).filter((t) => t.length > 1);
  if (terms.length === 0) return [];

  const aliasHits = new Set();
  for (const { book, terms: alias } of TOPIC_ALIASES) {
    if (alias.some((a) => lowered.includes(a))) aliasHits.add(book);
  }

  const scored = [];
  for (const e of infos) {
    if (!fetchable(e)) continue;
    if (product && !e.products?.includes(product.toLowerCase())) continue;
    if (!matchesLang(e.ver_id, lang)) continue;

    // book_id is slug-cased, so match its segments as whole words. Substring
    // matching here scored "ip" inside "hrscript" above the right manual.
    const slug = e.book_id.toLowerCase().split(/[-_/]/);
    const titleWords = new Set(e.title.toLowerCase().split(/[\s\-_/()]+/));
    let score = aliasHits.has(e.book_id) ? 8 : 0;
    for (const t of terms) {
      if (slug.includes(t)) score += 4;
      else if (titleWords.has(t)) score += 2;
    }
    if (score > 0) scored.push({ ...e, score });
  }

  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const out = [];
  for (const e of scored) {
    // Keyed by language, not ver_id: fetching both the Hi6 and Hi7 branch
    // downloads the same bytes twice and then doubles every search result.
    const key = `${e.book_id}/${langKey(e.ver_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Rank pages by where the terms hit: a path or heading match means the page is
 * *about* the topic, whereas a body match may only mention it in passing.
 */
export async function search(query, opts = {}) {
  const { product, lang, book: bookFilter, limit = 8 } = opts;
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return { hits: [], scanned: 0 };

  const infos = await loadBookinfos();
  const cached = await listCached();
  const hits = [];
  let scanned = 0;

  for (const { book, ver } of cached) {
    if (bookFilter && book !== bookFilter) continue;
    if (!matchesLang(ver, lang)) continue;
    const info = meta(infos, book, ver);
    if (product && info && !info.products?.includes(product.toLowerCase())) continue;

    const root = path.join(BOOKS_DIR, book, ver);
    let pages;
    try {
      pages = await walkMarkdown(root);
    } catch {
      continue; // being replaced by a concurrent sync
    }
    for (const rel of pages) {
      if (SKIP_FILES.has(path.basename(rel).toLowerCase())) continue;
      scanned++;
      const text = await readText(path.join(root, rel));
      const lower = text.toLowerCase();
      const relLower = rel.toLowerCase();
      if (!terms.every((t) => lower.includes(t) || relLower.includes(t))) continue;

      const lines = text.split('\n');
      const { line, matched } = bestLine(lines, terms);

      const inPath = terms.filter((t) => relLower.includes(t)).length;
      const heading = headingFor(lines, line);
      const inHeading = terms.filter((t) => heading.toLowerCase().includes(t)).length;
      // Path and heading matches mean the page is *about* the topic; a line
      // covering every term beats one that only brushes a single word.
      const score = inPath * 10 + inHeading * 5 + matched * 2 + 1;

      hits.push({
        book,
        ver,
        path: rel,
        title: info?.title ?? book,
        heading,
        score,
        snippet: substitute(lines[line].trim().slice(0, 200), info?.variables),
        url: viewerUrl(book, ver, rel, info?.variables?.cont_model),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  // Collapse the Hi6/Hi7 duplicates of a page. Without this half the result
  // slots — and half the tokens they cost — go to bytes the model already has.
  const byPage = new Map();
  for (const h of hits) {
    const key = `${h.book}|${langKey(h.ver)}|${h.path}`;
    const seen = byPage.get(key);
    if (!seen) {
      byPage.set(key, { ...h, alsoIn: [] });
    } else if (!seen.alsoIn.includes(h.ver)) {
      seen.alsoIn.push(h.ver);
    }
  }
  const unique = [...byPage.values()];
  return { hits: unique.slice(0, limit), scanned, total: unique.length };
}

/** Set HRBOOK_AUTOSYNC=0 where GitHub is blocked and no mirror is configured, so a miss fails fast instead of hanging. */
export const AUTOSYNC = process.env.HRBOOK_AUTOSYNC !== '0';

/**
 * Search, and on a miss fetch the manual the query is most likely about and
 * search again. This is what removes the manual setup step: the first question
 * about an unsynced manual costs ~5s once, and every later one is local.
 */
export async function searchWithAutoSync(query, opts = {}) {
  const first = await search(query, opts);
  if (!AUTOSYNC) return { ...first, synced: [] };

  const infos = await loadBookinfos();
  const cachedKeys = new Set((await listCached()).map((c) => `${c.book}/${c.ver}`));
  const ranked = rankBooks(query, infos, {
    product: opts.product,
    lang: opts.lang,
    limit: 2,
  });

  // Fetch on a miss, but also when the query names a manual we do not have —
  // a score of 4+ means the words matched a book_id segment or a topic alias,
  // not just an incidental title word. Without this, a weak false-positive hit
  // in an already-cached manual would suppress fetching the right one.
  const strong = ranked.filter((e) => e.score >= 4);
  const wanted = (first.hits.length === 0 ? ranked : strong).filter(
    (e) => !cachedKeys.has(`${e.book_id}/${e.ver_id}`),
  );
  if (wanted.length === 0) return { ...first, synced: [] };
  const candidates = wanted;

  const synced = [];
  for (const c of candidates) {
    try {
      await syncBook(c.book_id, c.ver_id);
      synced.push(`${c.book_id}/${c.ver_id}`);
    } catch {
      // Offline or blocked: fall through and report the miss honestly.
    }
  }
  if (synced.length === 0) return { ...first, synced: [] };

  const second = await search(query, opts);
  return { ...second, synced };
}

export async function readPage(book, ver, relPath, maxBytes = 12000) {
  const rel = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
  const root = path.join(BOOKS_DIR, book, ver);
  const full = path.resolve(root, rel);
  // Keep the agent inside the cache even if it passes `../` in a path.
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error('path escapes book root');
  if (!existsSync(full)) throw new Error(`not cached: ${book}/${ver}/${rel}`);

  const infos = await loadBookinfos();
  const info = meta(infos, book, ver);
  let text = substitute(await readText(full), info?.variables);
  let truncated = false;
  if (text.length > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
  }
  return { text, truncated, url: viewerUrl(book, ver, rel, info?.variables?.cont_model) };
}

// ---------------------------------------------------------------- sync

export async function refreshBookinfos() {
  await download(BOOKINFOS_URL, BOOKINFOS);
  return (await loadBookinfos()).length;
}

/** Delete everything that is not markdown, plus the directories left empty. */
async function pruneToMarkdown(dir) {
  let kept = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await pruneToMarkdown(full);
      if (inner === 0) await rm(full, { recursive: true, force: true });
      kept += inner;
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      kept++;
    } else {
      await rm(full, { force: true });
    }
  }
  return kept;
}

/**
 * One tarball per book/branch instead of hundreds of per-file requests, and
 * only markdown is kept — image assets are the bulk of the repo and useless
 * for text search.
 *
 * Extract-then-prune rather than `tar --wildcards '*.md'`: that flag is GNU
 * tar only, and macOS ships bsdtar, which fails outright. Pruning afterwards
 * behaves identically on both.
 */
export async function syncBook(book, ver) {
  const tmp = path.join(CACHE, '.tmp', `${book}-${ver}`);
  const tgz = `${tmp}.tar.gz`;
  const dest = path.join(BOOKS_DIR, book, ver);

  try {
    await download(`${TARBALL_BASE}/${book}/tar.gz/${ver}`, tgz);
    await rm(tmp, { recursive: true, force: true });
    await mkdir(tmp, { recursive: true });
    await run('tar', ['xzf', tgz, '-C', tmp, '--strip-components=1']);

    const kept = await pruneToMarkdown(tmp);
    await rm(dest, { recursive: true, force: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await mkdir(path.dirname(dest), { recursive: true });
    await rm(dest, { recursive: true, force: true });
    await rename(tmp, dest);
    return kept;
  } finally {
    // Never leave tarballs or half-extracted trees behind on failure.
    await rm(tgz, { force: true });
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function writeManifest(entries) {
  await writeFile(
    path.join(CACHE, 'manifest.json'),
    JSON.stringify({ syncedAt: new Date().toISOString(), books: entries }, null, 2),
  );
}
