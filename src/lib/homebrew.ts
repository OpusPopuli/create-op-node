/**
 * Detect Homebrew + install packages (formulae or casks) idempotently.
 *
 * Bootstrap shells out to brew once per package — `brew install` is itself
 * idempotent (no-op when already installed) but we list-check first so the
 * wizard can print "already present" vs "installing…" and skip the
 * potentially-multi-minute download for packages that are already on the
 * Studio.
 *
 * We don't try to AUTO-install Homebrew itself. The official installer is a
 * curl-pipe-bash script that prompts for sudo + has its own UX; the wizard
 * detects its absence, prints the single-line install command, and waits for
 * the operator to confirm before proceeding.
 */

import { access } from 'node:fs/promises';

import { safeExeca } from './exec.js';

export type PackageKind = 'formula' | 'cask';

export interface PackageSpec {
  name: string;
  kind: PackageKind;
  /** For casks that install a GUI `.app`: if this path already exists, the app
   *  is present — possibly installed directly (not via Homebrew) or under a
   *  since-renamed cask. In that case `brew list` misses it and
   *  `brew install --cask` fails with "already an App at …", so we skip the
   *  install and report it as already present. (#89) */
  appPath?: string;
}

/** The package set the runbook installs on the Studio. Casks need GUI
 *  authorization on first launch — Docker Desktop in particular requires
 *  manual click-through after `brew install --cask docker`. The wizard
 *  surfaces that as a follow-up prompt; this list is just what we'd shell
 *  out for.
 *
 *  Deep-readonly via `as const` — neither the array nor the individual
 *  PackageSpec entries can be mutated by accident. */
export const STUDIO_PACKAGES = [
  { name: 'git', kind: 'formula' },
  { name: 'gh', kind: 'formula' },
  { name: 'pnpm', kind: 'formula' },
  { name: 'jq', kind: 'formula' },
  { name: 'cloudflared', kind: 'formula' },
  { name: 'rclone', kind: 'formula' },
  { name: 'ollama', kind: 'formula' },
  // Required for the fail-closed image-signature gate in `bootstrap` (#34).
  { name: 'cosign', kind: 'formula' },
  // Homebrew renamed the `docker` cask to `docker-desktop`. The appPath skip
  // means a directly-installed Docker Desktop (the common case) is treated as
  // present rather than tripping `brew install` on the existing app. (#89)
  { name: 'docker-desktop', kind: 'cask', appPath: '/Applications/Docker.app' },
  { name: 'tailscale', kind: 'cask', appPath: '/Applications/Tailscale.app' },
] as const satisfies readonly PackageSpec[];

export interface BrewInfo {
  installed: boolean;
  /** Version string when installed (`Homebrew 4.x.y`). Undefined otherwise. */
  version?: string;
}

export async function detectBrew(): Promise<BrewInfo> {
  const res = await safeExeca('brew', ['--version']);
  if (res === null || res.exitCode !== 0) {
    return { installed: false };
  }
  // `brew --version` prints e.g. "Homebrew 4.4.10".
  const version = res.stdout.split('\n').find((l) => l.startsWith('Homebrew '));
  return { installed: true, ...(version ? { version } : {}) };
}

/** The one-shot install command operators paste into their shell when brew is
 *  missing. Surfaced verbatim so the wizard can show + the docs can quote
 *  the same string. */
export const HOMEBREW_INSTALL_COMMAND =
  '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"';

/** Does a filesystem path exist? Used to detect a GUI app installed outside
 *  Homebrew. (#89) */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Is the named package already installed? A cask carrying an `appPath` counts
 * as present when that app already exists (installed directly, or under a
 * renamed cask) — otherwise `brew list` misses it and `brew install` fails on
 * the existing app. (#89) Otherwise `brew list <name>` exits 0 when yes,
 * non-zero when no; cask vs formula lookup uses different flags.
 */
export async function isPackageInstalled(pkg: PackageSpec): Promise<boolean> {
  if (pkg.appPath && (await pathExists(pkg.appPath))) {
    return true;
  }
  const flag = pkg.kind === 'cask' ? '--cask' : '--formula';
  const res = await safeExeca('brew', ['list', flag, pkg.name]);
  return res !== null && res.exitCode === 0;
}

export interface InstallResult {
  ok: boolean;
  /** Set when ok=false. Stderr or stdout from the failing command. */
  reason?: string;
}

/** Install one package. Caller should `isPackageInstalled` first to skip
 *  re-installs when speed matters; brew install is itself idempotent. */
export async function installPackage(pkg: PackageSpec): Promise<InstallResult> {
  const args =
    pkg.kind === 'cask'
      ? ['install', '--cask', pkg.name]
      : ['install', pkg.name];
  const res = await safeExeca('brew', args);
  if (res === null) {
    return { ok: false, reason: '`brew` not on PATH' };
  }
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason: `brew install ${pkg.name} failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true };
}

export interface InstallReport {
  installed: PackageSpec[];
  alreadyPresent: PackageSpec[];
  failed: Array<{ pkg: PackageSpec; reason: string }>;
}

/**
 * Install every package in the spec list. Each is independently logged into
 * one of three buckets so the wizard can show a clean summary. A failure in
 * one package doesn't abort the rest — we want the operator to see the
 * whole landscape and decide which to retry.
 */
export async function installPackages(
  packages: readonly PackageSpec[],
  onEach?: (pkg: PackageSpec, status: 'checking' | 'installing' | 'present' | 'installed' | 'failed') => void,
): Promise<InstallReport> {
  const report: InstallReport = {
    installed: [],
    alreadyPresent: [],
    failed: [],
  };
  for (const pkg of packages) {
    onEach?.(pkg, 'checking');
    if (await isPackageInstalled(pkg)) {
      report.alreadyPresent.push(pkg);
      onEach?.(pkg, 'present');
      continue;
    }
    onEach?.(pkg, 'installing');
    const r = await installPackage(pkg);
    if (r.ok) {
      report.installed.push(pkg);
      onEach?.(pkg, 'installed');
    } else {
      report.failed.push({ pkg, reason: r.reason ?? 'unknown' });
      onEach?.(pkg, 'failed');
    }
  }
  return report;
}
