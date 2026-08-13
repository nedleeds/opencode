import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '../../tool.js';
import {
  CACHE,
  INDEX_DIR,
  LEGACY_BOOKS_DIR,
  PRIMARY_LANG,
  SECONDARY_LANG,
  booksForLang,
  fetchIndexSet,
  indexAbsent,
  hasIndex,
  legacyCloneSize,
  listIndexes,
  loadBookinfos,
  pendingFor,
  rankBooks,
  readPage,
  readRemotePage,
  refreshIfChanged,
  remoteSearch,
  search,
} from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const z = tool.schema;

/** How many manuals a single answer may re-check for updates. A question
 *  normally hits one or two; the cap stops a broad query turning into a
 *  round trip per manual in the catalogue. */
const MAX_FRESHNESS_CHECKS = 3;

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

/** First line of an error, short enough to read in a toast. */
const brief = (err) => String(err?.message ?? err).split('\n')[0].slice(0, 60);

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

export const HrBookPlugin = async ({ client }) => {
  /**
   * `client.tui.*` reaches the TUI over the server's HTTP API and throws when
   * no TUI is attached — `opencode run`, `serve`, `web`, `attach`, and briefly
   * at startup. It does not latch off on the first failure, because the
   * background language set can finish before the TUI has connected; it gives
   * up only after a long run of consecutive failures and resets as soon as one
   * lands.
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

  /**
   * Text the user has to act on later, put where it will still be there when
   * they get to it. A toast is gone in seconds and the tool result scrolls
   * away behind the answer; the prompt box survives both.
   *
   * Reserved for environment problems the user must fix by hand — never used
   * for progress, which is what toasts are for.
   */
  const remember = async (text) => {
    try {
      await client.tui.appendPrompt({ body: { text: `\n> [HRBook] ${text}\n` } });
      return true;
    } catch {
      await log(`could not surface notice: ${text}`, 'warn');
      return false;
    }
  };

  const state = {
    ready: false,
    building: false,
    secondaryStarted: false,
    counts: { primary: 0, secondary: 0, absent: 0, failed: 0 },
    lastError: null,
  };

  /**
   * The primary language set, fetched synchronously on the first question.
   *
   * ~87 files and 7.7 MB, which measures at 16 s on the internal network. The
   * user waits once; every question after that is a local grep at ~130 ms. The
   * secondary language is deliberately *not* part of this wait — see below.
   */
  async function ensurePrimary() {
    if (state.ready) return { built: false };
    if (state.building) return { built: false, busy: true };

    const infos = await loadBookinfos();
    const entries = booksForLang(infos, PRIMARY_LANG);
    const pending = pendingFor(entries);
    if (pending.length === 0) {
      state.ready = true;
      state.counts.primary = entries.filter((e) => hasIndex(e.book, e.ver)).length;
      return { built: false };
    }

    state.building = true;
    await toast(
      `매뉴얼 내려받는 중 — ${PRIMARY_LANG} ${pending.length}권 (${CACHE})`,
      'loading',
    );
    try {
      const { ok, absent, failed } = await fetchIndexSet(pending);
      state.counts.primary = entries.filter((e) => hasIndex(e.book, e.ver)).length;
      state.counts.absent += absent.length;
      state.counts.failed = failed.length;
      state.ready = ok.length > 0 || state.counts.primary > 0;

      if (failed.length > 0 && ok.length === 0) {
        // A whole set failing is one shared cause — proxy, mirror, or DNS —
        // not N independent problems, and the user has to change something
        // outside this conversation before anything works.
        state.lastError = brief(failed[0].error);
        await toast(`매뉴얼 내려받기 실패 — ${state.lastError}`, 'error');
        await remember(
          `매뉴얼을 하나도 내려받지 못했습니다 (${state.lastError}). ` +
            `네트워크·프록시 또는 HRBOOK_RAW_BASE 설정을 확인하세요.`,
        );
      } else {
        await toast(
          failed.length
            ? `매뉴얼 ${ok.length}권 완료, ${failed.length}권 실패 — ${brief(failed[0].error)}`
            : `매뉴얼 ${ok.length}권 준비 완료`,
          failed.length ? 'info' : 'success',
        );
      }
      await log(`primary index: ${ok.length} ok, ${absent.length} absent, ${failed.length} failed`);
      return { built: true, ok: ok.length, failed: failed.length };
    } finally {
      state.building = false;
    }
  }

  /**
   * The second language, fetched in the background after the first answer has
   * already gone out. Doubling the opening wait to 33 s to prepare manuals the
   * user has not asked for is a bad trade; running it while they read costs
   * them nothing.
   */
  function startSecondary() {
    if (state.secondaryStarted || SECONDARY_LANG === PRIMARY_LANG) return;
    state.secondaryStarted = true;

    void (async () => {
      try {
        const entries = booksForLang(await loadBookinfos(), SECONDARY_LANG);
        const pending = pendingFor(entries);
        if (pending.length === 0) return;
        const { ok, failed } = await fetchIndexSet(pending);
        state.counts.secondary = ok.length;
        if (ok.length > 0) {
          await toast(`${SECONDARY_LANG} 매뉴얼 ${ok.length}권 준비 완료`, 'success');
        }
        await log(`secondary index: ${ok.length} ok, ${failed.length} failed`);
      } catch (err) {
        await log(`secondary index failed: ${err.message}`, 'warn');
      }
    })();
  }

  /**
   * Check for updates only on the manuals this answer actually rests on.
   *
   * Checking the whole set would be ~87 round trips per question. Searching
   * the stale index first and then verifying the two or three manuals it hit
   * costs one round trip each, and the shortcut is safe because a revision
   * rarely changes *which* manual covers a topic.
   */
  async function refreshHits(hits) {
    const seen = new Set();
    const targets = [];
    for (const h of hits) {
      const key = `${h.book}@${h.ver}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push({ book: h.book, ver: h.ver });
      if (targets.length >= MAX_FRESHNESS_CHECKS) break;
    }
    if (targets.length === 0) return [];

    const results = await Promise.all(targets.map((t) => refreshIfChanged(t.book, t.ver)));
    const changed = results.filter((r) => r.changed);
    if (changed.length > 0) {
      await toast(
        `${changed.map((c) => c.book).join(', ')} 매뉴얼이 갱신되어 최신 내용으로 답변합니다`,
        'info',
      );
      await log(`refreshed: ${changed.map((c) => `${c.book}/${c.ver}`).join(', ')}`);
    }
    return changed;
  }

  /** bookinfos entry for a (book, ver), for GitBook variable substitution. */
  async function variablesFor(book, ver) {
    try {
      const infos = await loadBookinfos();
      return infos.find((e) => e.book_id === book && e.ver_id === ver)?.variables;
    } catch {
      return undefined;
    }
  }

  const formatHits = (hits, total) =>
    hits
      .map(
        (h) =>
          `- book_id=${h.book} ver_id=${h.ver} path=${h.path}\n  ${h.heading || '(제목 없음)'}\n  ${h.snippet}`,
      )
      .join('\n') + (total > hits.length ? `\n(${total - hits.length} more)` : '');

  const legacyNoticeShown = { done: false };
  async function noticeLegacyClones() {
    if (legacyNoticeShown.done) return;
    legacyNoticeShown.done = true;
    try {
      const bytes = await legacyCloneSize();
      if (bytes < 100 * 1024 * 1024) return;
      // Never deleted automatically. It is the user's disk, the directory is
      // large enough that removing it by surprise would be alarming, and the
      // command has to be run outside this conversation anyway.
      await remember(
        `이전 버전이 남긴 clone 캐시가 ${mb(bytes)} MB 있습니다. 더 이상 쓰지 않으니 지워도 됩니다: ` +
          `Remove-Item -Recurse -Force "${LEGACY_BOOKS_DIR}"`,
      );
    } catch {
      // Reporting disk usage must never break a question.
    }
  }

  await log(`hrbook loaded — index: ${INDEX_DIR}`);

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
          'Full-text search across HD Hyundai Robotics Hi6/Hi7 controller manuals. Every manual is held locally, so this searches the actual text of all of them — not just titles. The very first call downloads the manuals, which takes about 15 seconds; every call after that is instant.',
        args: {
          query: z.string().describe('Keywords only, e.g. "api_ver" or "조그 속도"'),
          product: z.enum(['hi6', 'hi7', 'hi5a', 'common', 'manipulator']).optional(),
          lang: z.string().optional().describe('Language prefix of ver_id: ko, en, zh'),
          book_id: z.string().optional().describe('Restrict to one book, e.g. doc-hi6-open-api'),
          limit: z.number().int().min(1).max(20).optional().describe('Default 8'),
        },
        async execute(args) {
          let prepared = { built: false };
          try {
            prepared = await ensurePrimary();
          } catch (err) {
            await log(`index preparation failed: ${err.message}`, 'warn');
            return (
              `매뉴얼을 준비하지 못했습니다 (${brief(err)}).\n` +
              `네트워크 문제입니다. 캐시가 비어서가 아니라 접근이 막힌 것이므로, ` +
              `사용자에게 이 사실을 알리고 추측으로 답하지 마세요.`
            );
          }
          startSecondary();
          void noticeLegacyClones();

          // The toast that announced the download is gone by the time the
          // answer appears, and the tool blocks until preparation finishes —
          // so there is no moment at which the model could have said "fetching
          // now". Saying it afterwards is the only option, and it matters:
          // without it the first question just looks slow for no reason.
          const notice = prepared.built
            ? `[HRBook] 매뉴얼 ${prepared.ok}권을 새로 내려받았습니다 (${INDEX_DIR}).` +
              (prepared.failed ? ` ${prepared.failed}권은 실패했습니다.` : '') +
              ` 최초 1회만 걸리는 준비 과정이며, 다음 질문부터는 즉시 응답합니다.` +
              ` 이 사실을 사용자에게 한 문장으로 전달하세요.\n\n`
            : '';

          const base = { book: args.book_id, limit: args.limit };
          let lang = args.lang || PRIMARY_LANG;
          let result = await search(args.query, { ...base, lang });

          // Fall through to the other language rather than reporting nothing:
          // some manuals are only meaningful in English, and the user should
          // not have to know which.
          if (result.hits.length === 0 && !args.lang && SECONDARY_LANG !== PRIMARY_LANG) {
            const alt = await search(args.query, { ...base, lang: SECONDARY_LANG });
            if (alt.hits.length > 0) {
              lang = SECONDARY_LANG;
              result = alt;
            }
          }

          if (result.hits.length > 0) {
            const changed = await refreshHits(result.hits);
            if (changed.length > 0) {
              result = await search(args.query, { ...base, lang });
            }
          }

          if (result.hits.length === 0) {
            const indexes = await listIndexes();
            return notice + [
              `"${args.query}" 에 대한 결과가 없습니다 (${result.scanned}개 페이지 검색, 매뉴얼 ${indexes.length}권).`,
              '매뉴얼은 정상적으로 준비되어 있으며, 검색어와 일치하는 내용이 없는 것입니다.',
              // Spell out the boundary. Left to a bare "no match", models fill
              // the gap from training data and invent page paths and viewer
              // links — for controller manuals that is worse than silence.
              'Retry ONCE with fewer keywords, then use hrbook_catalog to find the right manual.',
              'Do NOT answer from memory and do NOT invent page paths or viewer links.',
            ].join('\n');
          }

          return (
            notice +
            `${result.hits.length}/${result.total} match(es) in ${result.scanned} pages (lang=${lang}):\n` +
            formatHits(result.hits, result.total)
          );
        },
      }),

      hrbook_read: tool({
        description:
          'Read one manual page as markdown. Served from the local copy, so it is instant and needs no network. Use the exact book_id/ver_id/path returned by hrbook_search.',
        args: {
          book_id: z.string().describe('e.g. doc-hi6-open-api'),
          ver_id: z.string().describe('e.g. ko, en, ko-tp630'),
          path: z.string().describe('e.g. 1-version/1-get/1-api_ver.md'),
          maxBytes: z.number().int().min(500).max(40000).optional().describe('Default 12000'),
        },
        async execute(args) {
          const variables = await variablesFor(args.book_id, args.ver_id);

          if (hasIndex(args.book_id, args.ver_id)) {
            try {
              const { text, truncated, url } = await readPage(
                args.book_id,
                args.ver_id,
                args.path,
                args.maxBytes,
                variables,
              );
              return `${url}\n\n${text}${truncated ? '\n\n[truncated — raise maxBytes for more]' : ''}`;
            } catch (err) {
              await log(`index read failed ${args.book_id}/${args.ver_id}: ${err.message}`, 'warn');
            }
          }

          // A handful of manuals publish no book.md, and a path can also come
          // from the model rather than from a search hit. Either way the page
          // itself is still fetchable on its own.
          try {
            const { text, truncated, url } = await readRemotePage(
              args.book_id,
              args.ver_id,
              args.path,
              args.maxBytes,
              variables,
            );
            return `${url}\n\n${text}${truncated ? '\n\n[truncated — raise maxBytes for more]' : ''}`;
          } catch (err) {
            return (
              `${args.book_id}/${args.ver_id}/${args.path} 를 읽지 못했습니다 (${brief(err)}).\n` +
              `경로를 추측하지 말고, hrbook_search 결과에 있는 path 를 그대로 사용하세요.`
            );
          }
        },
      }),

      /**
       * The full catalogue is ~5.4k tokens, so it is never put in the system
       * prompt. It is reachable here, filtered, and only when full-text search
       * has already failed — a rare path now that search reads every manual.
       */
      hrbook_catalog: tool({
        description:
          'Browse the manual catalogue by keyword when hrbook_search finds nothing. Lists matching book_id/ver_id and titles.',
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
              const mark = hasIndex(e.book_id, e.ver_id)
                ? ''
                : indexAbsent(e.book_id, e.ver_id)
                  ? ' [book.md 없음 — 페이지 단위 조회만 가능]'
                  : ' [미준비]';
              return `- book_id=${e.book_id} ver_id=${e.ver_id}${mark} — ${e.title}`;
            })
            .join('\n');
          return `${ranked.length} manual(s) matching "${args.filter}":\n${rows}`;
        },
      }),

      hrbook_refresh: tool({
        description:
          '모든 매뉴얼을 최신으로 다시 받는다. 매뉴얼이 개정되었는데 답변이 예전 내용일 때 사용.',
        args: {
          lang: z.string().optional().describe('Default: 준비된 모든 언어'),
        },
        async execute(args) {
          const targets = await listIndexes(args.lang);
          if (targets.length === 0) return '준비된 매뉴얼이 없습니다.';

          await toast(`매뉴얼 ${targets.length}권 갱신 확인 중`, 'loading');
          const results = await Promise.all(
            targets.map((t) => refreshIfChanged(t.book, t.ver)),
          );
          const changed = results.filter((r) => r.changed);
          const unchecked = results.filter((r) => !r.checked);

          await toast(
            changed.length
              ? `매뉴얼 ${changed.length}권 갱신됨`
              : '모든 매뉴얼이 이미 최신입니다',
            'success',
          );

          return [
            `확인 ${targets.length}권 / 갱신 ${changed.length}권` +
              (unchecked.length ? ` / 확인 실패 ${unchecked.length}권` : ''),
            changed.length ? `갱신: ${changed.map((c) => c.book).join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('\n');
        },
      }),

      hrbook_status: tool({
        description:
          '매뉴얼 준비 상태를 조회한다. 사용자가 진행 상황·실패 여부를 물을 때 사용.',
        args: {},
        async execute() {
          const indexes = await listIndexes();
          const byLang = new Map();
          for (const i of indexes) {
            const key = i.ver.split(/[-_]/)[0];
            byLang.set(key, (byLang.get(key) ?? 0) + 1);
          }
          return [
            state.building ? '매뉴얼 준비 중' : '매뉴얼 준비 완료',
            `준비된 매뉴얼: ${indexes.length}권` +
              (byLang.size
                ? ` (${[...byLang].map(([k, v]) => `${k} ${v}`).join(', ')})`
                : ''),
            state.counts.absent ? `book.md 미제공: ${state.counts.absent}권` : null,
            state.counts.failed ? `내려받기 실패: ${state.counts.failed}권` : null,
            state.lastError ? `마지막 오류: ${state.lastError}` : null,
            `저장 위치: ${INDEX_DIR}`,
            '갱신이 필요하면 hrbook_refresh 를 사용하세요.',
          ]
            .filter(Boolean)
            .join('\n');
        },
      }),
    },
  };
};

export default HrBookPlugin;
