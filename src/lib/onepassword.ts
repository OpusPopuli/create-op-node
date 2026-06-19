/**
 * Thin wrapper around the 1Password CLI (`op`).
 *
 * `init` uses 1Password to persist two long-lived secrets out of band:
 *
 *   - the pgsodium master key (generated locally during init)
 *   - the Cloudflare Tunnel token (read back from TFC outputs after apply)
 *
 * Both are written as Secure Notes when `op` is installed AND the operator is
 * signed in. When `op` isn't available, callers fall back to prompting the
 * operator to paste the value into 1Password by hand.
 *
 * We deliberately do NOT read secrets out of 1Password here — the wizard
 * prompts the operator for things like the Cloudflare token interactively, on
 * the theory that "1Password CLI signed in" doesn't imply "this terminal
 * should hand out all your prod creds." If we add a `--from-op` flag later,
 * read helpers go alongside the write helpers.
 */

import { execa } from 'execa';

export interface OpAvailability {
  /** `op` CLI is on PATH. */
  installed: boolean;
  /** `op whoami` returns success — there's an active signed-in account. */
  signedIn: boolean;
  /** Email of the signed-in account when available, otherwise `undefined`. */
  email?: string;
}

/** Probe both halves of "can we use 1Password automation right now?" — install
 *  presence and an active session. Caller decides whether to use it. */
export async function detectOp(): Promise<OpAvailability> {
  let installed = false;
  try {
    await execa('op', ['--version'], { reject: false });
    installed = true;
  } catch {
    return { installed: false, signedIn: false };
  }

  const whoami = await execa('op', ['whoami', '--format=json'], { reject: false });
  if (whoami.exitCode !== 0) {
    return { installed, signedIn: false };
  }

  let email: string | undefined;
  try {
    const parsed = JSON.parse(whoami.stdout) as { email?: string };
    email = parsed.email;
  } catch {
    /* not JSON — leave email undefined */
  }
  return {
    installed,
    signedIn: true,
    ...(email ? { email } : {}),
  };
}

export interface SaveSecretInput {
  /** Item title. Convention: `<region>-<purpose>`, e.g. `op-us-ca-pgsodium-root-key`. */
  title: string;
  /** Secret body. Written into the Secure Note's notes field. */
  value: string;
  /** 1Password vault to write into. Defaults to the operator's Private vault. */
  vault?: string;
  /** When true, allow overwriting an existing item with the same title in the
   *  same vault. Default false. */
  overwrite?: boolean;
}

export interface SaveSecretResult {
  /** True when the secret was written by this call. */
  written: boolean;
  /** True when an item by this title already existed and `overwrite=false`. */
  alreadyExisted: boolean;
  /** Free-text reason when written=false and alreadyExisted=false. */
  reason?: string;
}

/**
 * Create a Secure Note item with the given title + body. When an item by the
 * same title already exists, returns `{ written: false, alreadyExisted: true }`
 * so the caller can decide whether to overwrite (use `overwrite: true`) or
 * surface the duplicate to the operator.
 *
 * Stays silent about the contents — `op` only sees the value through argv
 * once and never logs it.
 */
export async function saveSecretToOp(input: SaveSecretInput): Promise<SaveSecretResult> {
  const vaultArg = input.vault ? ['--vault', input.vault] : [];

  const existing = await execa(
    'op',
    ['item', 'get', input.title, ...vaultArg, '--format=json'],
    { reject: false },
  );

  if (existing.exitCode === 0) {
    if (!input.overwrite) {
      return { written: false, alreadyExisted: true };
    }
    // Edit the notes field on the existing item instead of creating a duplicate.
    const edit = await execa(
      'op',
      ['item', 'edit', input.title, ...vaultArg, `notesPlain=${input.value}`],
      { reject: false },
    );
    if (edit.exitCode !== 0) {
      return {
        written: false,
        alreadyExisted: true,
        reason: `op item edit failed: ${edit.stderr || edit.stdout}`,
      };
    }
    return { written: true, alreadyExisted: true };
  }

  const create = await execa(
    'op',
    [
      'item',
      'create',
      '--category',
      'Secure Note',
      '--title',
      input.title,
      ...vaultArg,
      `notesPlain=${input.value}`,
    ],
    { reject: false },
  );

  if (create.exitCode !== 0) {
    return {
      written: false,
      alreadyExisted: false,
      reason: `op item create failed: ${create.stderr || create.stdout}`,
    };
  }
  return { written: true, alreadyExisted: false };
}
