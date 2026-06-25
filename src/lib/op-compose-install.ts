/**
 * Side-effecting installer for the `bin/op-compose` wrapper script.
 *
 * Pure rendering lives in op-compose-script.ts so it stays unit-testable.
 * This file owns:
 *   1. Creating `<repo>/bin/` if needed
 *   2. Atomically writing the script (temp file + rename) so an
 *      interrupted bootstrap never leaves a half-written wrapper that
 *      `exec` would crash on
 *   3. `chmod 0755` so the operator can run `./bin/op-compose`
 */

import { chmod, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderOpComposeScript, type OpComposeScriptInput } from './op-compose-script.js';

export interface InstallOpComposeInput extends OpComposeScriptInput {
  /** Directory containing the compose file. Script lands at `<repoDir>/bin/op-compose`. */
  repoDir: string;
}

export interface InstallOpComposeResult {
  ok: boolean;
  /** Absolute path the script was written to, when ok=true. */
  path?: string;
  reason?: string;
}

export async function installOpComposeWrapper(
  input: InstallOpComposeInput,
): Promise<InstallOpComposeResult> {
  let content: string;
  try {
    content = renderOpComposeScript({
      region: input.region,
      ...(input.promptServiceUrl !== undefined ? { promptServiceUrl: input.promptServiceUrl } : {}),
    });
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }

  const binDir = join(input.repoDir, 'bin');
  const target = join(binDir, 'op-compose');
  const tmp = `${target}.tmp.${process.pid}`;

  try {
    await mkdir(binDir, { recursive: true });
    await writeFile(tmp, content, { mode: 0o755 });
    // mkdir/writeFile respect umask; chmod ensures 0755 regardless.
    await chmod(tmp, 0o755);
    await rename(tmp, target); // atomic on POSIX
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: `writing ${target} failed: ${(err as Error).message}` };
  }
}
