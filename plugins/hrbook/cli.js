#!/usr/bin/env node
import {
  CACHE,
  INDEX_DIR,
  PRIMARY_LANG,
  SECONDARY_LANG,
  booksForLang,
  fetchIndexSet,
  indexPath,
  listIndexes,
  loadBookinfos,
  pendingFor,
  rankBooks,
  refreshBookinfos,
  refreshIfChanged,
} from './lib.js';
import { stat } from 'node:fs/promises';

/**
 * The plugin builds its index on the first question, so this exists for the
 * cases a TUI cannot cover: priming a machine before anyone uses it, forcing a
 * refresh, and seeing what is on disk without starting a session.
 */
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

function usage() {
  console.log(`hrbook — HD Hyundai Robotics manual index

  hrbook --sync [--lang ko]     download the index set for a language
  hrbook --sync-all             download every language in bookinfos
  hrbook --refresh [--lang ko]  re-check indexes already on disk
  hrbook --status               show what is on disk
  hrbook --list [filter]        list manuals in the catalogue

Index location: ${INDEX_DIR}`);
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

async function syncLang(lang) {
  const entries = booksForLang(await loadBookinfos(), lang);
  const pending = pendingFor(entries);
  if (pending.length === 0) {
    console.log(`${lang}: already complete (${entries.length} manual(s))`);
    return;
  }
  console.log(`${lang}: downloading ${pending.length} of ${entries.length} manual(s)...`);
  const { ok, absent, failed } = await fetchIndexSet(pending);
  const bytes = ok.reduce((n, r) => n + (r.bytes ?? 0), 0);
  console.log(`${lang}: ${ok.length} ok (${mb(bytes)} MB), ${absent.length} without book.md, ${failed.length} failed`);
  for (const f of failed) console.log(`  FAILED ${f.book}/${f.ver}: ${f.error}`);
  for (const a of absent) console.log(`  no book.md: ${a.book}/${a.ver}`);
}

async function main() {
  if (args.length === 0 || flag('--help') || flag('-h')) return usage();

  if (flag('--status')) {
    const indexes = await listIndexes(value('--lang', undefined));
    let bytes = 0;
    for (const i of indexes) {
      try {
        bytes += (await stat(indexPath(i.book, i.ver))).size;
      } catch {
        // A file removed between listing and stat is not worth failing over.
      }
    }
    console.log(`${indexes.length} manual(s), ${mb(bytes)} MB`);
    console.log(`cache: ${CACHE}`);
    for (const i of indexes) console.log(`  ${i.book}/${i.ver}`);
    return;
  }

  if (flag('--list')) {
    const filter = args[args.indexOf('--list') + 1] ?? '';
    const infos = await loadBookinfos();
    const ranked = filter
      ? rankBooks(filter, infos, { lang: value('--lang', undefined), limit: 50 })
      : infos.filter((e) => !e.url);
    for (const e of ranked) console.log(`  ${e.book_id}/${e.ver_id} — ${e.title}`);
    console.log(`${ranked.length} manual(s)`);
    return;
  }

  if (flag('--refresh')) {
    const targets = await listIndexes(value('--lang', undefined));
    if (targets.length === 0) return console.log('nothing on disk yet — run --sync first');
    console.log(`checking ${targets.length} manual(s)...`);
    const results = await Promise.all(targets.map((t) => refreshIfChanged(t.book, t.ver)));
    const changed = results.filter((r) => r.changed);
    const unchecked = results.filter((r) => !r.checked);
    console.log(`${changed.length} updated, ${unchecked.length} could not be checked`);
    for (const c of changed) console.log(`  updated ${c.book}/${c.ver}`);
    return;
  }

  await refreshBookinfos();

  if (flag('--sync-all')) {
    const langs = new Set(
      (await loadBookinfos())
        .filter((e) => !e.url)
        .map((e) => String(e.ver_id).split(/[-_]/)[0].toLowerCase()),
    );
    for (const lang of langs) await syncLang(lang);
    return;
  }

  if (flag('--sync')) {
    const lang = value('--lang', null);
    if (lang) return syncLang(lang);
    await syncLang(PRIMARY_LANG);
    if (SECONDARY_LANG !== PRIMARY_LANG) await syncLang(SECONDARY_LANG);
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
