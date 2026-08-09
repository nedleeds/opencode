import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '../../tool.js';
import { AUTOSYNC, listCached, loadBookinfos, rankBooks, readPage, searchWithAutoSync } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const z = tool.schema;

const TOOL_NAMES = ['hrbook_search', 'hrbook_read', 'hrbook_catalog'];

/**
 * The agent ships with the plugin instead of living in each user's
 * opencode.jsonc. Tools and the prompt that drives them are one unit — a
 * prompt that names `hrbook_read` is wrong the moment the tool is renamed —
 * and keeping them together is what reduces installation to one link.
 *
 * The prompt is read here rather than passed as `{file:...}`, because that
 * template resolves against the *user's* config directory, which this file
 * knows nothing about.
 */
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
    // therefore read by nobody and silently does nothing. `edit` is the
    // permission behind write/edit/patch alike.
    permission: { edit: 'deny', bash: 'deny' },
  };
}

/**
 * Argument names mirror bookinfos.json and the viewer URLs (`book_id`,
 * `ver_id`) rather than shorter invented ones. Models reach for the domain's
 * own vocabulary, and a mismatch costs a failed call plus a retry on every
 * lookup — far more tokens than the longer names ever save.
 *
 * Tool descriptions sit in context on every request, so they stay to one line.
 */
export const HrBookPlugin = async () => ({
  async config(cfg) {
    cfg.agent = cfg.agent ?? {};

    // A user who has written their own `HRBook` agent meant it, so anything
    // they set wins — down to the individual permission.
    const defaults = await agentConfig();
    const existing = cfg.agent.HRBook ?? {};
    cfg.agent.HRBook = {
      ...defaults,
      ...existing,
      permission: { ...defaults.permission, ...existing.permission },
    };

    // Manual lookups have no place in a coding session, and an enabled tool
    // costs its description in context on every single request. Off by
    // default for the built-in agents, still overridable per user.
    for (const name of ['build', 'plan']) {
      const agent = (cfg.agent[name] = cfg.agent[name] ?? {});
      agent.permission = {
        ...Object.fromEntries(TOOL_NAMES.map((t) => [t, 'deny'])),
        ...agent.permission,
      };
    }
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
        const { hits, scanned, total, synced } = await searchWithAutoSync(args.query, {
          product: args.product,
          lang: args.lang,
          book: args.book_id,
          limit: args.limit,
        });
        if (hits.length === 0) {
          const cached = await listCached();
          if (cached.length === 0) return 'No manuals cached. Run `hrbook-sync --defaults` first.';
          // Spell out the boundary. Left to a bare "no match", models fill the
          // gap from training data and invent page paths and viewer links —
          // for controller manuals that is worse than saying nothing.
          const list = cached.map((c) => `${c.book}/${c.ver}`).join(', ');
          return [
            `No match for "${args.query}" in ${scanned} pages.`,
            AUTOSYNC
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
        const { text, truncated, url } = await readPage(
          args.book_id,
          args.ver_id,
          args.path,
          args.maxBytes,
        );
        return `${url}\n\n${text}${truncated ? '\n\n[truncated — raise maxBytes for more]' : ''}`;
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
  },
});

export default HrBookPlugin;
