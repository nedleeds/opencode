import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * Every manual repository publishes `book.md`: the whole manual concatenated
 * into one file, ~480 KB, with a `[__SOURCE](relative/path.md)` marker in
 * front of each original page. One HTTP GET per manual therefore buys the
 * complete text *and* the page boundaries.
 *
 * That single fact removes the entire clone-based design this plugin used to
 * carry. A full Korean set is 87 files and 7.7 MB — 16 s to fetch, 133 ms to
 * grep — against gigabytes and tens of minutes for `git clone`. It also
 * removes the need to guess which manual a question is about: with every
 * manual on disk, relevance is decided by what the text actually matches
 * rather than by keyword-scoring the catalogue and hoping.
 */

/**
 * On Windows the cache goes on D: rather than C:. `HRBOOK_CACHE` still wins,
 * `HRBOOK_CACHE_DRIVE` picks a different drive, and a machine without that
 * drive falls back to the home directory — so a laptop keeps working with no
 * configuration.
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
export const INDEX_DIR = path.join(CACHE, 'index');
export const BOOKINFOS = path.join(CACHE, 'bookinfos.json');

/** Left over from the clone era. Never written to now — only reported, so a
 *  user can reclaim the gigabytes deliberately rather than by surprise. */
export const LEGACY_BOOKS_DIR = path.join(CACHE, 'books');

const RAW_BASE =
  process.env.HRBOOK_RAW_BASE || 'https://raw.githubusercontent.com/hyundai-robotics';
const BOOKINFOS_URL =
  process.env.HRBOOK_BOOKINFOS_URL ||
  'https://raw.githubusercontent.com/hyundai-robotics/hrbookinfos/master/bookinfos.json';
const VIEWER_BASE = process.env.HRBOOK_VIEWER_BASE || 'https://hrbook-hrc.web.app';

/** Language set fetched first, synchronously. The other one follows in the
 *  background so the first question waits for one set, not two. */
export const PRIMARY_LANG = process.env.HRBOOK_LANG || 'ko';
export const SECONDARY_LANG = process.env.HRBOOK_LANG_2 || 'en';

export const CONCURRENCY = Number(process.env.HRBOOK_CONCURRENCY || 8);

// ------------------------------------------------------------------ transport

/**
 * curl rather than fetch(): Node's fetch ignores HTTP_PROXY/HTTPS_PROXY, and a
 * proxy is the normal case on an internal network. curl honours those plus
 * .curlrc and the system CA store, so it works where fetch silently hangs.
 * `--ssl-no-revoke` is required on Windows, where the corporate firewall
 * blocks the certificate revocation check and curl otherwise fails closed.
 */
const REVOKE = process.platform === 'win32' ? ['--ssl-no-revoke'] : [];

async function download(url, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp`;
  try {
    await run('curl', ['-sSL', '--fail', ...REVOKE, '--max-time', '180', '-o', tmp, url]);
    // Rename last: a half-written index is worse than a missing one, because
    // nothing downstream can tell it is truncated.
    await rename(tmp, dest);
  } finally {
    await rm(tmp, { force: true });
  }
}

/**
 * HEAD, for the freshness check. `content-length` is the whole state: it is
 * compared against the size already on disk, so nothing has to be recorded
 * between runs. An edit that happens to preserve the byte count is missed —
 * acceptable, since such an edit is by definition tiny, and the next real
 * revision catches it.
 */
export async function headInfo(url) {
  const { stdout } = await run('curl', ['-sI', ...REVOKE, '--max-time', '30', url]);
  const status = Number(stdout.match(/^HTTP\/[\d.]+\s+(\d+)/m)?.[1] ?? 0);
  const bytes = Number(stdout.match(/^content-length:\s*(\d+)/im)?.[1] ?? 0);
  return { status, bytes };
}

/**
 * Every file in these repos starts with a UTF-8 BOM. Left in place it breaks
 * JSON.parse on bookinfos.json and — worse — corrupts tool results: OpenCode
 * rejects the whole call with `JSON Parse error: Unrecognized token`.
 */
async function readText(file) {
  return (await readFile(file, 'utf8')).replace(/^\uFEFF/, '');
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

export async function refreshBookinfos() {
  await download(BOOKINFOS_URL, BOOKINFOS);
  return (await loadBookinfos()).length;
}

// ------------------------------------------------------------------ catalogue

/** Entries served as an external PDF have no repository to fetch. */
const fetchable = (e) => !e.url;

/**
 * ver_id uses two naming styles that coexist in bookinfos.json — `ko`/`zh`
 * alongside `korean`/`chinese` — and both may carry a controller or teach
 * pendant suffix (`ko-Hi6`, `ko-tp630`).
 */
const LANG_ALIASES = {
  ko: ['ko', 'korean'],
  en: ['en', 'english'],
  zh: ['zh', 'chinese'],
  de: ['de', 'german'],
};

/**
 * Collapses the controller suffix only. `ko-Hi6` and `ko-Hi7` are the same
 * prose branded for two controllers, so keeping both doubles the bytes and
 * then doubles every search result. A teach-pendant variant like `ko-tp630`
 * is a genuinely different manual and stays distinct.
 */
export function langKey(verId) {
  return String(verId).replace(/-hi\d[a-z]?$/i, '').toLowerCase();
}

export function matchesLang(verId, lang) {
  if (!lang) return true;
  const l = String(lang).toLowerCase();
  return (LANG_ALIASES[l] ?? [l]).some((p) => String(verId).toLowerCase().startsWith(p));
}

/**
 * One entry per (book, language). A book that ships both a Hi6 and a Hi7
 * branch in the same language is the same prose twice — fetching both doubles
 * the bytes and then doubles every search result.
 */
export function booksForLang(infos, lang) {
  const seen = new Set();
  const out = [];
  for (const e of infos) {
    if (!fetchable(e)) continue;
    if (!matchesLang(e.ver_id, lang)) continue;
    const key = `${e.book_id}/${langKey(e.ver_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ book: e.book_id, ver: e.ver_id, title: e.title, variables: e.variables });
  }
  return out;
}

/**
 * Titles alone cannot bridge the vocabulary gap: a user asks about
 * "EtherNet/IP" but the manual is titled "산업용 통신 / Industrial
 * communication", sharing no keyword. Full-text search no longer needs these,
 * but `hrbook_catalog` matches titles only, so they still earn their place.
 */
const TOPIC_ALIASES = [
  {
    book: 'doc-industrial-communication',
    terms: ['ethernet', 'ethernet/ip', 'ethercat', 'profinet', 'profibus', 'cc-link', 'cclink',
      'devicenet', 'modbus', 'fieldbus', 'industrial', '산업용', '통신', '필드버스'],
  },
  { book: 'doc-hi6-open-api', terms: ['api', 'rest', 'http', 'json', 'openapi'] },
  { book: 'doc-hrscript', terms: ['script', 'hrscript', '스크립트'] },
  { book: 'doc-hi6-operation', terms: ['jog', '조그', 'teach', '티칭', 'tp', '조작'] },
];

/**
 * Keyword scoring over the catalogue, kept only for `hrbook_catalog` — a
 * browse-the-titles tool. Search no longer uses it: with every manual indexed
 * locally the text decides relevance, which is why a query like "초기 설정"
 * now works despite matching no title and no alias.
 */
export function rankBooks(query, infos, opts = {}) {
  const { product, lang, limit = 15 } = opts;
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
    const key = `${e.book_id}/${langKey(e.ver_id)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
    if (out.length >= limit) break;
  }
  return out;
}

// --------------------------------------------------------------- index files

export function indexPath(book, ver) {
  return path.join(INDEX_DIR, `${book}@${ver}.md`);
}

/** Written when a repository has no `book.md` at all. Without it the same 404
 *  is re-requested on every question for the rest of time. */
function absentPath(book, ver) {
  return path.join(INDEX_DIR, `${book}@${ver}.none`);
}

export function bookUrl(book, ver) {
  return `${RAW_BASE}/${book}/${ver}/book.md`;
}

export function rawUrl(book, ver, relPath) {
  const rel = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  return `${RAW_BASE}/${book}/${ver}/${rel}`;
}

/** Deep link into the HRBook web viewer for a page. */
export function viewerUrl(book, ver, relPath, contModel) {
  const page = String(relPath).replace(/\\/g, '/').replace(/\.md$/i, '');
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

/** Runs `fn` over `items` with at most `limit` in flight. */
export async function pool(items, limit, fn) {
  const results = [];
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Fetch one manual's index. A 404 is a fact about the repository, not a
 * failure to retry: a few manuals genuinely ship no `book.md`, and they get a
 * marker so the table-of-contents fallback handles them instead.
 */
export async function fetchIndex(book, ver) {
  const dest = indexPath(book, ver);
  try {
    await download(bookUrl(book, ver), dest);
    await rm(absentPath(book, ver), { force: true });
    invalidate(book, ver);
    return { book, ver, ok: true, bytes: (await stat(dest)).size };
  } catch (err) {
    const { status } = await headInfo(bookUrl(book, ver)).catch(() => ({ status: 0 }));
    if (status === 404) {
      await mkdir(INDEX_DIR, { recursive: true });
      await writeFile(absentPath(book, ver), '', 'utf8');
      return { book, ver, ok: false, absent: true };
    }
    return { book, ver, ok: false, error: err.message };
  }
}

export function hasIndex(book, ver) {
  return existsSync(indexPath(book, ver));
}

export function indexAbsent(book, ver) {
  return existsSync(absentPath(book, ver));
}

/** Which entries of a language set still need fetching. */
export function pendingFor(entries) {
  return entries.filter((e) => !hasIndex(e.book, e.ver) && !indexAbsent(e.book, e.ver));
}

export async function fetchIndexSet(entries, { concurrency = CONCURRENCY } = {}) {
  await mkdir(INDEX_DIR, { recursive: true });
  const results = await pool(entries, concurrency, (e) => fetchIndex(e.book, e.ver));
  return {
    ok: results.filter((r) => r.ok),
    absent: results.filter((r) => r.absent),
    failed: results.filter((r) => !r.ok && !r.absent),
  };
}

/**
 * Compare the remote byte count against the copy on disk and re-fetch when it
 * moved. Only ever called for the handful of manuals a question actually hit,
 * so it costs one round trip each rather than one per manual in the set.
 *
 * Failure is deliberately silent: a blocked proxy must degrade to answering
 * from the local index, never to refusing to answer.
 */
export async function refreshIfChanged(book, ver) {
  const local = indexPath(book, ver);
  if (!existsSync(local)) return { book, ver, changed: false, checked: false };
  try {
    const [{ status, bytes }, localStat] = await Promise.all([
      headInfo(bookUrl(book, ver)),
      stat(local),
    ]);
    if (status !== 200 || bytes === 0 || bytes === localStat.size) {
      return { book, ver, changed: false, checked: true };
    }
    await download(bookUrl(book, ver), local);
    invalidate(book, ver);
    return { book, ver, changed: true, checked: true, bytes };
  } catch {
    return { book, ver, changed: false, checked: false };
  }
}

// -------------------------------------------------------------------- search

const SOURCE_RE = /^\[__SOURCE\]\((.+?)\)\s*$/;

/** Every `<book>@<ver>.md` currently on disk, optionally one language only. */
export async function listIndexes(lang) {
  if (!existsSync(INDEX_DIR)) return [];
  const out = [];
  for (const name of await readdir(INDEX_DIR)) {
    if (!name.endsWith('.md')) continue;
    const at = name.lastIndexOf('@');
    if (at < 0) continue;
    const book = name.slice(0, at);
    const ver = name.slice(at + 1, -3);
    if (lang && !matchesLang(ver, lang)) continue;
    out.push({ book, ver });
  }
  return out;
}

/**
 * Split one index into its original pages. The `__SOURCE` marker in front of
 * each page is what makes a hit in the concatenated text addressable: walking
 * back to the nearest marker yields the exact path `hrbook_read` needs, with
 * no table-of-contents lookup and no guessing from heading levels.
 */
export function splitSections(text) {
  const sections = [];
  let current = null;
  // The BOM sits in front of the very first marker. Left in place the opening
  // `[__SOURCE]` fails to match and the whole first page disappears.
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(SOURCE_RE);
    if (m) {
      current = { path: m[1].trim(), heading: '', lines: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (!current.heading && /^#{1,6}\s+/.test(line)) {
      current.heading = line.replace(/^#{1,6}\s+/, '').trim();
    }
    current.lines.push(line);
  }
  return sections;
}

const sectionCache = new Map();

async function loadSections(book, ver) {
  const file = indexPath(book, ver);
  if (!existsSync(file)) return null;
  const { mtimeMs, size } = await stat(file);
  const key = `${book}@${ver}`;
  const hit = sectionCache.get(key);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.sections;
  const sections = splitSections(await readText(file));
  sectionCache.set(key, { mtimeMs, size, sections });
  return sections;
}

/** Dropped when an index is re-fetched, so the next search reads the new text. */
export function invalidate(book, ver) {
  sectionCache.delete(`${book}@${ver}`);
}

function scoreLine(line, terms) {
  const lowered = line.toLowerCase();
  let hit = 0;
  for (const t of terms) if (lowered.includes(t)) hit++;
  return hit;
}

/**
 * Full-text search across the local indexes.
 *
 * Scoring is deliberately plain: a line is worth the number of distinct query
 * terms it contains, and a section takes its best line. Nothing here needs to
 * be clever, because the model receives the surrounding page and decides for
 * itself — the job is to narrow ~8 MB down to a handful of addressable pages.
 */
export async function search(query, opts = {}) {
  const { lang, book, limit = 8 } = opts;
  const terms = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  if (terms.length === 0) return { hits: [], total: 0, scanned: 0 };

  const targets = (await listIndexes(lang)).filter((t) => !book || t.book === book);
  const hits = [];
  let scanned = 0;

  for (const t of targets) {
    const sections = await loadSections(t.book, t.ver);
    if (!sections) continue;
    scanned += sections.length;

    for (const s of sections) {
      let best = 0;
      let bestLine = '';
      for (const line of s.lines) {
        if (!line.trim()) continue;
        const score = scoreLine(line, terms);
        if (score > best) {
          best = score;
          bestLine = line.trim();
        }
        if (best === terms.length) break;
      }
      // A heading match counts even when no body line does — section titles
      // are short and carry the topic.
      const headScore = scoreLine(`${s.heading} ${s.path}`, terms);
      const score = Math.max(best, headScore);
      if (score === 0) continue;
      hits.push({
        book: t.book,
        ver: t.ver,
        path: s.path,
        heading: s.heading,
        score,
        snippet: (bestLine || s.heading).slice(0, 220),
      });
    }
  }

  hits.sort((a, b) => b.score - a.score);
  return { hits: hits.slice(0, limit), total: hits.length, scanned };
}

// ---------------------------------------------------------------- page reads

/**
 * Image links inside `book.md` are still relative to the *original* page, at
 * whatever depth that page sat (`../_assets/x.png`, `../../_assets/x.png`).
 * Concatenation left them untouched, so a section lifted out of the index has
 * to have them resolved against its own `__SOURCE` directory or every image
 * points nowhere.
 *
 * `path.posix` throughout — plain `path.join` on Windows produces backslashes
 * and silently corrupts the URL.
 */
export function absolutiseLinks(text, book, ver, srcPath) {
  const dir = path.posix.dirname(String(srcPath).replace(/\\/g, '/'));
  return text.replace(/(!?\[[^\]]*\])\(([^)]+)\)/g, (whole, label, target) => {
    const url = target.trim();
    if (/^(https?:|mailto:|#|\/)/i.test(url)) return whole;
    const abs = path.posix.normalize(path.posix.join(dir, url));
    return `${label}(${rawUrl(book, ver, abs)})`;
  });
}

export async function readPage(book, ver, relPath, maxBytes = 12000, variables) {
  const sections = await loadSections(book, ver);
  if (!sections) throw new Error(`index not available: ${book}/${ver}`);

  const want = String(relPath).replace(/\\/g, '/').replace(/^\.?\//, '');
  const section =
    sections.find((s) => s.path === want) ||
    sections.find((s) => s.path.replace(/\.md$/i, '') === want.replace(/\.md$/i, ''));
  if (!section) throw new Error(`page not in index: ${book}/${ver}/${relPath}`);

  let text = absolutiseLinks(section.lines.join('\n').trim(), book, ver, section.path);
  text = substitute(text, variables);
  const truncated = text.length > maxBytes;
  return {
    text: truncated ? text.slice(0, maxBytes) : text,
    truncated,
    url: viewerUrl(book, ver, section.path, variables?.cont_model),
  };
}

// ----------------------------------------------- fallback for a missing book.md

export function parseToc(text) {
  const entries = [];
  const re = /\[([^\]]+)\]\(([^)]+\.md)\)/g;
  let m;
  while ((m = re.exec(text.replace(/^\uFEFF/, '')))) {
    const p = m[2].trim();
    if (/^https?:/i.test(p)) continue;
    entries.push({ title: m[1].trim(), path: p.replace(/^\.\//, '') });
  }
  return entries;
}

export async function remoteToc(book, ver) {
  const tmp = path.join(CACHE, '.tmp', `${book}-${ver}-summary.md`);
  try {
    await download(rawUrl(book, ver, 'SUMMARY.md'), tmp);
    return parseToc(await readText(tmp));
  } finally {
    await rm(tmp, { force: true });
  }
}

/** Title/path matching only — used for the manuals that ship no book.md. */
export async function remoteSearch(query, book, ver, limit = 5) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const entries = await remoteToc(book, ver);
  const scored = [];
  for (const e of entries) {
    const score = scoreLine(`${e.title} ${e.path}`, terms);
    if (score > 0) scored.push({ ...e, score, book, ver });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export async function readRemotePage(book, ver, relPath, maxBytes = 12000, variables) {
  const tmp = path.join(CACHE, '.tmp', `${book}-${ver}-page.md`);
  try {
    await download(rawUrl(book, ver, relPath), tmp);
    let text = absolutiseLinks((await readText(tmp)).trim(), book, ver, relPath);
    text = substitute(text, variables);
    const truncated = text.length > maxBytes;
    return {
      text: truncated ? text.slice(0, maxBytes) : text,
      truncated,
      url: viewerUrl(book, ver, relPath, variables?.cont_model),
    };
  } finally {
    await rm(tmp, { force: true });
  }
}

// ------------------------------------------------------------------- cleanup

/** Size of the abandoned clone tree, so the user can be told what reclaiming
 *  it is worth. Reported, never deleted. */
export async function legacyCloneSize() {
  if (!existsSync(LEGACY_BOOKS_DIR)) return 0;
  let total = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else {
        try {
          total += (await stat(full)).size;
        } catch {
          // A file that vanishes mid-walk is not worth failing over.
        }
      }
    }
  };
  try {
    await walk(LEGACY_BOOKS_DIR);
  } catch {
    return total;
  }
  return total;
}

export const langKeyForTest = langKey;
export const matchesLangForTest = matchesLang;
