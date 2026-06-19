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

export type SecretAccount = 'pgsodium-root-key' | 'tunnel-token';

export interface SecretCoordinates {
  /** Region label, used to scope the service identifier. */
  region: string;
  /** Which secret within the region. */
  account: SecretAccount;
}

function serviceFor(region: string): string {
  return `${SERVICE_PREFIX}.${region}`;
}

function labelFor(coords: SecretCoordinates): string {
  const friendly =
    coords.account === 'pgsodium-root-key' ? 'pgsodium root key' : 'Cloudflare Tunnel token';
  return `Opus Populi (${coords.region}) — ${friendly}`;
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
      reason: `security add-generic-password failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
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
  if (res.exitCode === 0 || res.exitCode === 44) return { ok: true };
  return {
    ok: false,
    reason: `security delete-generic-password failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
  };
}

/** Exported for tests + the rare caller that needs the raw service string. */
export const _internal = {
  serviceFor,
  labelFor,
  SERVICE_PREFIX,
};
