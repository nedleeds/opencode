import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import plugin from '../index.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * These guard the contract users depend on: one link in opencode.jsonc has to
 * produce the tools, the agent and the skills path. When it breaks, opencode
 * reports nothing at all — the agent just quietly loses its tools — so the
 * failure has to be caught here instead.
 */

/**
 * The plugin takes `{ client }` and uses it for toasts and structured logs.
 * Passing a stub keeps the tests off the real SDK, and the calls it records
 * let a test assert on what the user would have been shown.
 */
function stubClient() {
  const toasts = [];
  const logs = [];
  return {
    toasts,
    logs,
    tui: {
      showToast: async ({ body }) => {
        toasts.push(body);
        return true;
      },
    },
    app: {
      log: async ({ body }) => {
        logs.push(body);
      },
    },
  };
}

const load = (client = stubClient()) => plugin({ client }, {});

test('registers every plugin tool under plugins/', async () => {
  const hooks = await load();
  // `hrbook_checkout` is gone with the git layer — there are no branches to
  // check out any more. `hrbook_refresh` takes its place as the one manual
  // action a user can still need.
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
    'hrbook_catalog',
    'hrbook_read',
    'hrbook_refresh',
    'hrbook_search',
    'hrbook_status',
  ]);
});

test('loads even when the host passes no client', async () => {
  // opencode calls the factory with a context object, but a bare call must not
  // take the plugin down: `client.app.log` at load time would throw before a
  // single tool is registered, and opencode reports that as nothing at all.
  const hooks = await plugin({}, {});
  assert.ok(hooks.tool?.hrbook_search, 'tools still registered without a client');
});

test('the same hook declared twice runs both times, not just the last', async () => {
  const hooks = await load();
  // `config` comes from hrbook and from the skills registration in index.js —
  // the merge has to chain them, not let one overwrite the other.
  const cfg = {};
  await hooks.config(cfg);
  assert.ok(cfg.agent?.HRBook, 'hrbook config hook ran');
  assert.ok(cfg.skills?.paths?.length, 'skills config hook ran too');
});

test('config hook contributes the hrbook agent with its prompt inlined', async () => {
  const hooks = await load();
  const cfg = {};
  await hooks.config(cfg);

  assert.equal(cfg.agent.HRBook.mode, 'primary');
  assert.match(cfg.agent.HRBook.prompt, /HRBook/);
  // Editing tools are switched off through permissions; a `tools` map set from
  // a plugin is ignored by opencode 1.18 (see plugins/hrbook/index.js).
  assert.equal(cfg.agent.HRBook.permission.edit, 'deny');
  assert.equal(cfg.agent.HRBook.permission.bash, 'deny');
});

test('the agent carries no `name` field — the key is the name', async () => {
  const hooks = await load();
  const cfg = {};
  await hooks.config(cfg);

  // A `name` here makes the agent list and appear in the TUI picker, but every
  // prompt sent to it fails with a bare `UnknownError` because the prompt path
  // resolves agents by config key. Regression guard for that.
  assert.equal(cfg.agent.HRBook.name, undefined);
});

test('the config hook downloads nothing', async () => {
  // Caching is on demand now: it starts from a question, never from startup.
  // A toast or a git call fired here is the old bulk-sync behaviour coming
  // back, which is what blocked the TUI for minutes before anyone could type.
  const client = stubClient();
  const hooks = await load(client);
  await hooks.config({});
  await new Promise((r) => setTimeout(r, 50));

  assert.deepEqual(client.toasts, [], 'no download toasts from config');
});

test('the plugin exposes no event hook', async () => {
  // `session.created` fires on the first prompt rather than at startup, so
  // driving downloads from events made them wait for the user to type. The
  // trigger is the search tool now.
  const hooks = await load();
  assert.equal(hooks.event, undefined);
});

test('build/plan agents now have access to hrbook tools, and user settings still win', async () => {
  const hooks = await load();
  const cfg = {
    agent: {
      build: { permission: { hrbook_search: 'allow' } },
      plan: { permission: { hrbook_catalog: 'allow' } },
      HRBook: { permission: { bash: 'allow' } },
    },
  };
  await hooks.config(cfg);

  assert.equal(cfg.agent.build.permission.hrbook_search, 'allow', 'user value must survive');
  assert.equal(cfg.agent.build.permission.hrbook_read, undefined, 'no longer denied by default');
  assert.equal(cfg.agent.plan.permission.hrbook_catalog, 'allow', 'user value must survive');
  assert.equal(cfg.agent.plan.permission.hrbook_search, undefined, 'no longer denied by default');

  assert.equal(cfg.agent.HRBook.permission.bash, 'allow', 'user value must survive');
  assert.equal(cfg.agent.HRBook.permission.edit, 'deny', 'untouched defaults stay');
});

test('skills directory is registered once, alongside any the user configured', async () => {
  const hooks = await load();
  const cfg = { skills: { paths: ['.opencode/skills'] } };
  await hooks.config(cfg);
  await hooks.config(cfg);

  assert.deepEqual(cfg.skills.paths, ['.opencode/skills', path.join(ROOT, 'skills')]);
});
