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
/**
 * On Windows the cache goes on D: rather than C:. These repos carry their full
 * git history and grow into the gigabytes, and C: is where the corporate image
 * is tightest. `HRBOOK_CACHE` still wins, `HRBOOK_CACHE_DRIVE` picks a
 * different drive, and a machine without that drive falls back to the home
 * directory — so a laptop keeps working with no configuration.
 */
function defaultCache() {
  if (process.env.HRBOOK_CACHE) return process.env.HRBOOK_CACHE;
  if (process.platform === 'win32') {
    const drive = process.env.HRBOOK_CACHE_DRIVE || 'D:';
    // `path.join('D:', ...)` resolves against the CWD on that drive; the
    // trailing separator is what makes it the drive root.
    const root = drive.endsWith(path.sep) ? drive : drive + path.sep;
    if (existsSync(root)) return path.join(root, '.cache', 'hrbook');
  }
  return path.join(homedir(), '.cache', 'hrbook');
}

export const CACHE = defaultCache();
export const BOOKS_DIR = path.join(CACHE, 'books');
export const BOOKINFOS = path.join(CACHE, 'bookinfos.json');
export const SYNC_MANIFEST = path.join(CACHE, 'sync-manifest.json');

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
    try {
      await download(BOOKINFOS_URL, BOOKINFOS);
    } catch (e) {
      throw new Error(`bookinfos.json fetch failed (${BOOKINFOS_URL}): ${e.message}`);
    }
  }
  return JSON.parse(await readText(BOOKINFOS));
}

/** Deep link into the HRBook web viewer for a cached page. */
export function viewerUrl(book, ver, relPath, contModel) {
  const page = relPath.replace(/\\/g, '/').replace(/\.md$/i, '');
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
    
    const gitDir = path.join(bookDir, '.git');
    if (existsSync(gitDir)) {
      try {
        const { stdout: branch } = await run('git', ['-C', bookDir, 'branch', '--show-current']);
        const currentBranch = branch.trim();
        if (currentBranch) out.push({ book, ver: currentBranch, git: true });
      } catch {
        // Not a git repo or error
      }
    } else {
      for (const ver of await readdir(bookDir)) {
        if ((await stat(path.join(bookDir, ver))).isDirectory()) {
          out.push({ book, ver, git: false });
        }
      }
    }
  }
  return out;
}

async function walkMarkdown(dir, base = dir, acc = []) {
  if (!existsSync(dir)) return acc;
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

  for (const { book, ver, git } of cached) {
    if (bookFilter && book !== bookFilter) continue;
    if (!matchesLang(ver, lang)) continue;
    const info = meta(infos, book, ver);
    if (product && info && !info.products?.includes(product.toLowerCase())) continue;

    const root = git ? path.join(BOOKS_DIR, book) : path.join(BOOKS_DIR, book, ver);
    let pages;
    try {
      pages = await walkMarkdown(root);
    } catch {
      continue;
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
      const score = inPath * 10 + inHeading * 5 + matched * 2 + 1;

      hits.push({
        book,
        ver,
        git,
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
  const cached = await listCached();
  const cachedBooks = new Set(cached.map((c) => c.book));
  const ranked = rankBooks(query, infos, {
    product: opts.product,
    lang: opts.lang,
    limit: 2,
  });

  const strong = ranked.filter((e) => e.score >= 4);

  const named = opts.book_id ? infos.filter((e) => e.book_id === opts.book_id) : [];

  const wanted = [...named, ...(first.hits.length === 0 ? ranked : strong)].filter(
    (e, i, a) =>
      !cachedBooks.has(e.book_id) &&
      a.findIndex((x) => x.book_id === e.book_id) === i,
  );
  if (wanted.length === 0) return { ...first, synced: [] };

  const synced = [];
  for (const c of wanted) {
    try {
      await syncBook(c.book_id, c.ver_id, true);
      if (opts.lang) {
        await checkoutBook(c.book_id, c.ver_id);
      }
      synced.push(`${c.book_id}/${c.ver_id}`);
    } catch {
      continue;
    }
  }
  if (synced.length === 0) return { ...first, synced: [] };

  const second = await search(query, opts);
  return { ...second, synced };
}

// ------------------------------------------------------- remote fallback
//
// A book that is still downloading used to make the tools answer "not cached",
// which leaves the user's actual question unanswered for however long the
// clone takes. The manuals are plain markdown in public repos, so a single
// page can be fetched over HTTP without any clone at all. That turns the wait
// into a slower answer instead of no answer, and once the clone lands the
// same tools silently go back to reading from disk.

const RAW_BASE =
  process.env.HRBOOK_RAW_BASE || 'https://raw.githubusercontent.com/hyundai-robotics';

export function rawUrl(book, ver, relPath) {
  const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  return `${RAW_BASE}/${book}/${ver}/${rel}`;
}

/** curl to a temp file and read it back — same proxy/CA handling as download(). */
async function fetchText(url) {
  const tmp = path.join(CACHE, '.tmp', `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    await download(url, tmp);
    return await readText(tmp);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** SUMMARY.md is the GitBook table of contents: one markdown link per page. */
export function parseToc(text) {
  const entries = [];
  const re = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let m;
  while ((m = re.exec(text))) {
    const p = m[2].trim();
    if (/^https?:/i.test(p)) continue;
    entries.push({ title: m[1].trim(), path: p.replace(/^\.\//, '') });
  }
  return entries;
}

const tocCache = new Map();

export async function remoteToc(book, ver) {
  const key = `${book}/${ver}`;
  if (tocCache.has(key)) return tocCache.get(key);

  const entries = parseToc(await fetchText(rawUrl(book, ver, 'SUMMARY.md')));
  tocCache.set(key, entries);
  return entries;
}

/** Title/path matching against the remote TOC. Deliberately not full text —
 *  one HTTP round trip, not one per page. */
export async function remoteSearch(query, book, ver, limit = 5) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const entries = await remoteToc(book, ver);

  const scored = [];
  for (const e of entries) {
    const hay = `${e.title} ${e.path}`.toLowerCase();
    const score = terms.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    if (score > 0) scored.push({ ...e, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function readRemotePage(book, ver, relPath, maxBytes = 12000) {
  const rel = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
  const infos = await loadBookinfos();
  const info = meta(infos, book, ver);

  let text = substitute(await fetchText(rawUrl(book, ver, rel)), info?.variables);
  let truncated = false;
  if (text.length > maxBytes) {
    text = text.slice(0, maxBytes);
    truncated = true;
  }
  return {
    text,
    truncated,
    url: viewerUrl(book, ver, rel, info?.variables?.cont_model),
    remote: true,
  };
}

export async function readPage(book, ver, relPath, maxBytes = 12000) {
  const rel = relPath.endsWith('.md') ? relPath : `${relPath}.md`;
  
  const bookDir = path.join(BOOKS_DIR, book);
  const isGit = existsSync(path.join(bookDir, '.git'));
  const root = isGit ? bookDir : path.join(bookDir, ver);
  
  const full = path.resolve(root, rel);
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

const GIT_REPO_BASE = 'https://github.com/hyundai-robotics';

async function gitClone(book, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  await run('git', ['clone', '--depth', '1', '--no-checkout', `${GIT_REPO_BASE}/${book}.git`, dest]);
  await run('git', ['-C', dest, 'fetch', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
}

async function gitCheckout(dest, branch) {
  await run('git', ['-C', dest, 'checkout', branch]);
}

async function gitEnsureBranch(dest, branch, { force = false } = {}) {
  try {
    const { stdout: current } = await run('git', ['-C', dest, 'branch', '--show-current']);
    const currentBranch = current.trim();
    // `force` is set right after a clone. `gitClone` uses `--no-checkout`, so
    // HEAD already names a branch while the working tree is still empty — and
    // when `ver` happens to equal the repo's default branch, the early return
    // below would skip the checkout entirely and leave a book with no markdown
    // in it. That used to pass silently; `syncBook` now rejects it.
    if (!force && currentBranch === branch) return;
    
    await run('git', ['-C', dest, 'fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    await run('git', ['-C', dest, 'checkout', branch]);
  } catch {
    // Not `--unshallow`. The clone above is `--depth 1`; unshallowing pulls the
    // entire history of a manual repo back down, which is minutes per book on a
    // proxied network — and this catch is reached by any branch-name mismatch,
    // so it is the common path rather than the rare one. One shallow ref is all
    // a checkout needs.
    await run('git', [
      '-C', dest, 'fetch', '--depth', '1', 'origin',
      `refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
    try {
      await run('git', ['-C', dest, 'checkout', '-b', branch, `origin/${branch}`]);
    } catch (err) {
      throw new Error(`Failed to checkout branch ${branch}: ${err.message}`);
    }
  }
}

/**
 * Written only once a book is fully cloned, checked out and confirmed to hold
 * markdown.
 *
 * Without it an interrupted clone is indistinguishable from a finished one:
 * `gitClone` uses `--no-checkout`, so killing opencode between the clone and
 * `gitEnsureBranch` leaves a valid `.git` on disk with no pages in the working
 * tree. `listCached()` then counts that book as present and the initial sync
 * skips it forever — the book silently never becomes searchable. Interrupting
 * is the normal case here, not the rare one: a full sync runs for tens of
 * minutes and the whole point of the redesign is that the user can keep
 * working (and therefore keep quitting) while it does.
 */
const MARKER = '.hrbook-ok';

export function isBookComplete(book) {
  return existsSync(path.join(BOOKS_DIR, book, MARKER));
}

export async function syncBook(book, ver, useGit = false) {
  const dest = path.join(BOOKS_DIR, book);

  if (useGit) {
    // A directory without `.git` is debris, not a repo.
    if (existsSync(dest) && !existsSync(path.join(dest, '.git'))) {
      await rm(dest, { recursive: true, force: true });
    }

    const fresh = !existsSync(dest);
    if (fresh) await gitClone(book, dest);

    // Anything without the marker is either brand new or an interrupted
    // clone, and both leave an empty working tree behind `--no-checkout`.
    // Forcing the checkout is what repairs the interrupted case: without it
    // `gitEnsureBranch` sees HEAD already naming the wanted branch and returns
    // without ever populating the tree, so the book fails on every retry
    // forever. Quitting mid-clone is normal here, so this path has to heal.
    let pages = [];
    try {
      await gitEnsureBranch(dest, ver, { force: true });
      pages = await walkMarkdown(dest);
    } catch {
      pages = [];
    }

    // Still empty — the repo itself is damaged. Throw it away and start over.
    if (pages.length === 0) {
      await rm(dest, { recursive: true, force: true });
      await gitClone(book, dest);
      await gitEnsureBranch(dest, ver, { force: true });
      pages = await walkMarkdown(dest);
    }

    if (pages.length === 0) {
      throw new Error(`${book}/${ver}: checkout produced no markdown`);
    }

    await writeFile(
      path.join(dest, MARKER),
      JSON.stringify({ ver, pages: pages.length, at: new Date().toISOString() }),
      'utf8',
    );
    return pages.length;
  } else {
    const tmp = path.join(CACHE, '.tmp', `${book}-${ver}`);
    const tgz = `${tmp}.tar.gz`;
    const verDest = path.join(dest, ver);

    try {
      await download(`${TARBALL_BASE}/${book}/tar.gz/${ver}`, tgz);
      await rm(tmp, { recursive: true, force: true });
      await mkdir(tmp, { recursive: true });
      await run('tar', ['xzf', tgz, '-C', tmp, '--strip-components=1']);

      const kept = await pruneToMarkdown(tmp);
      await rm(verDest, { recursive: true, force: true });
      await mkdir(path.dirname(verDest), { recursive: true });
      await rename(tmp, verDest);
      return kept;
    } finally {
      await rm(tgz, { force: true });
      await rm(tmp, { recursive: true, force: true });
    }
  }
}

export async function checkoutBook(book, ver) {
  const dest = path.join(BOOKS_DIR, book);
  if (!existsSync(dest)) {
    await syncBook(book, ver, true);
  } else {
    await gitEnsureBranch(dest, ver);
  }
}

export async function getBookCurrentBranch(book) {
  const dest = path.join(BOOKS_DIR, book);
  if (!existsSync(dest)) return null;
  
  const gitDir = path.join(dest, '.git');
  if (!existsSync(gitDir)) return null;
  
  try {
    const { stdout } = await run('git', ['-C', dest, 'branch', '--show-current']);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function checkBookHasUpdates(book, targetBranch) {
  const dest = path.join(BOOKS_DIR, book);
  if (!existsSync(dest)) return { needsSync: true, reason: 'not-cloned' };
  
  const gitDir = path.join(dest, '.git');
  if (!existsSync(gitDir)) return { needsSync: false, reason: 'not-git' };
  
  try {
    await run('git', ['-C', dest, 'fetch', 'origin', targetBranch]);
    const { stdout: local } = await run('git', ['-C', dest, 'rev-parse', 'HEAD']);
    const { stdout: remote } = await run('git', ['-C', dest, 'rev-parse', `origin/${targetBranch}`]);
    
    if (local.trim() !== remote.trim()) {
      return { needsSync: true, reason: 'updates-available' };
    }
    return { needsSync: false, reason: 'up-to-date' };
  } catch {
    return { needsSync: false, reason: 'check-failed' };
  }
}

export async function checkAllBooksUpdates() {
  const infos = await loadBookinfos();
  const fetchable = infos.filter((e) => !e.url);
  
  const byBook = new Map();
  for (const entry of fetchable) {
    if (!byBook.has(entry.book_id)) {
      byBook.set(entry.book_id, entry.ver_id);
    }
  }
  
  const updates = [];
  for (const [bookId, verId] of byBook) {
    const currentBranch = await getBookCurrentBranch(bookId);
    if (!currentBranch) {
      updates.push({ book: bookId, target: verId, current: null, needsSync: true });
    } else {
      const status = await checkBookHasUpdates(bookId, verId);
      if (status.needsSync) {
        updates.push({ book: bookId, target: verId, current: currentBranch, needsSync: true });
      }
    }
  }
  
  return updates;
}

let pendingSyncCount = 0;

export async function checkPendingSync() {
  if (pendingSyncCount > 0) return pendingSyncCount;
  try {
    const updates = await checkAllBooksUpdates();
    pendingSyncCount = updates.length;
    return pendingSyncCount;
  } catch {
    return 0;
  }
}

export function resetPendingSync() {
  pendingSyncCount = 0;
}

export async function writeManifest(entries) {
  await writeFile(
    path.join(CACHE, 'manifest.json'),
    JSON.stringify({ syncedAt: new Date().toISOString(), books: entries }, null, 2),
  );
}

export async function loadSyncManifest() {
  if (!existsSync(SYNC_MANIFEST)) return { lastSync: null, books: {} };
  try {
    return JSON.parse(await readText(SYNC_MANIFEST));
  } catch {
    return { lastSync: null, books: {} };
  }
}

export async function saveSyncManifest(lastSync, books) {
  await mkdir(CACHE, { recursive: true });
  await writeFile(
    SYNC_MANIFEST,
    JSON.stringify({ lastSync, books }, null, 2),
  );
}

export async function syncAllBooks(progressCallback) {
  const infos = await loadBookinfos();
  const cached = await listCached();
  const cachedKeys = new Set(cached.map((c) => `${c.book}/${c.ver}`));
  
  // `const fetchable = infos.filter(fetchable)` shadowed the module-level
  // helper with a const in the same scope, so the initialiser referenced the
  // binding inside its own TDZ and every call threw
  // `ReferenceError: Cannot access 'fetchable' before initialization`.
  const targets = infos.filter((e) => fetchable(e));

  const byBook = new Map();
  for (const entry of targets) {
    if (!byBook.has(entry.book_id)) {
      byBook.set(entry.book_id, new Set());
    }
    byBook.get(entry.book_id).add(entry.ver_id);
  }
  
  const totalBooks = byBook.size;
  const synced = [];
  const failed = [];
  
  if (progressCallback) {
    progressCallback({ type: 'start', total: totalBooks, synced: 0, failed: 0 });
  }
  
  for (const [bookId, versions] of byBook) {
    for (const verId of versions) {
      const key = `${bookId}/${verId}`;
      
      if (cachedKeys.has(key)) {
        if (progressCallback) {
          progressCallback({ type: 'skip', book: bookId, ver: verId, synced: synced.length, failed: failed.length });
        }
        continue;
      }
      
      try {
        await syncBook(bookId, verId);
        synced.push(key);
        if (progressCallback) {
          progressCallback({ type: 'success', book: bookId, ver: verId, synced: synced.length, failed: failed.length });
        }
      } catch (err) {
        failed.push({ book: bookId, ver: verId, error: err.message });
        if (progressCallback) {
          progressCallback({ type: 'error', book: bookId, ver: verId, error: err.message, synced: synced.length, failed: failed.length });
        }
      }
    }
  }
  
  if (progressCallback) {
    progressCallback({ type: 'complete', synced, failed, total: totalBooks });
  }
  
  return { synced, failed, total: totalBooks };
}

export async function checkBookUpdates() {
  const manifest = await loadSyncManifest();
  const infos = await loadBookinfos();
  const updates = [];
  
  for (const entry of infos) {
    if (entry.url) continue;
    
    const key = `${entry.book_id}/${entry.ver_id}`;
    const lastInfo = manifest.books?.[key];
    
    try {
      const { stdout } = await run('curl', [
        '-sI',
        `${TARBALL_BASE}/${entry.book_id}/tar.gz/${entry.ver_id}`,
      ]);
      
      const etagMatch = stdout.match(/ETag:\s*"([^"]+)"/i);
      const currentHash = etagMatch ? etagMatch[1] : null;
      
      if (!lastInfo || lastInfo.hash !== currentHash) {
        updates.push({
          book: entry.book_id,
          ver: entry.ver_id,
          title: entry.title,
          currentHash,
          lastHash: lastInfo?.hash,
        });
      }
    } catch {
      continue;
    }
  }
  
  return updates;
}

export async function updateSyncManifestEntry(book, ver, hash) {
  const manifest = await loadSyncManifest();
  if (!manifest.books) manifest.books = {};
  manifest.books[`${book}/${ver}`] = { hash, syncedAt: new Date().toISOString() };
  await saveSyncManifest(new Date().toISOString(), manifest.books);
}
