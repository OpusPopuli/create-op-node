/**
 * Shared `execa` wrapper for the few CLIs the wizard shells out to (`op`, `gh`).
 *
 * Two patterns this exists to share:
 *
 *   1. `reject: false` is opt-out on every call, since we want to inspect the
 *      exit code rather than have a thrown error fan out across the wizard.
 *   2. **ENOENT doesn't suppress** under `reject: false` — that's a spawn
 *      error, not a child-process exit. Callers that don't catch it crash.
 *      `safeExeca` traps `ENOENT` / `ENOTDIR` and returns `null` so callers
 *      can branch on "binary not installed at all" cleanly.
 *
 * The shape kept narrow on purpose — adds nothing execa doesn't, just makes
 * the failure modes uniform across call sites.
 */

import { execa, ExecaError } from 'execa';

export interface SafeExecaResult {
  /** Exit code from the child. `undefined` when the child was killed by a
   *  signal — we pass it through honestly so callers can distinguish
   *  signal-killed from clean zero. */
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
}

/**
 * Run a command; return `null` when the binary isn't on PATH at all, an
 * object with exit code + output otherwise. Never throws on a missing
 * binary, never throws on a non-zero exit.
 */
export async function safeExeca(
  cmd: string,
  args: string[],
  options?: {
    input?: string;
    /** Working directory for the child. Defaults to the parent's cwd. */
    cwd?: string;
    /** Extra env vars merged into the child's env (execa's default
     *  extendEnv: true means these add to process.env rather than
     *  replace). Used by bootstrap's compose subprocess calls so the
     *  Keychain-loaded secrets reach docker compose without first
     *  being written to a plaintext .env file on disk. */
    env?: NodeJS.ProcessEnv;
  },
): Promise<SafeExecaResult | null> {
  try {
    const result = await execa(cmd, args, { reject: false, ...options });
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    const e = err as ExecaError & NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw err;
  }
}
