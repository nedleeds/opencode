#!/usr/bin/env node
import { CACHE, listCached, loadBookinfos, refreshBookinfos, syncBook, writeManifest } from './lib.js';

/**
 * Sync is a separate CLI rather than a tool: it is slow, network-bound and run
 * rarely, so exposing it to the model would cost context on every request for
 * no benefit. One person can run this and share $HRBOOK_CACHE with the team.
 */
const DEFAULTS = [
  ['doc-hi6-open-api', 'en'],
  ['doc-hi6-open-api', 'ko'],
  ['doc-hi6-operation', 'en-tp630'],
  ['doc-hi6-operation', 'ko-tp630'],
  ['doc-industrial-communication', 'en-Hi6'],
  ['doc-industrial-communication', 'ko-Hi6'],
];

function usage() {
  console.log(`hrbook-sync — populate the local HRBook manual cache

  hrbook-sync --refresh              only re-fetch bookinfos.json
  hrbook-sync --defaults             refresh + sync a starter set of manuals
  hrbook-sync --list [filter]        list manuals available to sync
  hrbook-sync --status               show what is cached locally
  hrbook-sync <book_id> <ver_id>...  sync specific manuals

Cache: ${CACHE}
Env:   HRBOOK_CACHE, HRBOOK_TARBALL_BASE, HRBOOK_BOOKINFOS_URL, HRBOOK_VIEWER_BASE
       (set the *_BASE/_URL vars to an internal mirror on a closed network)`);
}

async function syncPairs(pairs) {
  let ok = 0;
  const done = [];
  for (const [book, ver] of pairs) {
    process.stdout.write(`  ${book}/${ver} ... `);
    try {
      const n = await syncBook(book, ver);
      console.log(`${n} pages`);
      done.push({ book, ver, pages: n });
      ok++;
    } catch (err) {
      console.log(`FAILED (${String(err.message).split('\n')[0].slice(0, 80)})`);
    }
  }
  if (done.length) await writeManifest(done);
  console.log(`\n${ok}/${pairs.length} synced into ${CACHE}`);
  return ok === pairs.length ? 0 : 1;
}

const args = process.argv.slice(2);
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}

try {
  if (args[0] === '--status') {
    const cached = await listCached();
    if (!cached.length) console.log('nothing cached');
    for (const { book, ver } of cached) console.log(`${book}/${ver}`);
    process.exit(0);
  }

  if (args[0] === '--list') {
    const filter = (args[1] || '').toLowerCase();
    const seen = new Set();
    for (const e of await loadBookinfos()) {
      const key = `${e.book_id}/${e.ver_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const line = `${key}  ${e.title}`;
      if (!filter || line.toLowerCase().includes(filter)) console.log(line);
    }
    process.exit(0);
  }

  if (args[0] === '--refresh' || args[0] === '--defaults') {
    console.log('bookinfos.json ...');
    console.log(`  ${await refreshBookinfos()} entries`);
    if (args[0] === '--refresh') process.exit(0);
    console.log('manuals:');
    process.exit(await syncPairs(DEFAULTS));
  }

  if (args.length < 2 || args.length % 2 !== 0) {
    console.error('expected pairs: hrbook-sync <book_id> <ver_id> [<book_id> <ver_id>...]');
    process.exit(2);
  }
  const pairs = [];
  for (let i = 0; i < args.length; i += 2) pairs.push([args[i], args[i + 1]]);
  process.exit(await syncPairs(pairs));
} catch (err) {
  console.error(`error: ${err.message}`);
  process.exit(1);
}
