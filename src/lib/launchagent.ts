/**
 * macOS LaunchAgent for the env-loader that the bootstrap puts in place.
 *
 * The plist's whole job is to inject two env vars into the launchd session at
 * login so Docker Desktop + the container stack see them:
 *
 *   PGSODIUM_ROOT_KEY  — 64-hex pgsodium master key, read from a `0400` file
 *                        outside the container so a `docker compose --build`
 *                        can never wipe it (runbook gate / #791).
 *   TUNNEL_TOKEN       — Cloudflare Tunnel token, baked into the plist literal.
 *
 * The pgsodium key is materialized as a separate `0400` file (not embedded in
 * the plist) so it can be backed up out-of-band + rotated independently. The
 * Tunnel token gets baked into the plist directly — it's a different rotation
 * cadence (rotates with the Tunnel resource, not on pgsodium key churn).
 *
 * File modes match the runbook:
 *   - pgsodium key file: 0400 (owner-read-only)
 *   - plist file:        0600 (owner read+write; contains TUNNEL_TOKEN)
 */

import { mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { homedir } from 'node:os';

import {
  PGSODIUM_KEY_RE,
  SAFE_LAUNCHCTL_VALUE_RE,
  SAFE_PATH_RE,
  SAFE_URL_RE,
  TUNNEL_TOKEN_RE,
} from './constants.js';
import { safeExeca } from './exec.js';

export const LAUNCH_AGENT_LABEL = 'org.opuspopuli.envloader';

export interface LaunchAgentPaths {
  /** Absolute path to the 64-hex pgsodium master key file (mode 0400). */
  keyFile: string;
  /** Absolute path to the LaunchAgent plist (mode 0600). */
  plistFile: string;
}

/** Default on-disk locations the runbook documents. Operators can override. */
export function defaultPaths(home: string = homedir()): LaunchAgentPaths {
  return {
    keyFile: `${home}/.config/opuspopuli/pgsodium_root_key`,
    plistFile: `${home}/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`,
  };
}

export interface WriteResult {
  ok: boolean;
  /** Set when ok=false. */
  reason?: string;
}

/**
 * Write the 64-hex pgsodium master key to `keyFile` with mode 0400. Creates
 * the parent directory tree (mode 0700 on the immediate parent) and refuses
 * non-64-hex input.
 */
export async function writePgsodiumKeyFile(
  key: string,
  keyFile: string,
): Promise<WriteResult> {
  if (!PGSODIUM_KEY_RE.test(key)) {
    return {
      ok: false,
      reason: `pgsodium key must be 64 lowercase hex characters (got ${key.length} chars)`,
    };
  }
  try {
    const dir = dirname(keyFile);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // Remove any existing key file first. It's written mode 0400 (read-only),
    // so on a re-run `writeFile` (which opens O_WRONLY|O_TRUNC) would fail
    // EACCES — the `mode` option only applies when the file is created, not to
    // an existing one. `force: true` ignores a missing file, keeping the write
    // idempotent across bootstrap re-runs. (#93)
    await rm(keyFile, { force: true });
    await writeFile(keyFile, key, { mode: 0o400 });
    // mkdir's mode option respects umask; chmod is the belt to the suspenders.
    await chmod(dir, 0o700);
    await chmod(keyFile, 0o400);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `writing ${keyFile} failed: ${(err as Error).message}` };
  }
}

export interface PlistInput {
  /** Path the plist will exec — sourced from defaultPaths() unless an operator
   *  overrides on the command line. */
  keyFilePath: string;
  /** Literal Cloudflare Tunnel token; embedded in the plist. Omit for
   *  `bootstrap --local-only` flows where no Tunnel is provisioned — the
   *  rendered plist will only set PGSODIUM_ROOT_KEY. */
  tunnelToken?: string;
  /** Self-hosted Supabase credentials. When provided, the plist exports each
   *  value via `launchctl setenv` so docker-compose-prod.yml — and every
   *  Supabase container the compose brings up — sees them. Omit individual
   *  fields to skip emitting that var (e.g. for partial re-runs). */
  postgresPassword?: string;
  jwtSecret?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  dashboardPassword?: string;
  /** API Gateway HMAC secret (base64url). When set, plist exports
   *  `GATEWAY_HMAC_SECRET`. The derived `API_KEYS` JSON is NOT emitted here:
   *  its `{`/`"`/`:` characters can't pass a `launchctl setenv` value safely,
   *  so the op-compose wrapper (and bootstrap's own compose env) render it. */
  gatewayHmacSecret?: string;
  /** Grafana admin password (base64url). When set, plist exports
   *  `GRAFANA_ADMIN_PASSWORD`. */
  grafanaAdminPassword?: string;
  /** Public-facing Supabase URL — what browsers + microservices use to reach
   *  Kong. Local dev: `http://localhost:8000`. Tunnel: `https://supabase.<domain>`. */
  supabaseUrl?: string;
}

/**
 * Render the LaunchAgent plist XML. Pure function — caller writes it.
 *
 * The plist runs a `/bin/sh -c` at load that calls `launchctl setenv` for
 * each var. `launchctl setenv` exports into the running launchd session,
 * not just the agent's own env, so anything Docker Desktop launches
 * downstream sees the same values.
 *
 * Required: `PGSODIUM_ROOT_KEY`. Optional: `TUNNEL_TOKEN` + the Supabase
 * credentials — omitted from the setenv list when their inputs are undefined.
 *
 * Model config (`LLM_MODEL` / `EMBEDDINGS_OLLAMA_MODEL` / `NODE_ENV`) is deliberately
 * NOT set here: those are non-secret substitution vars that live in the node's
 * `.env` (single source of truth). A launchctl setenv value would shadow
 * `.env` at compose interpolation time, so it stays out of the launchd session.
 */
export function renderLaunchAgentPlist(input: PlistInput): string {
  validatePlistInput(input);
  const command = buildSetenvCommand(input);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCH_AGENT_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    '    <string>/bin/sh</string>',
    '    <string>-c</string>',
    `    <string>${command}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key><true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

// Reject any input that would break the XML or inject shell metacharacters
// into the `sh -c` body launchd runs at every login. Throws on the first
// offending field. Our own generators only emit safe alphabets, but
// operators can pass --import-* overrides, so re-validate here.
function validatePlistInput(input: PlistInput): void {
  if (input.tunnelToken !== undefined && !TUNNEL_TOKEN_RE.test(input.tunnelToken)) {
    throw new Error('Tunnel token contains characters outside the expected base64-url set');
  }
  if (!SAFE_PATH_RE.test(input.keyFilePath)) {
    // The keyFilePath gets interpolated into a `sh -c` command run by launchd
    // at every login — reject shell metacharacters even though defaultPaths()
    // never produces one (defense in depth against operator overrides).
    throw new Error(
      `keyFilePath ${JSON.stringify(input.keyFilePath)} contains characters not allowed in a launchd path interpolation`,
    );
  }
  const supabaseFields: Array<[keyof PlistInput, string | undefined]> = [
    ['postgresPassword', input.postgresPassword],
    ['jwtSecret', input.jwtSecret],
    ['supabaseAnonKey', input.supabaseAnonKey],
    ['supabaseServiceRoleKey', input.supabaseServiceRoleKey],
    ['dashboardPassword', input.dashboardPassword],
    ['gatewayHmacSecret', input.gatewayHmacSecret],
    ['grafanaAdminPassword', input.grafanaAdminPassword],
  ];
  for (const [name, value] of supabaseFields) {
    if (value !== undefined && !SAFE_LAUNCHCTL_VALUE_RE.test(value)) {
      throw new Error(`${String(name)} contains characters not allowed in a launchd setenv value`);
    }
  }
  if (input.supabaseUrl !== undefined && !SAFE_URL_RE.test(input.supabaseUrl)) {
    throw new Error(
      `supabaseUrl ${JSON.stringify(input.supabaseUrl)} contains characters not allowed in a launchd setenv value`,
    );
  }
}

// Assemble the `; `-joined `launchctl setenv` command. PGSODIUM_ROOT_KEY is
// always set; every other var is emitted only when its value is present.
function buildSetenvCommand(input: PlistInput): string {
  return [
    // Quote the path inside `cat` so a space-containing keyFilePath (allowed by
    // SAFE_PATH_RE) doesn't word-split and leave PGSODIUM_ROOT_KEY empty. The
    // regex rejects `"`/`$`/backticks, so the inner quotes can't be broken out
    // of — this is word-split safety, not new injection surface. (#36)
    `launchctl setenv PGSODIUM_ROOT_KEY "$(cat "${input.keyFilePath}")"`,
    ...(input.tunnelToken !== undefined
      ? [`launchctl setenv TUNNEL_TOKEN "${input.tunnelToken}"`]
      : []),
    ...(input.postgresPassword !== undefined
      ? [`launchctl setenv POSTGRES_PASSWORD "${input.postgresPassword}"`]
      : []),
    ...(input.jwtSecret !== undefined ? [`launchctl setenv JWT_SECRET "${input.jwtSecret}"`] : []),
    ...(input.supabaseAnonKey !== undefined
      ? [`launchctl setenv SUPABASE_ANON_KEY "${input.supabaseAnonKey}"`]
      : []),
    ...(input.supabaseServiceRoleKey !== undefined
      ? [`launchctl setenv SUPABASE_SERVICE_ROLE_KEY "${input.supabaseServiceRoleKey}"`]
      : []),
    ...(input.dashboardPassword !== undefined
      ? [`launchctl setenv DASHBOARD_PASSWORD "${input.dashboardPassword}"`]
      : []),
    ...(input.gatewayHmacSecret !== undefined
      ? [`launchctl setenv GATEWAY_HMAC_SECRET "${input.gatewayHmacSecret}"`]
      : []),
    ...(input.grafanaAdminPassword !== undefined
      ? [`launchctl setenv GRAFANA_ADMIN_PASSWORD "${input.grafanaAdminPassword}"`]
      : []),
    ...(input.supabaseUrl !== undefined
      ? [`launchctl setenv SUPABASE_URL "${input.supabaseUrl}"`]
      : []),
  ].join('; ');
}

/** Write the plist file to disk at mode 0600. */
export async function writeLaunchAgentPlist(
  plistFile: string,
  content: string,
): Promise<WriteResult> {
  try {
    await mkdir(dirname(plistFile), { recursive: true });
    await writeFile(plistFile, content, { mode: 0o600 });
    await chmod(plistFile, 0o600);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `writing ${plistFile} failed: ${(err as Error).message}` };
  }
}

/**
 * Load (or reload) the agent via `launchctl load`. Unload first to handle
 * re-runs; ignore errors on unload since it could just not be loaded yet.
 */
export async function loadLaunchAgent(plistFile: string): Promise<WriteResult> {
  await safeExeca('launchctl', ['unload', plistFile]); // ignore errors
  const load = await safeExeca('launchctl', ['load', plistFile]);
  if (load === null) {
    return { ok: false, reason: '`launchctl` not on PATH' };
  }
  if (load.exitCode !== 0) {
    return {
      ok: false,
      reason: `launchctl load failed (${load.exitCode ?? 'signal'}): ${load.stderr || load.stdout}`,
    };
  }
  return { ok: true };
}

export interface SetupInput {
  pgsodiumKey: string;
  /** Omit for `bootstrap --local-only` flows — the rendered plist will only
   *  set `PGSODIUM_ROOT_KEY`. */
  tunnelToken?: string;
  /** Self-hosted Supabase credentials — generated by `bootstrap` and stored
   *  in Keychain. Each value here gets exported into the launchd session
   *  via the plist's `launchctl setenv` lines. */
  postgresPassword?: string;
  jwtSecret?: string;
  supabaseAnonKey?: string;
  supabaseServiceRoleKey?: string;
  dashboardPassword?: string;
  /** API Gateway HMAC secret — exported as GATEWAY_HMAC_SECRET. */
  gatewayHmacSecret?: string;
  /** Grafana admin password — exported as GRAFANA_ADMIN_PASSWORD. */
  grafanaAdminPassword?: string;
  /** Public-facing Supabase URL. */
  supabaseUrl?: string;
  paths?: LaunchAgentPaths;
}

export interface SetupReport {
  ok: boolean;
  paths: LaunchAgentPaths;
  step?: 'key-file' | 'plist' | 'load';
  reason?: string;
}

/**
 * One-shot: write the key file, render + write the plist, load the agent.
 * Returns a report that names which step failed (if any) for clean operator
 * messaging.
 */
// Map the flat SetupInput onto a PlistInput, carrying only the fields that
// are present (each optional secret is spread in only when defined).
function plistInputFromSetup(input: SetupInput, keyFilePath: string): PlistInput {
  return {
    keyFilePath,
    ...(input.tunnelToken !== undefined ? { tunnelToken: input.tunnelToken } : {}),
    ...(input.postgresPassword !== undefined ? { postgresPassword: input.postgresPassword } : {}),
    ...(input.jwtSecret !== undefined ? { jwtSecret: input.jwtSecret } : {}),
    ...(input.supabaseAnonKey !== undefined ? { supabaseAnonKey: input.supabaseAnonKey } : {}),
    ...(input.supabaseServiceRoleKey !== undefined
      ? { supabaseServiceRoleKey: input.supabaseServiceRoleKey }
      : {}),
    ...(input.dashboardPassword !== undefined ? { dashboardPassword: input.dashboardPassword } : {}),
    ...(input.gatewayHmacSecret !== undefined ? { gatewayHmacSecret: input.gatewayHmacSecret } : {}),
    ...(input.grafanaAdminPassword !== undefined
      ? { grafanaAdminPassword: input.grafanaAdminPassword }
      : {}),
    ...(input.supabaseUrl !== undefined ? { supabaseUrl: input.supabaseUrl } : {}),
  };
}

export async function setupLaunchAgent(input: SetupInput): Promise<SetupReport> {
  const paths = input.paths ?? defaultPaths();

  const keyResult = await writePgsodiumKeyFile(input.pgsodiumKey, paths.keyFile);
  if (!keyResult.ok) {
    return { ok: false, paths, step: 'key-file', ...(keyResult.reason ? { reason: keyResult.reason } : {}) };
  }

  let plistContent: string;
  try {
    plistContent = renderLaunchAgentPlist(plistInputFromSetup(input, paths.keyFile));
  } catch (err) {
    return { ok: false, paths, step: 'plist', reason: (err as Error).message };
  }

  const plistResult = await writeLaunchAgentPlist(paths.plistFile, plistContent);
  if (!plistResult.ok) {
    return { ok: false, paths, step: 'plist', ...(plistResult.reason ? { reason: plistResult.reason } : {}) };
  }

  const loadResult = await loadLaunchAgent(paths.plistFile);
  if (!loadResult.ok) {
    return { ok: false, paths, step: 'load', ...(loadResult.reason ? { reason: loadResult.reason } : {}) };
  }

  return { ok: true, paths };
}

export interface TeardownResult {
  ok: boolean;
  /** Per-step outcome. Each step is independently logged so the operator can
   *  see "unload worked but the plist file was already gone." */
  steps: Array<{ step: 'unload' | 'rm-plist' | 'rm-key-file'; ok: boolean; reason?: string }>;
}

export interface TeardownOptions {
  /** When true, leave the pgsodium key file in place. Useful when the
   *  operator wants to unload the LaunchAgent + remove the plist but
   *  keep the key as belt-and-suspenders backup. */
  keepKeyFile?: boolean;
}

/**
 * Reverse of `setupLaunchAgent`: unload the agent via `launchctl unload`,
 * then `rm -f` both the plist and (unless `keepKeyFile`) the pgsodium key
 * file. Idempotent — `rm -f` is a no-op when the file doesn't exist, and
 * we treat `launchctl unload` of an already-unloaded agent as success.
 *
 * Used by `reset`. Also useful as a test seam during integration tests.
 */
export async function teardownLaunchAgent(
  paths: LaunchAgentPaths,
  opts: TeardownOptions = {},
): Promise<TeardownResult> {
  const steps: TeardownResult['steps'] = [];

  const unload = await safeExeca('launchctl', ['unload', paths.plistFile]);
  // `launchctl unload` exits non-zero when the agent isn't loaded — that's a
  // successful teardown from our point of view, so a non-zero exit is fine.
  // But a null result means `launchctl` isn't on PATH: nothing was unloaded,
  // so report ok:false rather than a clean teardown that didn't happen. (#36)
  steps.push({
    step: 'unload',
    ok: unload !== null,
    ...(unload === null ? { reason: '`launchctl` not on PATH' } : {}),
  });

  try {
    await rm(paths.plistFile, { force: true });
    steps.push({ step: 'rm-plist', ok: true });
  } catch (err) {
    steps.push({ step: 'rm-plist', ok: false, reason: (err as Error).message });
  }

  if (!opts.keepKeyFile) {
    try {
      await rm(paths.keyFile, { force: true });
      steps.push({ step: 'rm-key-file', ok: true });
    } catch (err) {
      steps.push({ step: 'rm-key-file', ok: false, reason: (err as Error).message });
    }
  }

  return { ok: steps.every((s) => s.ok), steps };
}
