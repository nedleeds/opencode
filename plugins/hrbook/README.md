# hrbook

Answers questions about HD Hyundai Robotics **Hi6 / Hi7** controller manuals from
a **local cache** of the manual sources.

Registers three tools (`hrbook_search`, `hrbook_read`, `hrbook_catalog`) and the
`HRBook` agent that drives them. Installed with the repo — see the
[root README](../../README.md).

## Why it is built this way

Manual lookups happen constantly and must feel instant, so the design avoids the
three things that make agent tools slow and expensive:

- **No catalogue in the context.** Choosing which manual covers a question is
  done in code, by scoring `bookinfos.json` titles and a small topic-alias
  table. Letting the model choose would mean shipping the catalogue in every
  request — 5.4k tokens compacted, 13.7k raw — to replace matching that is free
  and deterministic here.
- **No network at query time.** Search and read are plain filesystem operations
  over `~/.cache/hrbook` (37–83 ms across ~500 pages). A manual that is missing
  is fetched once, on the first question that needs it, then never again.
- **No manual dumping.** `hrbook_search` returns a heading, a snippet and a link
  per hit. The model only calls `hrbook_read` for the one or two pages it
  actually needs.

Measured: an `HRBook` session starts at **~4,200 tokens** of context — roughly
half a default `build` session, because only three tools are enabled and
`write`/`edit`/`bash` are off — and a typical question costs 3 model calls and
about $0.03.

Keeping the manual tools out of `build` and `plan` is done by the plugin itself,
in `index.js`, via each agent's permission ruleset. An enabled tool costs its
description on every request, so they stay off where they are never used —
overridable per user:

```jsonc
{ "agent": { "build": { "permission": { "hrbook_search": "allow" } } } }
```

## Cache

The first question about an unsynced manual fetches it automatically (~5 s);
every later one is local. To pre-seed a starter set instead:

```bash
node ~/.cache/opencode/packages/github:nedleeds/opencode/node_modules/@nedleeds/opencode/plugins/hrbook/cli.js --defaults
```

Installed from a working copy, that is simply `./plugins/hrbook/cli.js`. The
`hrbook-sync` bin is declared in `package.json`, but a plugin installed from git
lands in opencode's private cache, so it is not on `PATH`.

```
hrbook-sync --defaults              refresh bookinfos + sync a starter set
hrbook-sync --refresh               only re-fetch bookinfos.json
hrbook-sync --list [filter]         list manuals available to sync
hrbook-sync --status                show what is cached
hrbook-sync <book_id> <ver_id>...   sync specific manuals
```

`ver_id` is the git branch of the manual repo — `en`, `ko`, `zh`, `en-tp630`, …
Find valid pairs with `--list`:

```bash
hrbook-sync --list open-api
hrbook-sync doc-hi6-open-api en doc-hi6-open-api ko
```

Sync downloads one tarball per manual and keeps only `.md`, so the cache stays
small: the four default manuals are **855 pages in 4.8 MB** and take about
10 seconds.

## Closed / corporate network

Everything network-facing is overridable, and downloads go through `curl`, which
honours `HTTP_PROXY` / `HTTPS_PROXY` and the system CA store (Node's `fetch`
ignores proxy variables, which is why it is not used here).

| Variable | Default | Use |
|---|---|---|
| `HRBOOK_CACHE` | `~/.cache/hrbook` | Point at a shared read-only path so the team syncs once |
| `HRBOOK_TARBALL_BASE` | `https://codeload.github.com/hyundai-robotics` | Internal Git mirror |
| `HRBOOK_BOOKINFOS_URL` | raw.githubusercontent.com/…/bookinfos.json | Internal copy |
| `HRBOOK_VIEWER_BASE` | `https://hrbook-hrc.web.app` | Internal manual viewer |
| `HRBOOK_AUTOSYNC` | `1` | Set to `0` on a fully closed network so a miss fails fast |

**Fully offline:** sync on a machine with access, then copy `~/.cache/hrbook` to
the target machine (or a network share) and set `HRBOOK_CACHE` to it. No further
network access is needed — search and read are pure filesystem operations.

## Data model

- Manual sources live at `github.com/hyundai-robotics/<book_id>`, one **branch
  per `ver_id`**, in GitBook layout (`SUMMARY.md` is the table of contents).
- `bookinfos.json` maps `book_id` + `ver_id` → title, products, and `variables`
  (e.g. `cont_model: Hi6`), which are substituted into `${...}` placeholders on
  read.
- Viewer links are built as
  `<viewer>/#/view/<book_id>/<ver_id>/<path without .md>?cont_model=<model>`.

`book.md` is skipped during indexing: it is the whole manual concatenated (up to
~470 KB) and every line is duplicated from a real page.

## Requirements

Node 18+, plus `curl` and `tar` on `PATH` (both are standard on macOS and Linux).

## Files

| | |
|---|---|
| `index.js` | tool definitions + the `HRBook` agent |
| `agent.md` | the agent's system prompt |
| `lib.js` | cache, search, ranking, sync — no opencode coupling, so it is testable on its own |
| `cli.js` | `hrbook-sync` |
