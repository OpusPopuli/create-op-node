/**
 * Read + write the small set of macOS settings `create-op-node bootstrap`
 * cares about on the Mac Studio:
 *
 *   - Hostname and OS version (informational + sanity check we're on Apple Silicon).
 *   - Power management (`pmset`): auto-restart-on-power-failure, disk sleep.
 *   - FileVault status (`fdesetup`) — informational only; we don't toggle it,
 *     since the operator's earlier decision (gate 0.7 in the runbook) was OFF.
 *
 * All probes shell out via `safeExeca` from `lib/exec.ts` so a missing binary
 * (extremely unusual on macOS, but it's the principle) doesn't crash the
 * wizard. Writers use `pmset -a` which requires sudo on macOS — execa
 * propagates the operator's stdin so the password prompt works inline.
 */

import { safeExeca } from './exec.js';

export interface SystemSnapshot {
  hostname: string;
  /** `sw_vers -productVersion` output, or `null` when the call failed. */
  osVersion: string | null;
  /** True when `pmset -g` reports `autorestart 1`. */
  autoRestartOnPowerFailure: boolean;
  /** True when `pmset -g` reports `disksleep 0` (i.e. disk sleep DISABLED — the
   *  state the bootstrap wants). */
  diskSleepDisabled: boolean;
  /** `true` / `false` when `fdesetup status` reported decisively, `'unknown'`
   *  when the call failed or the output was unexpected. We don't toggle
   *  FileVault — this is for the operator-facing summary only. */
  fileVaultEnabled: boolean | 'unknown';
  /** True when `uname -m` returns `arm64` (i.e. Apple Silicon Mac).
   *  Bootstrap is M-series-only; Intel Macs fail with a clear message. */
  isAppleSilicon: boolean;
}

export async function inspectSystem(): Promise<SystemSnapshot> {
  const [hostnameOut, osVersionOut, pmsetOut, fdesetupOut, unameOut] =
    await Promise.all([
      safeExeca('hostname', []),
      safeExeca('sw_vers', ['-productVersion']),
      safeExeca('pmset', ['-g']),
      safeExeca('fdesetup', ['status']),
      safeExeca('uname', ['-m']),
    ]);

  return {
    hostname: hostnameOut?.stdout.trim() ?? 'unknown',
    osVersion:
      osVersionOut && osVersionOut.exitCode === 0
        ? osVersionOut.stdout.trim()
        : null,
    autoRestartOnPowerFailure: parsePmsetBool(pmsetOut?.stdout ?? '', 'autorestart', 1),
    diskSleepDisabled: parsePmsetBool(pmsetOut?.stdout ?? '', 'disksleep', 0),
    fileVaultEnabled: parseFileVault(fdesetupOut?.stdout ?? ''),
    isAppleSilicon: (unameOut?.stdout.trim() ?? '') === 'arm64',
  };
}

/**
 * `pmset -g` prints one space-separated `key value` per line, e.g.:
 *
 *   ```
 *    System-wide power settings:
 *    Currently in use:
 *      lidwake              1
 *      autorestart          1
 *      disksleep            0
 *   ```
 *
 * Returns `true` when the named key's value matches `expected`. Tolerant of
 * leading/trailing whitespace; matches first occurrence.
 */
export function parsePmsetBool(
  output: string,
  key: string,
  expected: number,
): boolean {
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*([a-z]+)\s+(-?\d+)\s*$/);
    if (match && match[1] === key) {
      return Number(match[2]) === expected;
    }
  }
  return false;
}

/**
 * `fdesetup status` prints either:
 *   - `FileVault is On.`
 *   - `FileVault is Off.`
 *   - `Encryption in progress: ...` (treat as On)
 *   - anything else → `'unknown'`
 */
export function parseFileVault(output: string): boolean | 'unknown' {
  const trimmed = output.trim();
  if (/^FileVault is On\.?/i.test(trimmed)) return true;
  if (/^FileVault is Off\.?/i.test(trimmed)) return false;
  if (/encryption in progress/i.test(trimmed)) return true;
  return 'unknown';
}

export interface SetResult {
  ok: boolean;
  /** Set when `ok=false`. Stderr or stdout from the failing command. */
  reason?: string;
}

/**
 * Enable auto-restart-on-power-failure (`pmset -a autorestart 1`). Requires
 * sudo; the operator's password prompt is inherited from the parent shell.
 */
export async function enableAutoRestartOnPowerFailure(): Promise<SetResult> {
  return runSudoPmset(['autorestart', '1']);
}

/** Disable disk sleep (`pmset -a disksleep 0`). Same sudo behavior. */
export async function disableDiskSleep(): Promise<SetResult> {
  return runSudoPmset(['disksleep', '0']);
}

/**
 * Read the Studio's unified memory in GB via `sysctl hw.memsize`. Returns
 * `null` when sysctl is unavailable or the output is unparseable — callers
 * fall back to platform defaults in that case.
 *
 * `hw.memsize` reports bytes (e.g. `137438953472` for 128 GB). We divide
 * by 2^30 and round; vendors mostly ship integer GB so the rounding is
 * cosmetic, but the user may see `127` instead of `128` on rare configs.
 */
export async function detectUnifiedMemoryGB(): Promise<number | null> {
  const res = await safeExeca('sysctl', ['-n', 'hw.memsize']);
  if (res === null || res.exitCode !== 0) return null;
  const bytes = Number.parseInt(res.stdout.trim(), 10);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  return Math.round(bytes / 2 ** 30);
}

async function runSudoPmset(args: string[]): Promise<SetResult> {
  const res = await safeExeca('sudo', ['pmset', '-a', ...args]);
  if (res === null) {
    return { ok: false, reason: '`sudo` not on PATH' };
  }
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason: `pmset ${args.join(' ')} failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true };
}
