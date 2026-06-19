/**
 * Locate or clone the operator's node deployment repo on the Mac Studio.
 *
 * The bootstrap subcommand wants a working tree of the operator's region
 * deployment repo (created from `OpusPopuli/opuspopuli-node` by `init`) on
 * the Studio's filesystem — it's the source of `docker-compose-prod.yml`,
 * `supabase/init/`, `backup/scripts/`, `observability/`, etc.
 *
 * Three discovery paths the wizard tries in order:
 *
 *   1. **Explicit `--repo-dir`** — operator passed a path. Verify it's a
 *      node repo (looks for the marker file) and use it.
 *   2. **Current directory** — operator may have already cloned + cd'd.
 *      Same marker probe.
 *   3. **Clone fresh** — shell out to `gh repo clone <owner>/<repo>` into
 *      `~/Development/<repo>`. The default location keeps it under the
 *      operator's home (no sudo) and groups it with other dev work.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

import { safeExeca } from './exec.js';

/** Files that a freshly-cloned (or template-derived) node repo always has.
 *  Probing for these is how we distinguish a node repo from an arbitrary
 *  directory the operator pointed us at. */
export const NODE_REPO_MARKERS = [
  'docker-compose-prod.yml',
  'supabase/init/pgsodium_getkey_env.sh',
] as const;

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** True when every marker file is present at `dir`. False otherwise. */
export async function looksLikeNodeRepo(dir: string): Promise<boolean> {
  const checks = await Promise.all(
    NODE_REPO_MARKERS.map((m) => fileExists(join(dir, m))),
  );
  return checks.every((ok) => ok);
}

export interface LocateInput {
  /** Owner of the node repo, e.g. `OpusPopuli`. */
  owner: string;
  /** Repo name, e.g. `opuspopuli-node-us-ca`. */
  name: string;
  /** Operator-supplied override (--repo-dir). When set, we use it iff it
   *  looks like a node repo; otherwise return an error rather than fall
   *  through to cloning a fresh copy. */
  explicit?: string;
  /** Where to put a fresh clone when neither --repo-dir nor cwd matches.
   *  Default: ~/Development/<name>. */
  cloneInto?: string;
  /** When false, refuse to clone and require the operator to provide
   *  a working tree (skip the gh shell-out). Default: true. */
  allowClone?: boolean;
  /** Working directory to probe as the "already-cloned-and-cd'd" path. */
  cwd?: string;
}

export type LocateOutcome =
  | { kind: 'found'; path: string; source: 'explicit' | 'cwd' }
  | { kind: 'cloned'; path: string }
  | { kind: 'explicit-not-a-node-repo'; path: string }
  | { kind: 'gh-not-installed' }
  | { kind: 'clone-failed'; reason: string }
  | { kind: 'clone-disallowed' };

/**
 * Walk the three discovery paths and return a discriminated outcome the
 * wizard can render. Cleanly separates "operator-intentional path" failures
 * from "we tried but couldn't help" failures.
 */
export async function locateOrCloneRepo(input: LocateInput): Promise<LocateOutcome> {
  // 1. Explicit --repo-dir.
  if (input.explicit) {
    if (await looksLikeNodeRepo(input.explicit)) {
      return { kind: 'found', path: input.explicit, source: 'explicit' };
    }
    return { kind: 'explicit-not-a-node-repo', path: input.explicit };
  }

  // 2. CWD probe.
  const cwd = input.cwd ?? process.cwd();
  if (await looksLikeNodeRepo(cwd)) {
    return { kind: 'found', path: cwd, source: 'cwd' };
  }

  // 3. Clone fresh.
  if (input.allowClone === false) {
    return { kind: 'clone-disallowed' };
  }

  const target = input.cloneInto ?? join(homedir(), 'Development', input.name);
  const res = await safeExeca('gh', ['repo', 'clone', `${input.owner}/${input.name}`, target]);
  if (res === null) return { kind: 'gh-not-installed' };
  if (res.exitCode !== 0) {
    return {
      kind: 'clone-failed',
      reason: `gh repo clone failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { kind: 'cloned', path: target };
}
