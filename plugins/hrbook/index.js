import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '../../tool.js';
import {
  AUTOSYNC,
  CACHE,
  isBookComplete,
  listCached,
  loadBookinfos,
  rankBooks,
  readPage,
  search,
  searchWithAutoSync,
  checkoutBook,
  syncBook,
} from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const z = tool.schema;

/**
 * Where the sidebar — or anything else outside this process — reads progress
 * from. A TUI sidebar cannot be shipped from here (opencode's external TUI
 * plugin layer does not reliably load), so the state is published as a file
 * and whatever renders it can be swapped in later without touching this
 * plugin.
 */
const STATUS_FILE = path.join(CACHE, 'sync-status.json');

/**
 * Guards the cache against two opencode instances syncing at once. `gitLock`
 * below only serialises within one process; two terminals both start with
 * `syncStarted = false` and would clone into the same directory.
 *
 * Refreshed as each book starts, so a crash leaves a lock that expires rather
 * than one that blocks forever. The TTL has to exceed the slowest single book;
 * with the `--depth 1` fetch in lib.js that is well under a minute.
 */
const LOCK_FILE = path.join(CACHE, 'sync.lock');
const LOCK_TTL_MS = 10 * 60 * 1000;

async function agentConfig() {
  return {
    // No `name` field — the key under `cfg.agent` is the agent's name, and a
    // second one here breaks every prompt sent to the agent. See the root
    // README, "Adding a plugin".
    description:
      'HD현대로보틱스 Hi6/Hi7 제어기 메뉴얼 Q&A. 조작·기능·Open API 등에 대한 질문에 사용.',
    mode: 'primary',
    prompt: await readFile(path.join(HERE, 'agent.md'), 'utf8'),
    // `permission`, not `tools`. In opencode 1.18 an agent's tool list is
    // derived from its permission ruleset (Permission.visibleTools), and the
    // `tools` shorthand is folded into permissions while the config documents
    // are parsed — before any plugin runs. A `tools` map set from here is
    // therefore read by nobody and silently does nothing.
    permission: { edit: 'deny', bash: 'deny' },
  };
}

/**
 * Every git invocation in this plugin queues behind the previous one.
 *
 * Without it the background sync and a tool call reach the same
 * `books/<book>/.git` at the same time, collide on `index.lock`, and the tool
 * call stalls — which is what the model renders as an endless "Thinking".
 * Serial git costs nothing here: these are network-bound clones against one
 * host, and running them in parallel mostly multiplies the proxy's load.
 */
let gitLock = Promise.resolve();
function withGitLock(fn) {
  const run = gitLock.then(fn, fn);
  gitLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Shared between the background sync and every tool, so a tool can answer
 *  "still downloading" instantly instead of blocking on a clone. */
const progress = {
  active: false,
  total: 0,
  done: 0,
  failed: 0,
  current: null,
  finished: [],
  failedBooks: [],
  startedAt: null,
  finishedAt: null,
};

export const HrBookPlugin = async ({ client }) => {
  let syncStarted = false;

  /**
   * `client.tui.*` reaches the TUI over the server's HTTP API and therefore
   * throws whenever no TUI is attached — `opencode run`, `serve`, `web`,
   * `attach`. One failure disables it for the rest of the process rather than
   * paying a failed round trip on every book.
   */
  let tuiAlive = true;
  const toast = async (message, variant = 'info') => {
    if (!tuiAlive) return false;
    try {
      await client.tui.showToast({ body: { message, variant } });
      return true;
    } catch {
      tuiAlive = false;
      return false;
    }
  };

  const log = (message, level = 'info') =>
    client.app.log({ body: { service: 'hrbook', level, message } }).catch(() => {});

  async function publishStatus() {
    try {
      await mkdir(path.dirname(STATUS_FILE), { recursive: true });
      await writeFile(
        STATUS_FILE,
        JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch {
      // A missing status file must never break the sync.
    }
  }

  async function touchLock() {
    try {
      await mkdir(CACHE, { recursive: true });
      await writeFile(
        LOCK_FILE,
        JSON.stringify({ pid: process.pid, at: Date.now() }),
        'utf8',
      );
    } catch {
      // Losing the lock file degrades to the old behaviour; it must not throw.
    }
  }

  /** False when another live instance already holds the lock. */
  async function acquireLock() {
    try {
      const held = JSON.parse(await readFile(LOCK_FILE, 'utf8'));
      if (held.pid !== process.pid && Date.now() - held.at < LOCK_TTL_MS) return false;
    } catch {
      // Absent, unreadable or corrupt — treat as free.
    }
    await touchLock();
    return true;
  }

  const releaseLock = () => rm(LOCK_FILE, { force: true }).catch(() => {});

  /**
   * Books in the catalogue that are not yet completely on disk — read from the
   * local filesystem only, no network.
   *
   * Completeness comes from `isBookComplete()` (the `.hrbook-ok` marker) and
   * not from `listCached()`. A clone interrupted partway leaves a valid `.git`
   * with an empty working tree, which `listCached()` happily reports as a
   * cached book — so the book would be skipped on every subsequent run and
   * never become searchable. Quitting mid-sync is expected here, so this has
   * to be the durable check.
   *
   * The previous version also called `checkAllBooksUpdates()` at this point,
   * which runs a `git fetch` plus two `rev-parse` per already-cloned book, in
   * series. On a corporate network that is minutes of silence before the first
   * toast fires. Update checking belongs in `hrbook-sync --check`, not startup.
   */
  async function missingBooks() {
    const infos = await loadBookinfos();
    const byBook = new Map();
    for (const e of infos) {
      if (e.url) continue; // content lives at an external URL, not fetchable
      if (isBookComplete(e.book_id)) continue;
      if (!byBook.has(e.book_id)) byBook.set(e.book_id, e.ver_id);
    }
    return [...byBook.entries()].map(([book, ver]) => ({ book, ver }));
  }

  async function runInitialSync() {
    if (syncStarted) return;
    syncStarted = true;

    let holdsLock = false;
    try {
      const missing = await missingBooks();
      if (missing.length === 0) {
        await log('initial sync: nothing missing');
        return;
      }

      holdsLock = await acquireLock();
      if (!holdsLock) {
        await log('initial sync skipped: another opencode instance holds the lock');
        return;
      }

      Object.assign(progress, {
        active: true,
        total: missing.length,
        done: 0,
        failed: 0,
        current: null,
        finished: [],
        failedBooks: [],
        startedAt: new Date().toISOString(),
        finishedAt: null,
      });
      await publishStatus();

      await toast(`매뉴얼 ${missing.length}개 다운로드를 시작합니다`, 'info');
      await log(`initial sync: ${missing.length} book(s) incomplete`);

      for (const { book, ver } of missing) {
        const n = progress.done + progress.failed + 1;
        progress.current = book;
        await touchLock();
        await publishStatus();
        await toast(`내려받는 중 (${n}/${progress.total}) — ${book}`, 'info');

        try {
          await withGitLock(() => syncBook(book, ver, true));
          progress.done++;
          progress.finished.push(book);
        } catch (err) {
          progress.failed++;
          progress.failedBooks.push(book);
          await log(`sync failed ${book}/${ver}: ${err.message}`, 'warn');
        }
        await publishStatus();
      }

      progress.current = null;
      progress.active = false;
      progress.finishedAt = new Date().toISOString();
      await publishStatus();

      await toast(
        `동기화 완료 — 성공 ${progress.done}건, 실패 ${progress.failed}건`,
        progress.failed > 0 ? 'error' : 'success',
      );
      await log(`initial sync done: ${progress.done} ok, ${progress.failed} failed`);
    } catch (err) {
      progress.active = false;
      progress.current = null;
      await publishStatus();
      await toast(`동기화 준비 실패: ${err.message}`, 'error');
      await log(`initial sync aborted: ${err.message}`, 'error');
    } finally {
      if (holdsLock) await releaseLock();
    }
  }

  const stillSyncing = (book) =>
    `${book} 는 아직 내려받는 중입니다 (${progress.done + progress.failed}/${progress.total}). ` +
    `잠시 후 다시 시도하거나, 이미 받아진 다른 매뉴얼로 답하세요.`;

  /**
   * Any event that can only fire once a client is attached. Several are listed
   * because which one arrives first varies by opencode version, and the
   * `syncStarted` flag makes the extras free.
   */
  const TRIGGERS = new Set([
    'server.connected',
    'session.created',
    'session.updated',
    'message.updated',
  ]);

  return {
    async config(cfg) {
      cfg.agent = cfg.agent ?? {};

      const defaults = await agentConfig();
      const existing = cfg.agent.HRBook ?? {};
      cfg.agent.HRBook = {
        ...defaults,
        ...existing,
        permission: { ...defaults.permission, ...existing.permission },
      };

      // No side effects here. `config` runs while opencode resolves its
      // configuration, before any client has connected, so a toast fired from
      // this point has nowhere to go.
    },

    async event({ event }) {
      if (syncStarted) return;
      if (!TRIGGERS.has(event.type)) return;
      // Deliberately not awaited: this hook runs inline in opencode's event
      // pipeline, and awaiting a multi-minute clone here freezes the TUI.
      void runInitialSync();
    },

    tool: {
      hrbook_search: tool({
        description:
          'Search cached HD Hyundai Robotics Hi6/Hi7 controller manuals. Returns book_id, ver_id, page path, heading, snippet and viewer link.',
        args: {
          query: z.string().describe('Keywords only, e.g. "api_ver" or "조그 속도"'),
          product: z.enum(['hi6', 'hi7', 'hi5a', 'common', 'manipulator']).optional(),
          lang: z.string().optional().describe('Language prefix of ver_id: ko, en, zh'),
          book_id: z.string().optional().describe('Restrict to one book, e.g. doc-hi6-open-api'),
          limit: z.number().int().min(1).max(20).optional().describe('Default 8'),
        },
        async execute(args) {
          const opts = {
            product: args.product,
            lang: args.lang,
            book: args.book_id,
            limit: args.limit,
          };

          // While the background sync holds the git lock, search the local
          // cache only. `searchWithAutoSync` would queue behind the clone and
          // hang the turn for as long as the download takes.
          const { hits, scanned, total, synced } = progress.active
            ? await search(args.query, opts)
            : await searchWithAutoSync(args.query, opts);

          if (hits.length === 0) {
            const cached = await listCached();
            if (cached.length === 0) {
              return progress.active
                ? `아직 받아진 매뉴얼이 없습니다. 동기화 진행 중 (${progress.done + progress.failed}/${progress.total}). 사용자에게 잠시 후 다시 시도해 달라고 안내하세요.`
                : 'No manuals cached. Run `hrbook-sync --defaults` first.';
            }
            // Spell out the boundary. Left to a bare "no match", models fill
            // the gap from training data and invent page paths and viewer
            // links — for controller manuals that is worse than saying nothing.
            const list = cached.map((c) => `${c.book}/${c.ver}`).join(', ');
            return [
              `No match for "${args.query}" in ${scanned} pages.`,
              progress.active
                ? `Sync in progress (${progress.done + progress.failed}/${progress.total}); more manuals become searchable shortly.`
                : AUTOSYNC
                  ? 'Auto-sync found no manual to fetch for these keywords.'
                  : 'Auto-sync is disabled (HRBOOK_AUTOSYNC=0).',
              `Cached manuals: ${list}.`,
              'Retry ONCE with fewer keywords. If it still misses, use hrbook_catalog to find the right',
              'manual, then tell the user to run `hrbook-sync <book_id> <ver_id>`.',
              'Do NOT answer from memory and do NOT invent page paths or viewer links.',
            ].join('\n');
          }

          const body = hits
            .map(
              (h) =>
                `- book_id=${h.book} ver_id=${h.ver} path=${h.path}\n  ${h.heading || h.title}\n  ${h.snippet}\n  ${h.url}`,
            )
            .join('\n');
          const note = synced?.length ? `(auto-synced ${synced.join(', ')})\n` : '';
          const more = total > hits.length ? `\n(${total - hits.length} more)` : '';
          return `${note}${hits.length}/${total} match(es) in ${scanned} pages:\n${body}${more}`;
        },
      }),

      hrbook_read: tool({
        description:
          'Read one cached manual page as markdown. Use book_id/ver_id/path exactly as returned by hrbook_search.',
        args: {
          book_id: z.string().describe('e.g. doc-hi6-open-api'),
          ver_id: z.string().describe('e.g. en, ko, en-tp630'),
          path: z.string().describe('e.g. 1-version/1-get/1-api_ver.md'),
          maxBytes: z.number().int().min(500).max(40000).optional().describe('Default 12000'),
        },
        async execute(args) {
          if (progress.active && !isBookComplete(args.book_id)) {
            return stillSyncing(args.book_id);
          }
          await withGitLock(() => checkoutBook(args.book_id, args.ver_id));
          const { text, truncated, url } = await readPage(
            args.book_id,
            args.ver_id,
            args.path,
            args.maxBytes,
          );
          return `${url}\n\n${text}${truncated ? '\n\n[truncated — raise maxBytes for more]' : ''}`;
        },
      }),

      hrbook_checkout: tool({
        description:
          'Checkout a specific branch (language/version) of a cloned manual. Use when you need to switch to a different language.',
        args: {
          book_id: z.string().describe('e.g. doc-hi6-open-api'),
          ver_id: z.string().describe('e.g. en, ko, en-tp630'),
        },
        async execute(args) {
          if (progress.active && !isBookComplete(args.book_id)) {
            return stillSyncing(args.book_id);
          }
          await withGitLock(() => checkoutBook(args.book_id, args.ver_id));
          return `Checked out ${args.book_id} to branch ${args.ver_id}`;
        },
      }),

      /**
       * The full catalogue is ~5.4k tokens, so it is never put in the system
       * prompt. It is reachable here, filtered, and only when the code-side
       * matching in hrbook_search has already failed — a rare path.
       */
      hrbook_catalog: tool({
        description:
          'Find which manual covers a topic when hrbook_search misses. Lists matching book_id/ver_id from the full catalogue, and marks what is cached.',
        args: {
          filter: z
            .string()
            .describe('Keyword matched against book_id and title, e.g. "weld" or "통신"'),
          product: z.enum(['hi6', 'hi7', 'hi5a', 'common', 'manipulator']).optional(),
          lang: z.string().optional().describe('Language prefix of ver_id: ko, en, zh'),
        },
        async execute(args) {
          const infos = await loadBookinfos();
          const cached = new Set((await listCached()).map((c) => `${c.book}/${c.ver}`));
          const ranked = rankBooks(args.filter, infos, {
            product: args.product,
            lang: args.lang,
            limit: 15,
          });
          if (ranked.length === 0) return `No manual matches "${args.filter}".`;
          const rows = ranked
            .map((e) => {
              const key = `${e.book_id}/${e.ver_id}`;
              return `- book_id=${e.book_id} ver_id=${e.ver_id}${cached.has(key) ? ' [cached]' : ''} — ${e.title}`;
            })
            .join('\n');
          return `${ranked.length} manual(s) matching "${args.filter}":\n${rows}\n\nUncached ones are fetched automatically on the next hrbook_search, or run \`hrbook-sync <book_id> <ver_id>\`.`;
        },
      }),

      hrbook_status: tool({
        description:
          '매뉴얼 동기화 진행 상황을 조회한다. 사용자가 진행률·남은 개수·실패 여부를 물을 때 사용.',
        args: {},
        async execute() {
          const cached = await listCached();
          if (!progress.active) {
            const incomplete = await missingBooks();
            const lines = [
              `동기화 진행 중이 아닙니다. 캐시된 매뉴얼 ${cached.length}개.`,
              incomplete.length
                ? `미완료 ${incomplete.length}개: ${incomplete.map((m) => m.book).join(', ')}`
                : null,
              progress.failedBooks.length ? `직전 실패: ${progress.failedBooks.join(', ')}` : null,
              existsSync(LOCK_FILE) ? '다른 opencode 인스턴스가 동기화 중일 수 있습니다.' : null,
              `캐시 위치: ${CACHE}`,
            ];
            return lines.filter(Boolean).join('\n');
          }
          const seen = progress.done + progress.failed;
          return [
            `동기화 진행 중: ${seen}/${progress.total}`,
            progress.current ? `현재 내려받는 중: ${progress.current}` : null,
            progress.finished.length ? `완료: ${progress.finished.join(', ')}` : null,
            progress.failedBooks.length ? `실패: ${progress.failedBooks.join(', ')}` : null,
            `검색 가능한 매뉴얼: ${cached.length}개`,
            `상태 파일: ${STATUS_FILE}`,
          ]
            .filter(Boolean)
            .join('\n');
        },
      }),
    },
  };
};

export default HrBookPlugin;
