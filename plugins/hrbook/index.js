import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool } from '../../tool.js';
import { AUTOSYNC, listCached, loadBookinfos, rankBooks, readPage, searchWithAutoSync, checkoutBook, checkAllBooksUpdates, syncBook, checkPendingSync, resetPendingSync } from './lib.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const z = tool.schema;

const TOOL_NAMES = ['hrbook_search', 'hrbook_read', 'hrbook_catalog', 'hrbook_checkout'];

async function agentConfig() {
  return {
    description:
      'HD 현대로보틱스 Hi6/Hi7 제어기 메뉴얼 Q&A. 조작·기능·Open API 등에 대한 질문에 사용.',
    mode: 'primary',
    prompt: await readFile(path.join(HERE, 'agent.md'), 'utf8'),
    permission: { edit: 'deny', bash: 'deny' },
  };
}

let syncInProgress = false;

export const HrBookPlugin = async () => {
  // 첫 툴 호출 시 동기화 체크
  let syncChecked = false;
  
  async function config(cfg) {
    cfg.agent = cfg.agent ?? {};

    const defaults = await agentConfig();
    const existing = cfg.agent.HRBook ?? {};
    cfg.agent.HRBook = {
      ...defaults,
      ...existing,
      permission: { ...defaults.permission, ...existing.permission },
    };
  }

  const syncIfNeeded = async () => {
    if (syncChecked || syncInProgress) return;
    syncChecked = true;
    
    try {
      const updates = await checkAllBooksUpdates();
      if (updates.length === 0) return;
      
      const notCloned = updates.filter((u) => u.current === null);
      const hasUpdates = updates.filter((u) => u.current !== null);
      
      if (notCloned.length > 0) {
        process.stderr.write(`\n[HRBook] ${notCloned.length}개 매뉴얼 동기화 중...\n`);
        syncInProgress = true;
        let synced = 0;
        let failed = 0;
        for (const update of notCloned) {
          try {
            await syncBook(update.book, update.target, true);
            synced++;
          } catch (err) {
            failed++;
            process.stderr.write(`  ✗ ${update.book}: ${err.message.split('\n')[0]}\n`);
          }
        }
        syncInProgress = false;
        process.stderr.write(`[HRBook] 완료: ${synced}개 성공, ${failed}개 실패\n\n`);
      }
      
      if (hasUpdates.length > 0) {
        process.stderr.write(`\n[HRBook] ${hasUpdates.length}개 매뉴얼 갱신 중...\n`);
        syncInProgress = true;
        let updated = 0;
        let failed = 0;
        for (const update of hasUpdates) {
          try {
            await checkoutBook(update.book, update.target);
            updated++;
          } catch (err) {
            failed++;
            process.stderr.write(`  ✗ ${update.book}: ${err.message.split('\n')[0]}\n`);
          }
        }
        syncInProgress = false;
        process.stderr.write(`[HRBook] 완료: ${updated}개 성공, ${failed}개 실패\n\n`);
      }
    } catch (err) {
      // Silent
    }
  };

  return {
    config,
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
          await syncIfNeeded();
          const { hits, scanned, total, synced } = await searchWithAutoSync(args.query, {
            product: args.product,
            lang: args.lang,
            book: args.book_id,
            limit: args.limit,
          });
          if (hits.length === 0) {
            const cached = await listCached();
            if (cached.length === 0) return 'No manuals cached. Run `hrbook-sync --defaults` first.';
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
        await syncIfNeeded();
        await checkoutBook(args.book_id, args.ver_id);
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
        await syncIfNeeded();
        await checkoutBook(args.book_id, args.ver_id);
        return `Checked out ${args.book_id} to branch ${args.ver_id}`;
      },
    }),

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
        await syncIfNeeded();
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
};

export default HrBookPlugin;
