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

test('registers every plugin tool under plugins/', async () => {
  const hooks = await plugin({}, {});
  assert.deepEqual(Object.keys(hooks.tool ?? {}).sort(), [
    'hrbook_catalog',
    'hrbook_read',
    'hrbook_search',
  ]);
});

test('the same hook declared twice runs both times, not just the last', async () => {
  const hooks = await plugin({}, {});
  // `config` comes from hrbook and from the skills registration in index.js —
  // the merge has to chain them, not let one overwrite the other.
  const cfg = {};
  await hooks.config(cfg);
  assert.ok(cfg.agent?.HRBook, 'hrbook config hook ran');
  assert.ok(cfg.skills?.paths?.length, 'skills config hook ran too');
});

test('config hook contributes the hrbook agent with its prompt inlined', async () => {
  const hooks = await plugin({}, {});
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
  const hooks = await plugin({}, {});
  const cfg = {};
  await hooks.config(cfg);

  // A `name` here makes the agent list and appear in the TUI picker, but every
  // prompt sent to it fails with a bare `UnknownError` because the prompt path
  // resolves agents by config key. Regression guard for that.
  assert.equal(cfg.agent.HRBook.name, undefined);
});

test('manual tools stay off in coding agents, and user settings still win', async () => {
  const hooks = await plugin({}, {});
  const cfg = {
    agent: {
      build: { permission: { hrbook_search: 'allow' } },
      HRBook: { permission: { bash: 'allow' } },
    },
  };
  await hooks.config(cfg);

  assert.equal(cfg.agent.build.permission.hrbook_search, 'allow', 'user value must survive');
  assert.equal(cfg.agent.build.permission.hrbook_read, 'deny');
  assert.equal(cfg.agent.plan.permission.hrbook_catalog, 'deny');

  assert.equal(cfg.agent.HRBook.permission.bash, 'allow', 'user value must survive');
  assert.equal(cfg.agent.HRBook.permission.edit, 'deny', 'untouched defaults stay');
});

test('skills directory is registered once, alongside any the user configured', async () => {
  const hooks = await plugin({}, {});
  const cfg = { skills: { paths: ['.opencode/skills'] } };
  await hooks.config(cfg);
  await hooks.config(cfg);

  assert.deepEqual(cfg.skills.paths, ['.opencode/skills', path.join(ROOT, 'skills')]);
});
