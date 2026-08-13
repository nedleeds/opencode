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

/**
 * Words that signal the user wants to know *which manual* covers something,
 * rather than what it says — "joint 관련 API 매뉴얼 찾아줘". Full-text search
 * answers that badly: it returns page fragments when the useful answer is a
 * list of manual ids.
 *
 * Detected here rather than instructed in the agent prompt, because a rule the
 * model has to remember is a rule it sometimes forgets, and these words are
 * already being parsed out of the query as stopwords.
 */
const CATALOGUE_SIGNALS = ['매뉴얼', '메뉴얼', '설명서', 'manual', 'manuals'];

export function looksLikeCatalogueQuery(query) {
  const lowered = String(query).toLowerCase();
  if (!CATALOGUE_SIGNALS.some((w) => lowered.includes(w))) return false;
  // "매뉴얼에서 조그 속도 찾아줘" names the source but still asks for content;
  // an interrogative is what marks it as a question about the catalogue.
  return /찾|어떤|어느|있|목록|list|which|what/.test(lowered);
}

/**
 * Words that appear on nearly every page and therefore carry no signal.
 *
 * The model writes the query, and asked "joint 관련 API 매뉴얼 찾아줘" it
 * frequently passes the sentence through rather than the two nouns that
 * matter. Left in, "관련" and "매뉴얼" mean no page covers every term, the
 * search falls back to partial matching, and pages whose only qualification is
 * the word "매뉴얼" flood the result. Stripping them in code is reliable in a
 * way that instructing the model is not.
 */
const STOPWORDS = new Set([
  '관련', '관련된', '매뉴얼', '메뉴얼', '설명서', '문서', '내용', '방법', '사용', '사용법',
  '설명', '정보', '자료', '부분', '경우', '대해', '대한', '위한', '찾아줘', '알려줘',
  '보여줘', '가르쳐줘', '어떻게', '무엇', '뭐야', '뭔지', '어디', '있나', '있어',
  'manual', 'document', 'about', 'related', 'find', 'show', 'tell', 'what', 'where',
  'how', 'the', 'and', 'for', 'with',
]);

/**
 * Korean particles, stripped from the tail of a token.
 *
 * Matching is substring-based, so a query term shorter than the text still
 * hits — "민첩" finds "민첩하게". The reverse is what breaks: "튜닝을" never
 * finds "튜닝". Longest-first, or "으로" would be cut to "으" by the "로" rule.
 */
const PARTICLES = [
  '에서는', '에서의', '으로는', '이라는', '에서', '에게', '으로', '까지', '부터', '보다',
  '이나', '라는', '으론', '한테', '들의', '들을', '들이',
  '은', '는', '이', '가', '을', '를', '의', '에', '와', '과', '도', '만', '로', '랑',
];

function stripParticle(token) {
  for (const p of PARTICLES) {
    if (token.length > p.length + 1 && token.endsWith(p)) return token.slice(0, -p.length);
  }
  return token;
}

/**
 * Turn whatever the model sent into terms worth matching.
 *
 * Each term keeps both its original form and its particle-stripped stem: a
 * page containing either counts, so "튜닝을" and "튜닝" behave the same. If
 * filtering would leave nothing — a query made entirely of stopwords — the raw
 * tokens are used instead, because a bad search beats no search.
 */
export function extractTerms(query) {
  const raw = String(query)
    .toLowerCase()
    .split(/[\s/,.·:;()[\]"']+/)
    .filter(Boolean);

  const terms = [];
  const seen = new Set();
  for (const token of raw) {
    if (STOPWORDS.has(token)) continue;
    const stem = stripParticle(token);
    if (stem.length < 2) continue;
    if (STOPWORDS.has(stem)) continue;
    if (seen.has(stem)) continue;
    seen.add(stem);
    // Both forms, so "튜닝을" matches a page that only ever writes "튜닝".
    terms.push({ text: stem, forms: stem === token ? [stem] : [stem, token] });
  }

  if (terms.length === 0) {
    return raw.filter((t) => t.length > 1).map((t) => ({ text: t, forms: [t] }));
  }
  return terms;
}

/** Korean compounds are written both ways — "민첩 모드" and "민첩모드" — and
 *  which one appears is not consistent across manuals. */
const despace = (s) => s.replace(/\s+/g, '');

function scoreLine(line, terms) {
  const lowered = line.toLowerCase();
  const packed = despace(lowered);
  let score = 0;
  for (const t of terms) {
    if (t.forms.some((f) => lowered.includes(f))) score += 2;
    // Half credit: dropping spaces also joins words that were never one, so a
    // page that spells the compound the same way as the query still wins.
    else if (t.forms.some((f) => packed.includes(despace(f)))) score += 1;
  }
  return score;
}

function matchedTerms(line, terms) {
  const lowered = line.toLowerCase();
  const packed = despace(lowered);
  const out = [];
  for (const t of terms) {
    if (t.forms.some((f) => lowered.includes(f) || packed.includes(despace(f)))) out.push(t.text);
  }
  return out;
}

/**
 * The heading directly above a hit, not the first heading on the page.
 *
 * Manual pages are long and carry many sections: a page whose first heading is
 * "제어 파라미터 설정" may hold "[민첩 모드]" three hundred lines down. Reporting
 * the page's opening heading hides exactly the thing the query matched, and
 * the model — seeing a title with no apparent relation to the question —
 * concludes the manual does not cover it and moves on.
 */
function headingAbove(lines, at) {
  for (let i = at; i >= 0; i--) {
    if (/^#{1,6}\s+/.test(lines[i])) {
      return lines[i]
        .replace(/^#{1,6}\s+/, '')
        .replace(/[*_`]/g, '')
        .trim();
    }
  }
  return '';
}

/** `grep -C`: the hit alone is rarely enough to judge a page by. */
function contextAround(lines, at, radius = 3) {
  const out = [];
  for (let i = Math.max(0, at - radius); i <= Math.min(lines.length - 1, at + radius); i++) {
    const t = lines[i].trim();
    if (t) out.push(t);
  }
  return out.join(' ⏎ ').slice(0, 400);
}

/**
 * Full-text search across the local manuals, grouped by manual and tiered.
 *
 * Three decisions shape this, each from a way the earlier versions failed:
 *
 * 1. **Grouped by manual, with per-manual quotas.** A flat list capped at N
 *    pages lets one verbose manual take every slot — the Open API manual
 *    mentions "모드" everywhere, so the single force-control page holding
 *    "민첩 모드" never appeared and the agent declared the topic absent.
 *
 * 2. **Tiered, not filtered.** Dropping partial matches whenever a complete
 *    one existed answered the wrong question. Someone asking about 부가축 튜닝
 *    wants the 부가축 manual's procedure *and* the force-control manual's gain
 *    parameters; discarding the second because the first matched every term
 *    hides exactly the cross-manual context they were after. Partial matches
 *    are demoted to a second tier and labelled with what they matched.
 *
 * 3. **Weighted coverage, not term count.** Requiring every term punished
 *    detailed queries: five good keywords rarely co-occur on one page, so the
 *    search fell back to noise. Terms are weighted by how rare they are across
 *    the corpus, so missing a common word costs almost nothing while missing a
 *    rare one is decisive — and adding keywords now helps rather than hurts.
 */
export async function search(query, opts = {}) {
  const {
    lang,
    book,
    books,
    perBook = 3,
    perPartialBook = 2,
    maxBooks = 8,
    directThreshold = 0.7,
    limit,
  } = opts;

  const terms = extractTerms(query);
  const empty = { groups: [], bookCount: 0, total: 0, scanned: 0, terms: [], partial: false };
  if (terms.length === 0) return empty;

  const allowed = books?.length ? new Set(books) : null;
  const targets = (await listIndexes(lang)).filter(
    (t) => (!book || t.book === book) && (!allowed || allowed.has(t.book)),
  );

  // --- pass 1: find matches and count how many pages each term appears on ---

  const matches = [];
  const df = new Map(terms.map((t) => [t.text, 0]));
  let scanned = 0;

  for (const t of targets) {
    const sections = await loadSections(t.book, t.ver);
    if (!sections) continue;
    scanned += sections.length;

    for (const s of sections) {
      const covered = new Set();
      let bestLine = -1;
      let bestScore = 0;
      let hitCount = 0;

      for (let i = 0; i < s.lines.length; i++) {
        const line = s.lines[i];
        if (!line.trim()) continue;
        const score = scoreLine(line, terms);
        if (score === 0) continue;
        hitCount++;
        for (const term of matchedTerms(line, terms)) covered.add(term);
        // Ties keep the first occurrence, usually the section heading.
        if (score > bestScore) {
          bestScore = score;
          bestLine = i;
        }
      }

      const title = `${s.heading} ${s.path}`;
      const titleScore = scoreLine(title, terms);
      for (const term of matchedTerms(title, terms)) covered.add(term);
      if (covered.size === 0) continue;

      for (const term of covered) df.set(term, (df.get(term) ?? 0) + 1);
      matches.push({
        book: t.book,
        ver: t.ver,
        path: s.path,
        lines: s.lines,
        heading: s.heading,
        covered,
        hitCount,
        bestLine,
        bestScore,
        titleScore,
      });
    }
  }

  if (matches.length === 0) {
    return { ...empty, scanned, terms: terms.map((t) => ({ term: t.text, pages: 0, idf: 0 })) };
  }

  // --- pass 2: weight terms by rarity, then score ---

  /**
   * Inverse document frequency. A term on 30 pages out of 4000 identifies a
   * topic; a term on 2000 pages identifies nothing. This is what lets a user
   * pile on keywords safely — the common ones simply weigh little.
   *
   * A term matching zero pages keeps a nonzero weight so it still counts
   * against coverage: a query naming something absent from the manuals should
   * not score as though it had been satisfied.
   */
  const idf = new Map();
  for (const t of terms) {
    const pages = df.get(t.text) ?? 0;
    idf.set(t.text, Math.log(1 + scanned / (1 + pages)));
  }
  const totalWeight = terms.reduce((n, t) => n + idf.get(t.text), 0) || 1;

  // The most informative term in the query. A page matching only common words
  // is noise — "설정" alone would drag in half the corpus — so a page must
  // carry something at least moderately distinctive to appear at all.
  const maxIdf = Math.max(...terms.map((t) => idf.get(t.text)));
  const informativeFloor = maxIdf * 0.4;
  const anyInformative = terms.some((t) => idf.get(t.text) >= informativeFloor);

  const scored = [];
  for (const m of matches) {
    const weight = [...m.covered].reduce((n, term) => n + (idf.get(term) ?? 0), 0);
    const ratio = weight / totalWeight;
    const carriesInformative = [...m.covered].some((term) => idf.get(term) >= informativeFloor);
    if (anyInformative && !carriesInformative) continue;

    const heading = m.bestLine >= 0 ? headingAbove(m.lines, m.bestLine) || m.heading : m.heading;
    scored.push({
      book: m.book,
      ver: m.ver,
      path: m.path,
      heading,
      matched: [...m.covered],
      coverage: Number(ratio.toFixed(3)),
      tier: ratio >= directThreshold ? 'direct' : 'partial',
      // Weighted coverage dominates; line clustering and a title match only
      // break ties inside the same band.
      score: Math.round(ratio * 10000 + m.bestScore * 50 + m.titleScore * 25 + Math.min(m.hitCount, 10)),
      hits: m.hitCount,
      snippet:
        m.bestLine >= 0 ? contextAround(m.lines, m.bestLine) : `${m.heading} (${m.path})`,
    });
  }

  if (scored.length === 0) {
    return {
      ...empty,
      scanned,
      terms: terms.map((t) => ({ term: t.text, pages: df.get(t.text) ?? 0, idf: idf.get(t.text) })),
    };
  }

  // --- group by manual, order by tier then strength ---

  const byBook = new Map();
  for (const p of scored) {
    const key = `${p.book}@${p.ver}`;
    if (!byBook.has(key)) {
      byBook.set(key, { book: p.book, ver: p.ver, pages: [], hits: 0, best: 0, matched: new Set() });
    }
    const g = byBook.get(key);
    g.pages.push(p);
    g.hits += p.hits;
    g.best = Math.max(g.best, p.score);
    for (const term of p.matched) g.matched.add(term);
  }

  const groups = [...byBook.values()].map((g) => {
    g.pages.sort((a, b) => b.score - a.score);
    g.pageTotal = g.pages.length;
    g.tier = g.pages[0].tier;
    g.matched = [...g.matched];
    return g;
  });

  // Manuals that cover the question come first; the rest follow as context
  // rather than being thrown away.
  groups.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === 'direct' ? -1 : 1;
    return b.best - a.best || b.hits - a.hits;
  });

  const kept = groups.slice(0, maxBooks);
  let budget = limit ?? Infinity;
  for (const g of kept) {
    const quota = Math.min(g.tier === 'direct' ? perBook : perPartialBook, budget);
    g.pages = g.pages.slice(0, Math.max(0, quota));
    budget -= g.pages.length;
  }

  return {
    groups: kept,
    bookCount: groups.length,
    directCount: groups.filter((g) => g.tier === 'direct').length,
    total: scored.length,
    scanned,
    partial: !groups.some((g) => g.tier === 'direct'),
    terms: terms.map((t) => ({
      term: t.text,
      pages: df.get(t.text) ?? 0,
      idf: Number((idf.get(t.text) ?? 0).toFixed(2)),
    })),
  };
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

/**
 * GitBook hint blocks carry the safety warnings. A model summarising a
 * procedure will drop them as boilerplate unless something insists, and on a
 * robot controller that omission is the dangerous kind — so their presence is
 * flagged out of band rather than left to be noticed in the prose.
 */
export function hasWarning(text) {
  return /\{%\s*hint\s+style=["'](?:danger|warning|caution)["']/i.test(text);
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
    warning: hasWarning(text),
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
