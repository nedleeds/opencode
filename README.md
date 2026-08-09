# @nedleeds/opencode

opencode extensions — plugins (tools + their agents) and skills — installed
straight from GitHub, with no npm publish in the loop.

```jsonc
// opencode.jsonc
{
  "plugin": ["github:nedleeds/opencode"]
}
```

That is the whole installation. opencode clones this repo on start, and every
plugin under `plugins/` registers its tools **and its agent**, so nothing has to
be pasted into the user's config.

Pin a tag when you want a fixed version: `"github:nedleeds/opencode#v0.1.0"`.

## What is included

| | |
|---|---|
| `hrbook` agent | HD현대로보틱스 Hi6/Hi7 제어기 매뉴얼 Q&A |
| `hrbook_search` `hrbook_read` `hrbook_catalog` | manual search over a local cache — see [plugins/hrbook](plugins/hrbook) |

Select the agent in the TUI with `Tab`, or start there: `opencode --agent hrbook`.

## How installing from git behaves

Worth knowing before rolling this out to a team, because none of it is
documented and some of it is surprising:

- **Updates land on the next start.** A git specifier is re-resolved every time
  opencode boots, so a push reaches everyone without them touching anything.
  That is convenient and it is also the risk — a broken commit ships instantly.
  Pin `#<tag>` for anyone who needs a fixed version.
- **No build step runs.** opencode installs with `ignoreScripts`, so `prepare`
  and `build` never execute. Everything here is plain ESM that runs as-is; a
  `main` pointing into a `dist/` that only exists after a build would silently
  register nothing.
- **Dependencies stay at one package.** The install has to finish inside
  opencode's startup window, and a large tree does not reliably get there —
  it leaves a half-written `node_modules`, no tools, and no log line. Hence
  `zod` only, and [`tool.js`](tool.js) in place of `@opencode-ai/plugin`.
- **Failures are silent.** opencode reports a plugin that fails to load as a
  TUI toast and nothing else; headless runs print nothing at all. `index.js`
  logs its own load failures to stderr to compensate. Run with
  `opencode --print-logs` when something is missing.

Cache lives at `~/.cache/opencode/packages/github:nedleeds/opencode/`. Delete it
to force a clean re-install.

## Adding a plugin

Create `plugins/<name>/index.js` with a default export:

```js
import { tool } from '../../tool.js';

export default async () => ({
  // Ships the agent with the tools it was written for.
  async config(cfg) {
    cfg.agent = cfg.agent ?? {};
    cfg.agent.myagent = {
      mode: 'primary',
      prompt: '…',
      // Use `permission`, never the `tools` shorthand — see below.
      permission: { edit: 'deny' },
      ...cfg.agent.myagent,
    };
  },
  tool: {
    my_tool: tool({
      description: 'One line — it sits in context on every request.',
      args: { query: tool.schema.string() },
      async execute(args) { return '…'; },
    }),
  },
});
```

`index.js` discovers the directory on its own — no registration, and no change
on the users' side, since the link they pinned already points at it.

Two things about the `config` hook are worth knowing before you fight them:

- An agent's tool list comes from its **permission ruleset**. The `tools: { x:
  false }` shorthand is folded into permissions while the config files are
  parsed, which happens before any plugin runs — so a `tools` map set from a
  plugin is read by nobody and fails silently. Write `permission: { x: 'deny' }`
  instead. `edit` is the permission behind `write`/`edit`/`patch` alike.
- Spread the user's own value last, so an explicit setting in their
  `opencode.jsonc` always beats the plugin's default.

Skills are directories, not code: drop them in [`skills/`](skills/).

## Development

```bash
npm install
npm test
```

Point opencode at the working copy instead of GitHub while iterating:

```jsonc
{ "plugin": ["/Users/dhl/Src/opencode"] }
```

A local path is imported directly — no clone, no install — so edits apply on the
next start.
