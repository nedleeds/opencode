import { z } from 'zod';

/**
 * Stands in for `tool` from `@opencode-ai/plugin`, which is nothing but this:
 * an identity function plus a re-export of zod (see its dist/tool.js).
 *
 * Depending on the real package would drag `@opencode-ai/sdk`, `effect` and
 * `@ai-sdk/provider` into the install. That is fine over npm, but this repo is
 * installed straight from git, and npm installs a git dependency by cloning it
 * and resolving its whole tree — a tree that big regularly failed to finish
 * inside opencode's startup window, leaving a half-written node_modules and no
 * tools registered, with nothing logged. zod alone has no dependencies, so the
 * install is one tarball and always completes.
 *
 * Pinned to the exact zod version opencode itself ships so the schemas stay
 * structurally identical to what the host expects.
 */
export function tool(input) {
  return input;
}

tool.schema = z;
