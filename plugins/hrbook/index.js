import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '../../tool.js';
import {
  CACHE,
  isBookComplete,
  listCached,
  loadBookinfos,
  rankBooks,
  readPage,
  readRemotePage,
  remoteSearch,
  search,
  checkoutBook,
  syncBook,
} from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const z = tool.schema;

/**
 * Published for anything outside this process — a TUI sidebar, a statusline, a
 * dashboard. opencode's external TUI plugin layer does not load reliably, so
 * the renderer is deliberately not this plugin's problem.
 */
const STATUS_FILE = path.join(CACHE, 'sync-status.json');

/** How many manuals one question may pull in. Keeps a vague query from
 *  queueing the whole catalogue. */
const MAX_ENQUEUE_PER_QUERY = 3;

/** The line the model must relay so the user understands why an answer came
 *  over the network and what changes once the download lands. */
const REMOTE_NOTICE =
  '이 내용은 캐싱 전이라 원격 매뉴얼에서 직접 가져왔습니다. ' +
  '캐싱이 완료되면 이후 답변은 로컬 캐시에서 즉시 제공됩니다.';

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
 * Serialises every git invocation in this process.
 *
 * Two clones in the same `books/<book>/.git` collide on `index.lock` and the
 * caller stalls — which the model renders as an endless "Thinking". These are
 * network-bound clones against one host anyway, so serial costs nothing.
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

/** Download state, shared between the worker and every tool so a tool can
 *  answer immediately instead of blocking on a clone. */
const state = {
  current: null,
  queued: [],
  done: [],
  failed: [],
};

/** First line of an error, short enough to read in a toast. */
const brief = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 60);

export const HrBookPlugin = async ({ client }) => {
  /**
   * `client.tui.*` reaches the TUI over the server's HTTP API and throws when
   * no TUI is attached — `opencode run`, `serve`, `web`, `attach`, and briefly
   * at startup. It does not latch off on the first failure, because downloads
   * can begin before the TUI has connected; it gives up only after a long run
   * of consecutive failures and resets as soon as one lands.
   *
   * The try/catch also covers `client` being absent entirely, which is how
   * tests and any host that calls the factory bare would otherwise take the
   * whole plugin down at load time.
   */
  let toastFailures = 0;
  const TOAST_GIVE_UP_AFTER = 30;
  const toast = async (message, variant = 'info') => {
    if (toastFailures >= TOAST_GIVE_UP_AFTER) return false;
    try {
      await client.tui.showToast({ body: { message, variant } });
      toastFailures = 0;
      return true;
    } catch {
      toastFailures++;
      return false;
    }
  };

  const log = async (message, level = 'info') => {
    try {
      await client.app.log({ body: { service: 'hrbook', level, message } });
    } catch {
      // Logging must never be the reason something fails.
    }
  };

  async function publishStatus() {
    try {
      await mkdir(path.dirname(STATUS_FILE), { recursive: true });
      await writeFile(
        STATUS_FILE,
        JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
        'utf8',
      );
    } catch {
      // A missing status file must never break a download.
    }
  }

  // ------------------------------------------------------------ download queue

  const queue = [];
  let workerRunning = false;

  /**
   * Never awaited by a tool. The whole point is that a question returns
   * immediately — from cache, or from the remote fallback — while the manuals
   * it needs arrive in the background.
   */
  function runWorker() {
    if (workerRunning) return;
    workerRunning = true;

    void (async () => {
      let batchDone = 0;
      let batchFailed = 0;
      try {
        while (queue.length > 0) {
          const { book, ver } = queue.shift();
          state.queued = queue.map((j) => j.book);
          state.current = book;
          await publishStatus();

          const remaining = queue.length;
          await toast(
            remaining > 0
              ? `매뉴얼 내려받는 중 — ${book} (대기 ${remaining}개)`
              : `매뉴얼 내려받는 중 — ${book}`,
            'info',
          );

          try {
            const pages = await withGitLock(() => syncBook(book, ver, true));
            batchDone++;
            state.done.push(book);
            await toast(`${book} 캐싱 완료 (${pages} 페이지)`, 'success');
            await log(`cached ${book}/${ver} — ${pages} pages`);
          } catch (err) {
            batchFailed++;
            state.failed.push(book);
            // The reason belongs in the toast: a blocked host and a bad branch
            // name need different fixes, and without it the user has to go
            // digging in the logs to tell them apart.
            await toast(`${book} 캐싱 실패 — ${brief(err)}`, 'error');
            await log(`sync failed ${book}/${ver}: ${err.message}`, 'warn');
          }

          state.current = null;
          await publishStatus();
        }
      } finally {
        workerRunning = false;
        state.current = null;
        state.queued = [];
        await publishStatus();

        // A whole batch failing is one shared cause — usually the network or a
        // missing mirror — not N independent problems. Saying so once stops
        // the user chasing each book separately.
        if (batchFailed > 0 && batchDone === 0) {
          await toast(
            `매뉴얼 ${batchFailed}개 모두 실패. 네트워크 또는 미러 설정(HRBOOK_RAW_BASE, HRBOOK_TARBALL_BASE)을 확인하세요.`,
            'error',
          );
        }
      }
    })();
  }

  const isQueued = (book) => state.current === book || queue.some((j) => j.book === book);

  /** Returns true if this call put the book on the queue. */
  function enqueue(book, ver) {
    if (isBookComplete(book)) return false;
    if (isQueued(book)) return false;
    // A book that already failed this session is not retried automatically;
    // hammering a blocked host on every question helps nobody. `hrbook_status`
    // reports it and `hrbook-sync <book> <ver>` retries it deliberately. The
    // remote fallback keeps answering meanwhile.
    if (state.failed.includes(book)) return false;
    queue.push({ book, ver });
    state.queued = queue.map((j) => j.book);
    runWorker();
    return true;
  }

  /**
   * Which manuals this question is about, restricted to ones not on disk.
   *
   * A named `book_id` always counts. Otherwise a local miss takes the top
   * candidates and a local hit takes only strong ones, so a question already
   * answerable from cache does not drag in half the catalogue.
   */
  async function missingCandidates(query, opts, hadHits) {
    const infos = await loadBookinfos();
    const named = opts.book ? infos.filter((e) => e.book_id === opts.book) : [];
    const ranked = rankBooks(query, infos, {
      product: opts.product,
      lang: opts.lang,
      limit: MAX_ENQUEUE_PER_QUERY,
    });
    const pool = [...named, ...(hadHits ? ranked.filter((e) => e.score >= 4) : ranked)];

    const out = [];
    const seen = new Set();
    for (const e of pool) {
      if (seen.has(e.book_id)) continue;
      seen.add(e.book_id);
      if (isBookComplete(e.book_id)) continue;
      out.push({ book: e.book_id, ver: e.ver_id });
      if (out.length >= MAX_ENQUEUE_PER_QUERY) break;
    }
    return out;
  }

  /** One line appended to a tool result so the model can describe the download
   *  without inventing details. */
  function pendingNote(justQueued) {
    const parts = [];
    if (justQueued.length > 0) {
      parts.push(`캐싱 시작: ${justQueued.map((j) => j.book).join(', ')}`);
    }
    if (state.current) parts.push(`현재 캐싱 중: ${state.current}`);
    if (queue.length > 0) parts.push(`대기 ${queue.length}개`);
    if (parts.length === 0) return '';
    return `\n\n[HRBook] ${parts.join(' / ')}\n${REMOTE_NOTICE}\n기다리지 말고 지금 답하세요.`;
  }

  /**
   * Search the remote table of contents for candidate books. One HTTP round
   * trip per book — the TOC lists every page with its title, which is enough
   * to hand the model exact paths to read.
   */
  async function remoteLookup(query, candidates, limitPerBook = 3) {
    const out = [];
    for (const c of candidates) {
      try {
        const hits = await remoteSearch(query, c.book, c.ver, limitPerBook);
        for (const h of hits) out.push({ ...h, book: c.book, ver: c.ver });
      } catch (err) {
        await log(`remote lookup failed ${c.book}/${c.ver}: ${err.message}`, 'warn');
      }
    }
    return out;
  }

  await log(`hrbook loaded — cache: ${CACHE}`);

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

      // No side effects. Nothing is downloaded until a question asks for it.
    },

    tool: {
      hrbook_search: tool({
        description:
          'Search HD Hyundai Robotics Hi6/Hi7 controller manuals. Searches the local cache first; if a relevant manual is not cached it starts downloading in the background AND searches it remotely so the question can still be answered now. Never waits for a download.',
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

          // Local first. Always returns in milliseconds.
          const { hits, scanned, total } = await search(args.query, opts);

          // Queue whatever is missing, then look it up remotely so the answer
          // does not have to wait for the clone.
          let candidates = [];
          const justQueued = [];
          try {
            candidates = await missingCandidates(args.query, opts, hits.length > 0);
            for (const c of candidates) {
              if (enqueue(c.book, c.ver)) justQueued.push(c);
            }
          } catch (err) {
            await log(`candidate lookup failed: ${err.message}`, 'warn');
          }

          const local = hits.length
            ? `${hits.length}/${total} match(es) in ${scanned} cached pages:\n` +
              hits
                .map(
                  (h) =>
                    `- book_id=${h.book} ver_id=${h.ver} path=${h.path}\n  ${h.heading || h.title}\n  ${h.snippet}\n  ${h.url}`,
                )
                .join('\n') +
              (total > hits.length ? `\n(${total - hits.length} more)` : '')
            : `No match for "${args.query}" in ${scanned} cached pages.`;

          const remote = candidates.length ? await remoteLookup(args.query, candidates) : [];
          const remoteBlock = remote.length
            ? '\n\n아직 캐싱되지 않은 매뉴얼에서 찾은 결과 (원격, hrbook_read 로 바로 읽을 수 있음):\n' +
              remote
                .map((r) => `- book_id=${r.book} ver_id=${r.ver} path=${r.path}\n  ${r.title}`)
                .join('\n')
            : '';

          if (!hits.length && !remote.length) {
            const cached = await listCached();
            return (
              [
                local,
                cached.length
                  ? `Cached manuals: ${cached.map((c) => `${c.book}/${c.ver}`).join(', ')}.`
                  : '캐시된 매뉴얼이 아직 없습니다.',
                // Spell out the boundary. Left to a bare "no match", models
                // fill the gap from training data and invent page paths and
                // viewer links — for controller manuals that is worse than
                // saying nothing.
                'Retry ONCE with fewer keywords, then use hrbook_catalog to find the right manual.',
                'Do NOT answer from memory and do NOT invent page paths or viewer links.',
              ].join('\n') + pendingNote(justQueued)
            );
          }

          return local + remoteBlock + pendingNote(justQueued);
        },
      }),

      hrbook_read: tool({
        description:
          'Read one manual page as markdown. Reads from the local cache when the manual is cached, and fetches the page over the network when it is not — either way it returns the content, so never skip a page just because it is uncached.',
        args: {
          book_id: z.string().describe('e.g. doc-hi6-open-api'),
          ver_id: z.string().describe('e.g. en, ko, en-tp630'),
          path: z.string().describe('e.g. 1-version/1-get/1-api_ver.md'),
          maxBytes: z.number().int().min(500).max(40000).optional().describe('Default 12000'),
        },
        async execute(args) {
          const cached = isBookComplete(args.book_id);

          if (!cached) {
            enqueue(args.book_id, args.ver_id);
            try {
              const { text, truncated, url } = await readRemotePage(
                args.book_id,
                args.ver_id,
                args.path,
                args.maxBytes,
              );
              return (
                `${url}\n\n${text}${truncated ? '\n\n[truncated — raise maxBytes for more]' : ''}` +
                `\n\n[HRBook] ${REMOTE_NOTICE}\n이 안내를 사용자에게 한 문장으로 전달하세요.`
              );
            } catch (err) {
              await log(`remote read failed ${args.book_id}/${args.ver_id}: ${err.message}`, 'warn');
              return (
                `${args.book_id}/${args.ver_id}/${args.path} 를 원격에서도 가져오지 못했습니다 (${brief(err)}).\n` +
                `백그라운드 캐싱은 계속 진행 중입니다. 이미 캐시된 매뉴얼로 답하거나, 사용자에게 잠시 후 다시 질문해 달라고 안내하세요.`
              );
            }
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
          'Checkout a specific branch (language/version) of a cached manual. Use when you need to switch to a different language.',
        args: {
          book_id: z.string().describe('e.g. doc-hi6-open-api'),
          ver_id: z.string().describe('e.g. en, ko, en-tp630'),
        },
        async execute(args) {
          if (!isBookComplete(args.book_id)) {
            const queued = enqueue(args.book_id, args.ver_id);
            return (
              `${args.book_id} 는 아직 캐싱되지 않았습니다.${queued ? ' 백그라운드 캐싱을 시작했습니다.' : ''}\n` +
              `그동안 hrbook_read 로 해당 ver_id 페이지를 원격에서 바로 읽을 수 있습니다.`
            );
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
          'Find which manual covers a topic when hrbook_search misses. Lists matching book_id/ver_id from the full catalogue, and marks what is cached or downloading.',
        args: {
          filter: z
            .string()
            .describe('Keyword matched against book_id and title, e.g. "weld" or "통신"'),
          product: z.enum(['hi6', 'hi7', 'hi5a', 'common', 'manipulator']).optional(),
          lang: z.string().optional().describe('Language prefix of ver_id: ko, en, zh'),
        },
        async execute(args) {
          const infos = await loadBookinfos();
          const ranked = rankBooks(args.filter, infos, {
            product: args.product,
            lang: args.lang,
            limit: 15,
          });
          if (ranked.length === 0) return `No manual matches "${args.filter}".`;
          const rows = ranked
            .map((e) => {
              const mark = isBookComplete(e.book_id)
                ? ' [cached]'
                : isQueued(e.book_id)
                  ? ' [caching]'
                  : '';
              return `- book_id=${e.book_id} ver_id=${e.ver_id}${mark} — ${e.title}`;
            })
            .join('\n');
          return `${ranked.length} manual(s) matching "${args.filter}":\n${rows}\n\nUncached ones can still be read with hrbook_read; caching starts automatically on the next hrbook_search.`;
        },
      }),

      hrbook_status: tool({
        description:
          '매뉴얼 캐싱 상태를 조회한다. 사용자가 진행 상황·남은 개수·실패 여부를 물을 때 사용.',
        args: {},
        async execute() {
          const cached = await listCached();
          return [
            state.current ? `캐싱 중: ${state.current}` : '캐싱 중인 매뉴얼 없음',
            queue.length ? `대기: ${queue.map((j) => j.book).join(', ')}` : null,
            state.done.length ? `이번 세션 완료: ${state.done.join(', ')}` : null,
            state.failed.length
              ? `실패: ${state.failed.join(', ')} (재시도: hrbook-sync <book_id> <ver_id>)`
              : null,
            `캐시된 매뉴얼: ${cached.length}개`,
            `캐시 위치: ${CACHE}`,
            '캐싱되지 않은 매뉴얼도 hrbook_read 로 원격에서 읽을 수 있습니다.',
          ]
            .filter(Boolean)
            .join('\n');
        },
      }),
    },
  };
};

export default HrBookPlugin;
