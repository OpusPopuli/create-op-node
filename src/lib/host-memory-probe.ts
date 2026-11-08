/**
 * Host memory probe — install, remove, and the URL `verify` reads.
 *
 * The backend refuses to LOAD an Ollama model when the host has no room for it
 * (opuspopuli#1435). Containers cannot see host memory, so a small probe runs on
 * the host as a per-user launchd agent (`org.opuspopuli.host-memory-probe`) and
 * answers `GET /memory` with `{ reclaimableBytes, swapUsedBytes, swapTotalBytes,
 * at }`. Containers reach it at `host.docker.internal`.
 *
 * The probe and its installer ship in the node repo
 * (`scripts/host-memory-probe/install.sh`), not here, so a node gets the probe
 * version that matches the compose it runs. This module only drives that
 * script. The backend fails CLOSED when the probe URL is set but nothing
 * answers, so bootstrap must install it before the stack starts.
 */

import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { safeExeca } from './exec.js';

/** Port the probe binds on 127.0.0.1 (the installer's default). */
export const HOST_MEMORY_PROBE_PORT = 11500;

/** Where `verify` reads the probe from, on the node itself. */
export const HOST_MEMORY_PROBE_URL = `http://127.0.0.1:${HOST_MEMORY_PROBE_PORT}/memory`;

/** Installer path inside a node repo checkout. */
export const HOST_MEMORY_PROBE_SCRIPT = join('scripts', 'host-memory-probe', 'install.sh');

export function hostMemoryProbeScript(repoPath: string): string {
  return join(repoPath, HOST_MEMORY_PROBE_SCRIPT);
}

export type ProbeScriptOutcome =
  | { ok: true; output: string }
  /** The node repo predates the probe — nothing was run. */
  | { ok: false; missing: true; script: string; reason: string }
  | { ok: false; missing: false; script: string; reason: string };

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Run the installer with `args`. Invoked through `bash` so a checkout that
 *  lost the script's exec bit still works. */
async function runProbeScript(
  repoPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<ProbeScriptOutcome> {
  const script = hostMemoryProbeScript(repoPath);
  if (!(await exists(script))) {
    return {
      ok: false,
      missing: true,
      script,
      reason: `${script} not found — this node repo predates the host memory probe. Pull the node repo (git -C ${repoPath} pull) and re-run.`,
    };
  }
  const res = await safeExeca('bash', [script, ...args], { cwd: repoPath, env });
  if (res === null) {
    return { ok: false, missing: false, script, reason: 'bash not found on PATH' };
  }
  if (res.exitCode !== 0) {
    const detail = res.stderr.trim() || res.stdout.trim() || `exit ${res.exitCode ?? 'signal'}`;
    return { ok: false, missing: false, script, reason: detail };
  }
  return { ok: true, output: res.stdout.trim() };
}

/**
 * Install (or update) and start the probe agent. `nodePath` is the node binary
 * the agent runs with — bootstrap passes the one it is running on, because
 * launchd does not read the operator's PATH or nvm. Returns once the probe
 * answers (the installer waits for it).
 */
export function installHostMemoryProbe(args: {
  repoPath: string;
  nodePath?: string;
}): Promise<ProbeScriptOutcome> {
  return runProbeScript(args.repoPath, [], {
    HOST_MEMORY_PROBE_NODE: args.nodePath ?? process.execPath,
  });
}

/** Unload the agent and remove its plist + installed copy. */
export function uninstallHostMemoryProbe(repoPath: string): Promise<ProbeScriptOutcome> {
  return runProbeScript(repoPath, ['--uninstall'], {});
}

export type HostMemoryReading =
  | { ok: true; reclaimableBytes: number }
  | { ok: false; reason: string };

/** Parse the probe's `/memory` body. Pure. */
export function parseHostMemoryBody(body: string): HostMemoryReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: `response was not JSON: ${body}` };
  }
  const reclaimable = (parsed as { reclaimableBytes?: unknown } | null)?.reclaimableBytes;
  if (typeof reclaimable !== 'number' || !Number.isFinite(reclaimable) || reclaimable < 0) {
    return { ok: false, reason: `response has no numeric reclaimableBytes: ${body}` };
  }
  return { ok: true, reclaimableBytes: reclaimable };
}
