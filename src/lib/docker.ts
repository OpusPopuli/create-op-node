/**
 * Docker compose + ghcr.io login orchestration.
 *
 * Three concerns this lib covers:
 *
 *   1. Authenticate Docker to ghcr.io using the operator's `gh auth token`,
 *      piped on stdin so the token never lands in argv.
 *   2. `docker compose pull / up -d` against the prod compose set in the
 *      operator's node repo checkout.
 *   3. Poll `docker compose ps --format json` until every service reports
 *      `(healthy)`, with the same two-phase-budget pattern as lib/polling.ts
 *      (containers can take a while to start showing up; healthy check then
 *      runs on its own clock).
 */

import { safeExeca } from './exec.js';

/** Default registry. Constant so tests + the bootstrap command read the same
 *  value and an op-region migration to a different registry only changes
 *  one place. */
export const GHCR_REGISTRY = 'ghcr.io';

export interface LoginResult {
  ok: boolean;
  reason?: string;
}

/**
 * Authenticate Docker to ghcr.io. Pulls the token from `gh auth token`,
 * pipes it on stdin to `docker login --password-stdin`. The username comes
 * from `gh api user --jq .login`. Three execa calls; failure at any point
 * reports cleanly with the responsible step.
 */
export async function loginToGhcr(): Promise<LoginResult> {
  const tokenRes = await safeExeca('gh', ['auth', 'token']);
  if (tokenRes === null) return { ok: false, reason: '`gh` not installed' };
  if (tokenRes.exitCode !== 0) {
    return {
      ok: false,
      reason: `gh auth token failed (${tokenRes.exitCode ?? 'signal'}): ${tokenRes.stderr || tokenRes.stdout}`,
    };
  }
  const token = tokenRes.stdout.trim();
  if (token.length === 0) {
    return { ok: false, reason: 'gh auth token returned empty — run `gh auth login` first' };
  }

  const userRes = await safeExeca('gh', ['api', 'user', '--jq', '.login']);
  if (userRes === null || userRes.exitCode !== 0) {
    return {
      ok: false,
      reason: `couldn't resolve GitHub user via gh api: ${userRes?.stderr || userRes?.stdout || 'gh missing'}`,
    };
  }
  const user = userRes.stdout.trim();
  if (user.length === 0) {
    return { ok: false, reason: 'gh api user returned empty — gh not signed in' };
  }

  const loginRes = await safeExeca(
    'docker',
    ['login', GHCR_REGISTRY, '-u', user, '--password-stdin'],
    { input: token },
  );
  if (loginRes === null) return { ok: false, reason: '`docker` not installed' };
  if (loginRes.exitCode !== 0) {
    return {
      ok: false,
      reason: `docker login ${GHCR_REGISTRY} failed (${loginRes.exitCode ?? 'signal'}): ${loginRes.stderr || loginRes.stdout}`,
    };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Compose pull / up
// ----------------------------------------------------------------------------

export interface ComposeOptions {
  /** Compose file paths, in order. Becomes `-f X -f Y …` on the command line. */
  files: string[];
  /** Working directory the compose command runs from. */
  cwd: string;
  /** Optional env-file flag, in the same convention as `--env-file`. */
  envFile?: string;
  /** Compose profiles to activate. Repeats as `--profile X --profile Y`. The
   *  template's `cloudflared` service is gated behind the `public` profile;
   *  bootstrap in local-only mode passes an empty array so cloudflared
   *  stays down. */
  profiles?: ReadonlyArray<string>;
  /** Extra env vars passed to the docker compose subprocess. Used by
   *  bootstrap to hydrate Keychain-loaded secrets (POSTGRES_PASSWORD,
   *  JWT_SECRET, the Supabase JWTs, etc.) at compose-invocation time
   *  without writing them to a plaintext `.env` file on disk. Per the
   *  vault-first principle (#811), the wrapper script (`bin/op-compose`)
   *  is the operator-facing version of the same pattern. */
  env?: NodeJS.ProcessEnv;
}

function composeArgs(opts: ComposeOptions, sub: string[]): string[] {
  const files = opts.files.flatMap((f) => ['-f', f]);
  const env = opts.envFile ? ['--env-file', opts.envFile] : [];
  const profiles = (opts.profiles ?? []).flatMap((pr) => ['--profile', pr]);
  return ['compose', ...files, ...env, ...profiles, ...sub];
}

export interface ComposeResult {
  ok: boolean;
  reason?: string;
}

/** Build the execa options object once — both env and cwd flow from
 *  ComposeOptions to safeExeca so subprocess hydration works uniformly. */
function execOpts(opts: ComposeOptions): { cwd: string; env?: NodeJS.ProcessEnv } {
  return opts.env ? { cwd: opts.cwd, env: opts.env } : { cwd: opts.cwd };
}

/** `docker compose -f … pull`. Idempotent on first run; pulls new image tags. */
export async function composePull(opts: ComposeOptions): Promise<ComposeResult> {
  const res = await safeExeca('docker', composeArgs(opts, ['pull']), execOpts(opts));
  return result(res, 'compose pull');
}

/** Registry prefix for images published + cosign-signed by the opuspopuli
 *  release workflow. Only these are verifiable against the release identity;
 *  third-party images (postgres, kong, gotrue, ollama, …) are unsigned by us. */
export const OPUSPOPULI_IMAGE_PREFIX = 'ghcr.io/opuspopuli/';

/**
 * `docker compose … config --images` — the resolved image refs the stack will
 * pull, one per line. Returns `null` when the command can't run (docker
 * missing) or config fails (e.g. a required `${VAR:?}` interpolation is unset),
 * so the caller can treat "couldn't enumerate" distinctly from "no images".
 */
export async function composeConfigImages(opts: ComposeOptions): Promise<string[] | null> {
  const res = await safeExeca('docker', composeArgs(opts, ['config', '--images']), execOpts(opts));
  if (res === null || res.exitCode !== 0) return null;
  return res.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Keep only the images the opuspopuli release workflow signs — the subset
 *  cosign can verify against the release identity. Third-party base images are
 *  dropped (they'd fail verification against our identity). Pure helper. */
export function filterVerifiableImages(
  images: string[],
  prefix: string = OPUSPOPULI_IMAGE_PREFIX,
): string[] {
  return images.filter((img) => img.startsWith(prefix));
}

/** `docker compose -f … up -d --remove-orphans`. */
export async function composeUp(opts: ComposeOptions): Promise<ComposeResult> {
  const res = await safeExeca('docker', composeArgs(opts, ['up', '-d', '--remove-orphans']), execOpts(opts));
  return result(res, 'compose up');
}

/**
 * `docker compose -f … rm -sfv <service>`. Stops + removes a single service +
 * its anonymous volumes. Used by `bootstrap --local-only` to evict a
 * cloudflared container left over from a prior public bootstrap; otherwise it
 * lingers in `compose ps` and the health-check loop demands it reach healthy.
 *
 * Returns ok=true when the service doesn't exist (compose treats "rm a
 * service that isn't there" as a no-op exit 0), so callers can call this
 * unconditionally.
 */
export async function composeRemoveService(
  opts: ComposeOptions,
  service: string,
): Promise<ComposeResult> {
  const res = await safeExeca('docker', composeArgs(opts, ['rm', '-sfv', service]), execOpts(opts));
  return result(res, `compose rm ${service}`);
}

export interface ComposeDownOptions extends ComposeOptions {
  /** When true, adds `-v` — destroys named volumes. The default false is the
   *  safe choice: stop the stack but preserve the database. Callers must
   *  ALWAYS surface a typed confirmation before flipping this on. */
  wipeVolumes?: boolean;
  /** When true, adds `--remove-orphans` — drops containers from compose files
   *  no longer present. Useful on first-after-rename runs. */
  removeOrphans?: boolean;
  /** When set, adds `--rmi <mode>` to also remove the images.
   *   - `'all'`: removes all images referenced by services (forces re-pull
   *              on next `compose up`).
   *   - `'local'`: removes only images that don't have a custom tag (i.e.,
   *                locally-built ones; pulled images stay).
   *  Use 'all' for true "wipe everything and start over" iteration loops. */
  removeImages?: 'all' | 'local';
}

/** `docker compose -f … down [-v] [--remove-orphans] [--rmi MODE]`. */
export async function composeDown(opts: ComposeDownOptions): Promise<ComposeResult> {
  const flags: string[] = ['down'];
  if (opts.wipeVolumes) flags.push('-v');
  if (opts.removeOrphans) flags.push('--remove-orphans');
  if (opts.removeImages) flags.push('--rmi', opts.removeImages);
  const label = [
    'compose down',
    opts.wipeVolumes ? '-v' : '',
    opts.removeImages ? `--rmi ${opts.removeImages}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const res = await safeExeca('docker', composeArgs(opts, flags), execOpts(opts));
  return result(res, label);
}

/**
 * `docker logout <registry>`.
 *
 * Behavior on "not currently logged in" varies by version: Docker 24+ returns
 * exit 0 with "Not logged in to <registry>" on stdout, but older Docker
 * Desktop releases (and some credential-helper configurations) return a
 * non-zero exit instead. `reset` therefore renders a non-zero outcome as a
 * warning rather than a failure — the goal is "ensure no creds remain," and
 * "no creds existed to begin with" satisfies that goal.
 *
 * Note: this only clears the credential-store entry. If the operator's
 * credential helper has cached the token elsewhere, or if `~/.docker/config.json`
 * has stale entries from a different host, those need separate cleanup.
 */
export async function dockerLogout(registry: string = GHCR_REGISTRY): Promise<ComposeResult> {
  const res = await safeExeca('docker', ['logout', registry]);
  return result(res, `docker logout ${registry}`);
}

function result(
  res: { exitCode: number | undefined; stdout: string; stderr: string } | null,
  label: string,
): ComposeResult {
  if (res === null) return { ok: false, reason: '`docker` not installed' };
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason: `${label} failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true };
}

// ----------------------------------------------------------------------------
// Compose ps — for the health check loop
// ----------------------------------------------------------------------------

export interface ContainerSnapshot {
  name: string;
  /** `running`, `exited`, etc. — the Docker container state. */
  state: string;
  /** `healthy`, `unhealthy`, `starting`, or `none` (no healthcheck defined). */
  health: 'healthy' | 'unhealthy' | 'starting' | 'none';
  exitCode: number | null;
}

/**
 * Parse `docker compose ps --format json` output. Compose v2 emits one JSON
 * object per line for each container. We tolerate either format (NDJSON or
 * a single-line JSON array, depending on version).
 */
export function parseComposePs(stdout: string): ContainerSnapshot[] {
  // First try NDJSON line-by-line.
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];

  const lines = trimmed.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const out: ContainerSnapshot[] = [];

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) out.push(normalize(item));
      } else {
        out.push(normalize(parsed));
      }
    } catch {
      // Skip non-JSON lines (compose sometimes emits warnings on stdout).
    }
  }
  return out;
}

function normalize(raw: unknown): ContainerSnapshot {
  const r = (raw ?? {}) as Record<string, unknown>;
  const name = (r['Name'] as string) ?? (r['Service'] as string) ?? '<unknown>';
  const state = ((r['State'] as string) ?? 'unknown').toLowerCase();
  const healthRaw = ((r['Health'] as string) ?? '').toLowerCase();
  const health: ContainerSnapshot['health'] =
    healthRaw === 'healthy' || healthRaw === 'unhealthy' || healthRaw === 'starting'
      ? healthRaw
      : 'none';
  const exitCodeRaw = r['ExitCode'];
  const exitCode = typeof exitCodeRaw === 'number' ? exitCodeRaw : null;
  return { name, state, health, exitCode };
}

/**
 * `docker compose ps --format json`. Returns:
 *
 *   - `null` when the call itself failed (docker missing, compose file wrong,
 *     non-zero exit). The caller can distinguish a real failure from a
 *     stack-not-up-yet case.
 *   - `[]` when the call succeeded but no containers are listed yet (compose
 *     up still in flight).
 *   - `ContainerSnapshot[]` populated on success.
 */
export async function composePs(opts: ComposeOptions): Promise<ContainerSnapshot[] | null> {
  const res = await safeExeca('docker', composeArgs(opts, ['ps', '--format', 'json']), execOpts(opts));
  if (res === null || res.exitCode !== 0) return null;
  return parseComposePs(res.stdout);
}

// ----------------------------------------------------------------------------
// Health-check loop
// ----------------------------------------------------------------------------

export interface WaitForHealthyOptions {
  /** Container names that MUST be healthy before we return success. Empty
   *  array means "every container compose ps reports must be healthy or no-op
   *  (i.e. state=exited with code 0 — db-migrate-style one-shots)." */
  requireHealthy?: string[];
  /** Max time to wait, ms. Default 5 minutes. */
  timeoutMs?: number;
  /** Poll interval, ms. Default 5s. */
  pollMs?: number;
  /** Optional progress callback. */
  onPoll?: (snapshots: ContainerSnapshot[]) => void;
}

export type HealthOutcome =
  | { kind: 'healthy'; snapshots: ContainerSnapshot[] }
  | { kind: 'unhealthy'; snapshots: ContainerSnapshot[]; problem: string }
  | { kind: 'timeout'; snapshots: ContainerSnapshot[] };

export interface WaitForHealthyDeps {
  ps: (opts: ComposeOptions) => Promise<ContainerSnapshot[] | null>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const realWaitDeps: WaitForHealthyDeps = {
  ps: composePs,
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => Date.now(),
};

/**
 * Poll `compose ps` until either every container reaches a happy terminal
 * state or the timeout fires. A "happy" state is:
 *
 *   - `state=running` AND `health` ∈ {healthy, none}
 *   - `state=exited` AND `exitCode === 0` (one-shot containers like db-migrate)
 *
 * `state=running` + `health=starting` keeps polling; `health=unhealthy` or
 * `state=exited` with non-zero exit returns immediately as `unhealthy`.
 */
// Map a single non-empty poll result to a terminal HealthOutcome, or null
// when the caller should keep polling ('pending' or no containers yet).
function terminalOutcome(
  ps: ContainerSnapshot[],
  requireHealthy?: string[],
): HealthOutcome | null {
  if (ps.length === 0) return null;
  const verdict = assessHealth(ps, requireHealthy);
  if (verdict.kind === 'healthy') return { kind: 'healthy', snapshots: ps };
  if (verdict.kind === 'unhealthy') {
    return { kind: 'unhealthy', snapshots: ps, problem: verdict.problem ?? 'unhealthy' };
  }
  return null;
}

export async function waitForHealthy(
  composeOpts: ComposeOptions,
  options: WaitForHealthyOptions = {},
  deps: WaitForHealthyDeps = realWaitDeps,
): Promise<HealthOutcome> {
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const basePollMs = options.pollMs ?? 5 * 1000;
  const start = deps.now();
  let last: ContainerSnapshot[] = [];
  let pollCount = 0;

  while (deps.now() - start < timeoutMs) {
    pollCount++;
    const ps = await deps.ps(composeOpts);
    if (ps !== null) {
      last = ps;
      options.onPoll?.(ps);
      // A terminal verdict (healthy / unhealthy) returns immediately;
      // 'pending' (null here) falls through to the sleep + next iteration.
      const outcome = terminalOutcome(ps, options.requireHealthy);
      if (outcome) return outcome;
    }
    // Gentle backoff: 1× the base poll for the first 3 polls (fast feedback
    // while containers are settling), 2× after that. Caps wasted subprocess
    // startup on long timeouts without slowing down the typical case.
    const interval = pollCount < 3 ? basePollMs : basePollMs * 2;
    await deps.sleep(interval);
  }
  return { kind: 'timeout', snapshots: last };
}

interface AssessVerdict {
  kind: 'healthy' | 'unhealthy' | 'pending';
  problem?: string;
}

export function assessHealth(
  snapshots: ContainerSnapshot[],
  requireHealthy?: string[],
): AssessVerdict {
  // Hard failures short-circuit regardless of the required-list mode.
  const hard = firstHardFailure(snapshots);
  if (hard) return hard;

  const required = requireHealthy ?? [];
  return required.length > 0
    ? assessRequired(snapshots, required)
    : assessAllRunning(snapshots);
}

// Hard failure conditions: any unhealthy, any exited-with-non-zero.
function firstHardFailure(snapshots: ContainerSnapshot[]): AssessVerdict | null {
  for (const s of snapshots) {
    if (s.health === 'unhealthy') {
      return { kind: 'unhealthy', problem: `${s.name} reports unhealthy` };
    }
    if (s.state === 'exited' && (s.exitCode ?? 0) !== 0) {
      return { kind: 'unhealthy', problem: `${s.name} exited with code ${s.exitCode}` };
    }
  }
  return null;
}

// The caller specified a required-healthy list — gate on exactly those.
function assessRequired(snapshots: ContainerSnapshot[], required: string[]): AssessVerdict {
  const byName = new Map(snapshots.map((s) => [s.name, s]));
  for (const name of required) {
    const s = byName.get(name);
    if (!s) return { kind: 'pending' };
    if (s.state === 'exited' && s.exitCode === 0) continue;
    if (s.state !== 'running') return { kind: 'pending' };
    if (s.health === 'starting') return { kind: 'pending' };
    if (s.health === 'unhealthy') {
      return { kind: 'unhealthy', problem: `${s.name} reports unhealthy` };
    }
  }
  return { kind: 'healthy' };
}

// No required list — all snapshots must be in a happy state.
function assessAllRunning(snapshots: ContainerSnapshot[]): AssessVerdict {
  for (const s of snapshots) {
    if (s.state === 'exited' && s.exitCode === 0) continue;
    if (s.state !== 'running') return { kind: 'pending' };
    if (s.health === 'starting') return { kind: 'pending' };
  }
  return { kind: 'healthy' };
}
