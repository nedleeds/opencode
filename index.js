import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = path.join(ROOT, 'plugins');
const SKILLS_DIR = path.join(ROOT, 'skills');

/**
 * One opencode plugin entry point for the whole repo. A user adds a single
 * line to opencode.jsonc:
 *
 *   "plugin": ["github:nedleeds/opencode"]
 *
 * and gets every plugin under `plugins/` plus every skill under `skills/`.
 * Adding a plugin later means adding a directory here — no change on the
 * users' side, because the link they pinned already points at this file.
 */

/** Discovered rather than listed, so a new `plugins/<name>/index.js` needs no edit here. */
async function discover() {
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('_') && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

/**
 * `tool` is a map and must be unioned; every other hook opencode defines is a
 * function that returns nothing, so they compose by running in sequence.
 * `auth` and `provider` are single objects — last one wins, which is only
 * reachable if two plugins claim the same slot, and that is a conflict the
 * author has to resolve anyway.
 */
function merge(hookSets) {
  const merged = {};
  const chains = new Map();

  for (const hooks of hookSets) {
    for (const [key, value] of Object.entries(hooks ?? {})) {
      if (key === 'tool') {
        merged.tool = { ...merged.tool, ...value };
      } else if (typeof value === 'function') {
        if (!chains.has(key)) chains.set(key, []);
        chains.get(key).push(value);
      } else {
        merged[key] = value;
      }
    }
  }

  for (const [key, fns] of chains) {
    merged[key] = async (...args) => {
      for (const fn of fns) await fn(...args);
    };
  }
  return merged;
}

export const NedleedsOpencode = async (input, options) => {
  const hookSets = [];

  for (const name of await discover()) {
    const entry = path.join(PLUGINS_DIR, name, 'index.js');
    try {
      const mod = await import(pathToFileURL(entry).href);
      const factory = mod.default;
      if (typeof factory !== 'function') continue;
      hookSets.push(await factory(input, options));
    } catch (err) {
      // opencode swallows plugin load failures without a word, so say it here.
      // A broken plugin must not take the working ones down with it.
      console.error(`[@nedleeds/opencode] plugin "${name}" failed to load: ${err.message}`);
    }
  }

  // Skills ship as directories, not code, so they are registered by pointing
  // opencode's resolver at this repo's `skills/` — the same thing a user would
  // otherwise have to paste into their own config.
  hookSets.push({
    async config(cfg) {
      cfg.skills = cfg.skills ?? {};
      cfg.skills.paths = cfg.skills.paths ?? [];
      if (!cfg.skills.paths.includes(SKILLS_DIR)) cfg.skills.paths.push(SKILLS_DIR);
    },
  });

  return merge(hookSets);
};

export default NedleedsOpencode;
