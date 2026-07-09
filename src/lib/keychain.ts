/**
 * macOS Keychain wrapper around the built-in `security` CLI.
 *
 * Replaces the 1Password integration as of v0.3.0: secrets live in the
 * operator's login keychain (FileVault-encrypted at rest, locked with
 * the user session). Generic-password items only — we don't need
 * internet-password semantics.
 *
 * **Cross-device caveat:** the `security` CLI cannot create iCloud-
 * Keychain-synchronizable items (no `kSecAttrSynchronizable` flag is
 * exposed). Items written here stay on the machine they were written
 * on. `init` writes on the laptop; `bootstrap` reads on the Studio.
 * On a Studio miss, bootstrap falls back to prompting the operator to
 * paste the value and persists it locally for re-runs.
 *
 * **Argv exposure caveat:** `security add-generic-password -w <value>`
 * passes the secret via argv. It's briefly visible to anyone running
 * `ps -E` while the child is alive. Same risk model as the
 * `op item create notesPlain=<value>` pattern we previously accepted.
 * If a future `security` release adds a stdin form, swap to it here.
 */

import { safeExeca } from './exec.js';

/** Reverse-DNS prefix for all Opus Populi entries in Keychain Access. */
const SERVICE_PREFIX = 'org.opuspopuli';

export type SecretAccount =
  | 'pgsodium-root-key'
  | 'tunnel-token'
  | 'postgres-password'
  | 'jwt-secret'
  | 'supabase-anon-key'
  | 'supabase-service-role-key'
  | 'dashboard-password'
  | 'prompts-db-password'
  | 'prompt-service-api-key'
  | 'prompt-service-admin-api-key'
  | 'gateway-hmac-secret'
  | 'grafana-admin-password';

export interface SecretCoordinates {
  /** Region label, used to scope the service identifier. */
  region: string;
  /** Which secret within the region. */
  account: SecretAccount;
}

function serviceFor(region: string): string {
  return `${SERVICE_PREFIX}.${region}`;
}

const FRIENDLY: Record<SecretAccount, string> = {
  'pgsodium-root-key': 'pgsodium root key',
  'tunnel-token': 'Cloudflare Tunnel token',
  'postgres-password': 'Postgres password',
  'jwt-secret': 'JWT signing secret',
  'supabase-anon-key': 'Supabase anon key',
  'supabase-service-role-key': 'Supabase service role key',
  'dashboard-password': 'Supabase Studio dashboard password',
  'prompts-db-password': 'prompt-service Postgres password',
  'prompt-service-api-key': 'prompt-service HMAC API key',
  'prompt-service-admin-api-key': 'prompt-service admin API key',
  'gateway-hmac-secret': 'API Gateway HMAC secret',
  'grafana-admin-password': 'Grafana admin password',
};

function labelFor(coords: SecretCoordinates): string {
  return `Opus Populi (${coords.region}) — ${FRIENDLY[coords.account]}`;
}

export interface KeychainAvailability {
  /** True when the `security` CLI ran cleanly (macOS or compatible). On
   *  non-macOS hosts this is false and callers should fall back to
   *  prompt-only flows. */
  available: boolean;
  /** Free-text reason when unavailable. */
  reason?: string;
}

export async function detectKeychain(): Promise<KeychainAvailability> {
  const res = await safeExeca('security', ['-h']);
  if (res === null) {
    return {
      available: false,
      reason: '`security` CLI not on PATH (Keychain requires macOS)',
    };
  }
  return { available: true };
}

export interface SaveSecretResult {
  written: boolean;
  /** True when an item already existed and was updated (via -U upsert). */
  updated: boolean;
  reason?: string;
}

/**
 * Write a generic-password item, upserting if it already exists. Uses
 * `add-generic-password -U` so re-runs don't error on duplicates.
 */
export async function saveSecret(
  coords: SecretCoordinates,
  value: string,
): Promise<SaveSecretResult> {
  const service = serviceFor(coords.region);
  const label = labelFor(coords);

  // Check whether the item exists ahead of the upsert so we can report
  // `updated: true` vs `written: true` to the caller (purely informational —
  // the operator sees a different message in the wizard).
  const existing = await safeExeca('security', [
    'find-generic-password',
    '-s',
    service,
    '-a',
    coords.account,
  ]);
  const updated = existing !== null && existing.exitCode === 0;

  const res = await safeExeca('security', [
    'add-generic-password',
    '-U',                  // upsert
    '-s', service,
    '-a', coords.account,
    '-l', label,
    '-D', 'Opus Populi secret',
    '-w', value,           // argv-exposure caveat, see file header
  ]);
  if (res === null) {
    return { written: false, updated: false, reason: '`security` CLI not on PATH' };
  }
  if (res.exitCode !== 0) {
    return {
      written: false,
      updated,
      reason: `security add-generic-password failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}${formatKeychainHint(res.exitCode)}`,
    };
  }
  return { written: true, updated };
}

/**
 * Read a generic-password item by service + account. Returns `null` when
 * the item doesn't exist, `security` isn't available, or the value is
 * empty. Callers branch to a paste prompt on `null`.
 */
export async function readSecret(coords: SecretCoordinates): Promise<string | null> {
  const service = serviceFor(coords.region);

  const res = await safeExeca('security', [
    'find-generic-password',
    '-s', service,
    '-a', coords.account,
    '-w',  // print the password to stdout (final flag = read mode)
  ]);
  if (res === null || res.exitCode !== 0) return null;
  const value = res.stdout.trim();
  return value.length > 0 ? value : null;
}

/** Delete a generic-password item. Idempotent — missing items return ok. */
export async function deleteSecret(coords: SecretCoordinates): Promise<{ ok: boolean; reason?: string }> {
  const service = serviceFor(coords.region);

  const res = await safeExeca('security', [
    'delete-generic-password',
    '-s', service,
    '-a', coords.account,
  ]);
  if (res === null) return { ok: false, reason: '`security` CLI not on PATH' };
  // Exit 44 (errSecItemNotFound) is fine — already gone.
  if (res.exitCode === 0 || res.exitCode === ERR_SEC_ITEM_NOT_FOUND) return { ok: true };
  return {
    ok: false,
    reason: `security delete-generic-password failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}${formatKeychainHint(res.exitCode)}`,
  };
}

/**
 * macOS `security` exit codes we care about. Defined as constants so callers
 * can reason about them without sprinkling magic numbers.
 *   36 = errSecInteractionNotAllowed — keychain is locked / no UI session
 *   44 = errSecItemNotFound — item doesn't exist (treated as "ok" for delete)
 */
export const ERR_SEC_INTERACTION_NOT_ALLOWED = 36;
export const ERR_SEC_ITEM_NOT_FOUND = 44;

/** Append an operator-friendly remediation hint to a `security` error
 *  message when the exit code maps to one we recognize. Returns empty
 *  string when no hint applies, so the call site can safely concatenate. */
function formatKeychainHint(exitCode: number | null | undefined): string {
  if (exitCode === ERR_SEC_INTERACTION_NOT_ALLOWED) {
    return (
      `\n` +
      `Hint: the login keychain is locked (SSH sessions don't auto-unlock it).\n` +
      `Run \`security unlock-keychain ~/Library/Keychains/login.keychain-db\` and re-run bootstrap.`
    );
  }
  return '';
}

/**
 * Probe whether the login keychain is currently locked. Implemented by
 * attempting a no-op `find-generic-password` against a service that won't
 * exist: exit 44 (errSecItemNotFound) → unlocked, exit 36 → locked.
 *
 * Used by bootstrap to proactively prompt SSH operators for their login
 * password before the first Keychain write — without this, the operator
 * gets nine identical failures (one per secret) before they figure out
 * the keychain is locked.
 */
export async function isKeychainLocked(): Promise<boolean> {
  const res = await safeExeca('security', [
    'find-generic-password',
    '-s',
    `${SERVICE_PREFIX}.__op_node_lock_probe__`,
    '-a',
    '__nothing_here__',
  ]);
  if (res === null) return false; // no security CLI; can't be locked
  return res.exitCode === ERR_SEC_INTERACTION_NOT_ALLOWED;
}

export interface UnlockResult {
  ok: boolean;
  reason?: string;
}

/**
 * Unlock the login keychain via `security unlock-keychain -p <password>`.
 *
 * argv-exposure caveat: the password is visible briefly to `ps -E` while
 * the security child is alive. Same risk model as `saveSecret` writing
 * the secret value via `-w`. The `security` CLI doesn't expose a stdin
 * password form for unlock, so this is the cleanest option available.
 *
 * Callers should prompt the operator via clack's `p.password()` (which
 * doesn't echo) and pass the value here.
 */
export async function unlockKeychain(password: string): Promise<UnlockResult> {
  const res = await safeExeca('security', [
    'unlock-keychain',
    '-p',
    password,
    // Default keychain path — same as the operator's GUI login keychain
    // on a stock macOS install. Lets us avoid a homedir lookup here.
    `${process.env['HOME'] ?? ''}/Library/Keychains/login.keychain-db`,
  ]);
  if (res === null) return { ok: false, reason: '`security` CLI not on PATH' };
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason: `security unlock-keychain failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true };
}

/** Heuristic: are we running inside an SSH session?
 *  `SSH_CONNECTION` is set by sshd on every interactive login. `SSH_TTY`
 *  is set on TTY-allocated sessions; we check both. Process-env only —
 *  no syscalls. */
export function isSshSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env['SSH_CONNECTION'] ?? env['SSH_TTY']);
}

/** Exported for tests + the rare caller that needs the raw service string. */
export const _internal = {
  serviceFor,
  labelFor,
  SERVICE_PREFIX,
};
