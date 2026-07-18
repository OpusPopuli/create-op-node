import { readFileSync } from 'node:fs';

import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import { tunnelStatus, type TunnelStatusInput, type TunnelStatusResult } from '../lib/cloudflare.js';
import { cosignVerifyImage, type CosignVerifyInput, type CosignVerifyResult } from '../lib/cosign.js';
import { graphqlProbe, httpProbe, type GraphqlProbeInput, type GraphqlProbeResult, type HttpProbeInput, type HttpProbeResult } from '../lib/http.js';
import { unwrap } from '../lib/prompts.js';
import { tlsHandshake, type TlsProbeInput, type TlsHandshakeResult } from '../lib/tls.js';
import { checkOllamaHealth, modelPresent, type EmbeddingsProvider, type OllamaHealth } from '../lib/ollama.js';
import { readEnvModelConfig, type NodeEnvModelConfig } from '../lib/env-file.js';
import { looksLikeNodeRepo } from '../lib/noderepo.js';

interface VerifyOptions {
  domain?: string;
  apiHost?: string;
  cfToken?: string;
  cfTokenFile?: string;
  cfAccountId?: string;
  tunnelId?: string;
  image?: string[];
  certWarnDays?: string;
  showSkipped?: boolean;
  llmModel?: string;
  embeddingModel?: string;
  embeddingsProvider?: EmbeddingsProvider;
  repoDir?: string;
  localOnly?: boolean;
}

const DOMAIN_RE = /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/i;

export interface VerifyPhase {
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'fail' | 'skipped';
  readonly detail: string;
}

export interface VerifyReport {
  readonly phases: ReadonlyArray<VerifyPhase>;
}

export function summarize(report: VerifyReport): { ok: boolean; failed: number; warned: number } {
  let failed = 0;
  let warned = 0;
  for (const ph of report.phases) {
    if (ph.status === 'fail') failed++;
    if (ph.status === 'warn') warned++;
  }
  return { ok: failed === 0, failed, warned };
}

function formatExpiry(days: number): string {
  if (days < 0) return `expired ${-days}d ago`;
  if (days === 0) return 'expires today';
  return `${days}d to expiry`;
}

/* ------------------------------------------------------------------ *
 *  Injectable orchestration (review S3)                              *
 * ------------------------------------------------------------------ */

export interface VerifyDeps {
  tls: (input: TlsProbeInput) => Promise<TlsHandshakeResult>;
  http: (input: HttpProbeInput) => Promise<HttpProbeResult>;
  graphql: (input: GraphqlProbeInput) => Promise<GraphqlProbeResult>;
  tunnel: (input: TunnelStatusInput) => Promise<TunnelStatusResult>;
  cosign: (input: CosignVerifyInput) => Promise<CosignVerifyResult>;
  /** Local Ollama health probe (`/api/tags`). Defaults to checkOllamaHealth
   *  against localhost — meaningful only when verify runs ON the node. */
  ollama: (url?: string) => Promise<OllamaHealth>;
  /** Called once per phase as it resolves — lets the CLI render spinners.
   *  Pass a no-op for tests that just want the report. */
  onPhase?: (phase: VerifyPhase) => void;
}

export interface VerifyInput {
  apiHost: string;
  certWarnDays: number;
  /** All three OR none. Mid-set is treated as a `warn` phase by runVerify. */
  cf?: {
    token?: string;
    accountId?: string;
    tunnelId?: string;
  };
  images: ReadonlyArray<string>;
  /** Configured model(s) to assert are present in the LOCAL Ollama. Resolved
   *  from `--llm-model` or the node `.env` (readEnvModelConfig). Absent →
   *  the Ollama phase is skipped (preserves off-LAN "run from anywhere"). */
  ollama?: {
    llmModel: string;
    embeddingModel?: string;
    provider?: EmbeddingsProvider;
  };
  /** Node has no public domain/tunnel (bootstrap --local-only). Skips the
   *  domain-dependent probes (TLS, /health, GraphQL, Cloudflare) as `skipped`
   *  rather than failing them, leaving the node-local checks (Ollama, cosign)
   *  to decide the outcome. See #104. */
  localOnly?: boolean;
  /** SUPABASE_URL read from the node `.env` managed block. Absent → the check
   *  is skipped (verify not run on the node). A non-local node still pinned to
   *  `http://localhost:8000` warns — browser-facing auth URLs would be wrong
   *  (opuspopuli-node#43). */
  supabaseUrl?: string;
}

const DEFAULT_DEPS: VerifyDeps = {
  tls: tlsHandshake,
  http: httpProbe,
  graphql: graphqlProbe,
  tunnel: tunnelStatus,
  cosign: cosignVerifyImage,
  ollama: checkOllamaHealth,
};

type PushVerifyPhase = (ph: VerifyPhase) => void;

export async function runVerify(input: VerifyInput, deps: VerifyDeps = DEFAULT_DEPS): Promise<VerifyReport> {
  // Each phase pushes its result(s) via push(), which records + fires onPhase
  // in lockstep. push is threaded into the phase helpers (rather than having
  // them return arrays) so the cosign loop keeps firing onPhase per-image,
  // interleaved with its async calls — exactly as the original inline loop.
  const phases: VerifyPhase[] = [];
  const push: PushVerifyPhase = (ph) => {
    phases.push(ph);
    deps.onPhase?.(ph);
  };

  await verifyTlsPhase(input, deps, push);
  await verifyHealthPhase(input, deps, push);
  await verifyGraphqlPhase(input, deps, push);
  await verifyOllamaModelsPhase(input, deps, push);
  verifySupabaseUrlPhase(input, push);
  await verifyCloudflarePhase(input, deps, push);
  await verifyCosignPhase(input, deps, push);

  return { phases };
}

// Record a domain-dependent phase as `skipped` on a --local-only node (no
// public endpoint / tunnel to reach), preserving phase ordering + counts so a
// healthy local node exits 0 instead of failing inapplicable probes. See #104.
function skipLocalOnly(name: string, detail: string, push: PushVerifyPhase): void {
  push({ name, status: 'skipped', detail });
}

const LOCAL_ONLY_NO_ENDPOINT = 'local-only node — no public endpoint to probe';

// ---- Phase 1: TLS handshake ---------------------------------------
async function verifyTlsPhase(input: VerifyInput, deps: VerifyDeps, push: PushVerifyPhase): Promise<void> {
  if (input.localOnly) return skipLocalOnly('TLS handshake', LOCAL_ONLY_NO_ENDPOINT, push);
  const tls = await deps.tls({ host: input.apiHost });
  if (!tls.ok) {
    push({ name: 'TLS handshake', status: 'fail', detail: tls.reason });
    return;
  }
  const line = `subject=${tls.subject}, issuer=${tls.issuer}, ${formatExpiry(tls.daysToExpiry)}`;
  if (tls.daysToExpiry < input.certWarnDays) {
    push({
      name: 'TLS handshake',
      status: 'warn',
      detail: tls.daysToExpiry < 0 ? line : `${line} (< warn threshold ${input.certWarnDays}d)`,
    });
    return;
  }
  push({ name: 'TLS handshake', status: 'ok', detail: line });
}

// ---- Phase 2: GET /health ------------------------------------------
async function verifyHealthPhase(input: VerifyInput, deps: VerifyDeps, push: PushVerifyPhase): Promise<void> {
  if (input.localOnly) return skipLocalOnly('GET /health', LOCAL_ONLY_NO_ENDPOINT, push);
  const health = await deps.http({ url: `https://${input.apiHost}/health` });
  if (health.ok) {
    push({ name: 'GET /health', status: 'ok', detail: `HTTP ${health.status}` });
  } else {
    push({ name: 'GET /health', status: 'fail', detail: health.reason });
  }
}

// ---- Phase 3: GraphQL { __typename } -------------------------------
async function verifyGraphqlPhase(input: VerifyInput, deps: VerifyDeps, push: PushVerifyPhase): Promise<void> {
  if (input.localOnly) return skipLocalOnly('GraphQL { __typename }', LOCAL_ONLY_NO_ENDPOINT, push);
  const gql = await deps.graphql({ url: `https://${input.apiHost}/api` });
  if (gql.ok) {
    push({ name: 'GraphQL { __typename }', status: 'ok', detail: `typename=${gql.typename}` });
  } else {
    push({ name: 'GraphQL { __typename }', status: 'fail', detail: gql.reason });
  }
}

// ---- Phase 4: Ollama model presence (optional, node-local) ---------
//
// Catches the config↔runtime drift that silently 404s at inference time: the
// configured LLM_MODEL naming a model that was never pulled into the host
// Ollama. Probes the LOCAL daemon, so it's meaningful only when verify runs
// ON the node — hence skipped (not failed) when no model was resolved, which
// keeps an off-LAN `verify --domain …` from tripping it.
async function verifyOllamaModelsPhase(input: VerifyInput, deps: VerifyDeps, push: PushVerifyPhase): Promise<void> {
  const cfg = input.ollama;
  if (!cfg?.llmModel) {
    push({
      name: 'Ollama models',
      status: 'skipped',
      detail: 'pass --llm-model (or run on the node so its .env is read) to enable',
    });
    return;
  }

  const health = await deps.ollama();
  if (!health.reachable) {
    push({
      name: 'Ollama models',
      status: 'fail',
      detail:
        'configured model set but the local Ollama daemon is unreachable on :11434 — ' +
        'start it with `brew services start ollama` (run this check on the node)',
    });
    return;
  }

  // Assert the LLM always; assert the embedding model only when the knowledge
  // service actually uses the Ollama provider for it (xenova is in-process).
  const required = [cfg.llmModel];
  if (cfg.provider === 'ollama' && cfg.embeddingModel) required.push(cfg.embeddingModel);

  const missing = required.filter((m) => !modelPresent(m, health.models));
  if (missing.length > 0) {
    const remedy = missing.map((m) => `ollama pull ${m}`).join(' && ');
    push({
      name: 'Ollama models',
      status: 'fail',
      detail: `not installed: ${missing.join(', ')} — remedy: ${remedy}`,
    });
    return;
  }
  push({ name: 'Ollama models', status: 'ok', detail: `${required.join(', ')} present` });
}

// ---- Phase 4b: SUPABASE_URL sanity (node-local, optional) ---------
//
// The browser-facing auth URLs (API_EXTERNAL_URL, GOTRUE_JWT_ISSUER,
// SUPABASE_PUBLIC_URL) all derive from SUPABASE_URL. A non-local node left at
// the `http://localhost:8000` default silently ships magic-link / callback
// URLs pointing at localhost. Skipped off-node (no .env to read) and on
// --local-only nodes (localhost is correct there). See opuspopuli-node#43.
function verifySupabaseUrlPhase(input: VerifyInput, push: PushVerifyPhase): void {
  if (input.localOnly) {
    return skipLocalOnly('SUPABASE_URL', 'local-only node — localhost:8000 is expected', push);
  }
  if (input.supabaseUrl === undefined) {
    push({
      name: 'SUPABASE_URL',
      status: 'skipped',
      detail: 'run on the node (or pass --repo-dir) so its .env is read',
    });
    return;
  }
  if (input.supabaseUrl === 'http://localhost:8000') {
    push({
      name: 'SUPABASE_URL',
      status: 'warn',
      detail:
        'still http://localhost:8000 on a non-local node — browser-facing auth URLs ' +
        'will point at localhost; set SUPABASE_URL in the node .env to the public URL',
    });
    return;
  }
  push({ name: 'SUPABASE_URL', status: 'ok', detail: input.supabaseUrl });
}

// ---- Phase 5: Cloudflare Tunnel status (optional) ------------------
async function verifyCloudflarePhase(input: VerifyInput, deps: VerifyDeps, push: PushVerifyPhase): Promise<void> {
  if (input.localOnly) return skipLocalOnly('Cloudflare Tunnel', 'local-only node — no tunnel', push);
  const cfFields: ReadonlyArray<[string, string | undefined]> = [
    ['--cf-token', input.cf?.token],
    ['--cf-account-id', input.cf?.accountId],
    ['--tunnel-id', input.cf?.tunnelId],
  ];
  const cfSet = cfFields.filter(([, v]) => v !== undefined && v !== '');
  if (cfSet.length === 0) {
    push({
      name: 'Cloudflare Tunnel',
      status: 'skipped',
      detail: 'pass --cf-token + --cf-account-id + --tunnel-id to enable',
    });
    return;
  }
  if (cfSet.length < cfFields.length) {
    // (review S1) Partial config is operator-hostile — they almost certainly
    // meant to enable the check. Warn so the missing flag names are visible.
    const missing = cfFields.filter(([, v]) => v === undefined || v === '').map(([name]) => name).join(', ');
    push({
      name: 'Cloudflare Tunnel',
      status: 'warn',
      detail: `partial CF config — missing ${missing}; check skipped`,
    });
    return;
  }
  const tun = await deps.tunnel({
    token: input.cf!.token!,
    accountId: input.cf!.accountId!,
    tunnelId: input.cf!.tunnelId!,
  });
  if (!tun.ok) {
    push({ name: 'Cloudflare Tunnel', status: 'fail', detail: tun.reason });
  } else if (tun.connections === 0) {
    push({
      name: 'Cloudflare Tunnel',
      status: 'warn',
      detail: `status=${tun.status}, 0 connections — cloudflared on the Studio appears offline`,
    });
  } else {
    push({
      name: 'Cloudflare Tunnel',
      status: 'ok',
      detail: `${tun.connections} connections, status=${tun.status}`,
    });
  }
}

// ---- Phase 6: cosign signature check (optional) --------------------
async function verifyCosignPhase(input: VerifyInput, deps: VerifyDeps, push: PushVerifyPhase): Promise<void> {
  if (input.images.length === 0) {
    push({
      name: 'cosign verify',
      status: 'skipped',
      detail: 'pass --image <ref> (repeatable) to enable',
    });
    return;
  }
  for (const image of input.images) {
    const cos = await deps.cosign({ image });
    if (cos.ok) {
      push({ name: `cosign verify ${image}`, status: 'ok', detail: 'signature valid' });
    } else if (cos.skipped) {
      push({ name: `cosign verify ${image}`, status: 'skipped', detail: cos.reason });
    } else {
      push({ name: `cosign verify ${image}`, status: 'fail', detail: cos.reason });
    }
  }
}

/* ------------------------------------------------------------------ *
 *  CLI wrapper                                                       *
 * ------------------------------------------------------------------ */

function readTokenFile(path: string): string {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error(`--cf-token-file ${path} was empty`);
  return raw;
}

/**
 * Commander array collector for the repeatable `--image` option. Without an
 * argParser, commander stores only the last value as a plain string, which the
 * cosign phase then iterates character-by-character (verifying "g", "h", "c", …
 * as image refs). Mirrors `collectComposeFile` (#82). See #103.
 */
export function collectImage(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

export const verifyCommand = new Command('verify')
  .description(
    'Off-LAN health probe of a live node — TLS, Apollo Federation reachability, GraphQL smoke. ' +
      'Run from anywhere with internet access.',
  )
  .addOption(
    new Option('--domain <domain>', 'Domain to probe (e.g. example.org → checks api.example.org)'),
  )
  .addOption(new Option('--api-host <host>', 'Override the API hostname (default: api.<domain>)'))
  .addOption(new Option('--cf-token <token>', 'Cloudflare API token (enables tunnel-status probe)'))
  .addOption(
    new Option('--cf-token-file <path>', 'Read CF token from a file (avoids exposing it via ps)'),
  )
  .addOption(new Option('--cf-account-id <id>', 'Cloudflare account ID (required with --cf-token)'))
  .addOption(
    new Option('--tunnel-id <id>', 'Cloudflare Tunnel ID to query (required with --cf-token)'),
  )
  .addOption(
    new Option('--image <ref>', 'Repeatable. Image to cosign-verify (e.g. ghcr.io/opuspopuli/api:tag)')
      .default([] as string[])
      .argParser(collectImage),
  )
  .addOption(
    new Option('--cert-warn-days <n>', 'Warn if cert expires within N days').default('14'),
  )
  .addOption(
    new Option(
      '--llm-model <model>',
      'Assert this model is present in the local Ollama (catches config↔runtime drift). Defaults to LLM_MODEL from the node .env when run on the node.',
    ),
  )
  .addOption(
    new Option('--embedding-model <model>', 'Also assert this embedding model is present (only checked when --embeddings-provider=ollama).'),
  )
  .addOption(
    new Option('--embeddings-provider <provider>', 'Embeddings provider the node runs; the embedding model is only asserted for `ollama`.').choices(['xenova', 'ollama']),
  )
  .addOption(
    new Option('--repo-dir <path>', "Node repo dir whose .env supplies the model config when --llm-model is omitted (default: cwd)."),
  )
  .addOption(
    new Option(
      '--local-only',
      'Node has no public domain/tunnel — skip the TLS/health/GraphQL/tunnel probes (no domain prompt) and run only the node-local checks (Ollama model presence, cosign).',
    ).default(false),
  )
  .addOption(
    new Option('--show-skipped', 'Include skipped phases in the summary').default(false),
  )
  .action(async (opts: VerifyOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node verify ')));

    const localOnly = opts.localOnly ?? false;
    // A local-only node has no public endpoint, so don't resolve/prompt for a
    // domain — the domain-dependent phases self-skip below.
    const domain = localOnly ? undefined : await resolveDomain(opts);
    const certWarnDays = resolveCertWarnDays(opts);
    const cfToken = resolveCfToken(opts);

    const apiHost = localOnly ? '' : (opts.apiHost ?? `api.${domain}`);
    const images = opts.image ?? [];
    const ollama = await resolveOllamaVerifyInput(opts);
    const supabaseUrl = await resolveSupabaseUrlVerifyInput(opts);
    // Fixed phases: TLS, health, GraphQL, Ollama, SUPABASE_URL, Cloudflare (6)
    // + cosign (one line when no --image, else one per image).
    const totalPhases = 6 + (images.length === 0 ? 1 : images.length);

    const report = await runVerifyWithSpinner({
      apiHost,
      certWarnDays,
      cfToken,
      opts,
      images,
      totalPhases,
      localOnly,
      ...(ollama ? { ollama } : {}),
      ...(supabaseUrl !== undefined ? { supabaseUrl } : {}),
    });

    renderVerifySummary(report, { opts, totalPhases });
    reportVerifyOutcome(report);
  });

function phaseIcon(ph: VerifyPhase): string {
  switch (ph.status) {
    case 'ok': return pc.green('✓');
    case 'warn': return pc.yellow('⚠');
    case 'skipped': return pc.dim('·');
    case 'fail': return pc.red('✗');
  }
}

function phaseColor(status: VerifyPhase['status']): (text: string) => string {
  switch (status) {
    case 'ok': return pc.green;
    case 'warn': return pc.yellow;
    case 'skipped': return pc.dim;
    case 'fail': return pc.red;
  }
}

function formatPhaseLine(prefix: string, ph: VerifyPhase): string {
  const icon = phaseIcon(ph);
  const colorize = phaseColor(ph.status);
  return colorize(`${icon} ${prefix}: ${ph.detail}`);
}

// ----------------------------------------------------------------------------
// Verify command phases
// ----------------------------------------------------------------------------
// The action delegates to these so no single function exceeds the
// cognitive-complexity budget. Behavior-preserving: interactive prompts,
// spinners, and process.exit calls are relocated verbatim.

async function resolveDomain(opts: VerifyOptions): Promise<string> {
  const domain = opts.domain
    ? opts.domain
    : unwrap(
        await p.text({
          message: 'Public domain of the node?',
          placeholder: 'yournode.example.org',
          validate: (v) =>
            DOMAIN_RE.test(v ?? '') ? undefined : 'lowercase letters, digits, hyphens, dots; must contain a dot and a TLD',
        }),
      );
  if (!DOMAIN_RE.test(domain)) {
    p.cancel(`--domain ${JSON.stringify(domain)} doesn't look like a domain.`);
    process.exit(2);
  }
  return domain;
}

// (review B1) Validate --cert-warn-days to a non-negative integer.
function resolveCertWarnDays(opts: VerifyOptions): number {
  const rawDays = opts.certWarnDays ?? '14';
  const certWarnDays = Number.parseInt(rawDays, 10);
  if (!Number.isFinite(certWarnDays) || certWarnDays < 0 || !/^\d+$/.test(rawDays)) {
    p.cancel(`--cert-warn-days must be a non-negative integer (got ${JSON.stringify(rawDays)}).`);
    process.exit(2);
  }
  return certWarnDays;
}

// Resolve the CF token from --cf-token or --cf-token-file (mutually exclusive).
function resolveCfToken(opts: VerifyOptions): string | undefined {
  if (opts.cfToken && opts.cfTokenFile) {
    p.cancel('Pass either --cf-token or --cf-token-file, not both.');
    process.exit(2);
  }
  if (opts.cfToken) return opts.cfToken;
  if (!opts.cfTokenFile) return undefined;
  try {
    return readTokenFile(opts.cfTokenFile);
  } catch (err) {
    p.cancel((err as Error).message);
    process.exit(2);
  }
}

/** Narrow an arbitrary `.env` string to a known provider, or undefined. */
function normalizeProvider(v: string | undefined): EmbeddingsProvider | undefined {
  return v === 'ollama' || v === 'xenova' ? v : undefined;
}

/**
 * Merge CLI flags over the node `.env` config, per field. A flag always wins
 * over the file for its own field, but a field the flag omits still falls back
 * to `.env` — so `--llm-model foo` on the node still picks up the provider /
 * embedding model from `.env`. Undefined when no model resolves at all (the
 * phase then skips). Pure — unit-tested independently of the filesystem.
 */
export function mergeOllamaModelConfig(
  opts: Pick<VerifyOptions, 'llmModel' | 'embeddingModel' | 'embeddingsProvider'>,
  envCfg: NodeEnvModelConfig,
): VerifyInput['ollama'] {
  const llmModel = opts.llmModel ?? envCfg.llmModel;
  if (!llmModel) return undefined;
  const embeddingModel = opts.embeddingModel ?? envCfg.embeddingModel;
  const provider = normalizeProvider(opts.embeddingsProvider ?? envCfg.embeddingsProvider);
  return {
    llmModel,
    ...(embeddingModel ? { embeddingModel } : {}),
    ...(provider ? { provider } : {}),
  };
}

// Resolve the model config the Ollama presence phase asserts. Reads the node
// `.env` (single source of truth written by bootstrap) and merges flags over
// it per field. The `.env` is only read from a dir we trust — an explicit
// --repo-dir, or a cwd that actually looks like a node repo — so a stray
// `.env` in an unrelated cwd can't trigger a localhost probe (false fail).
async function resolveOllamaVerifyInput(opts: VerifyOptions): Promise<VerifyInput['ollama']> {
  const explicit = opts.repoDir !== undefined;
  const dir = opts.repoDir ?? process.cwd();
  const envCfg: NodeEnvModelConfig =
    explicit || (await looksLikeNodeRepo(dir)) ? await readEnvModelConfig(dir) : {};

  // Surface a typo'd EMBEDDINGS_PROVIDER instead of silently skipping the
  // embedding-model check (only the .env can carry a bad value — the flag is
  // constrained by commander `.choices`).
  if (
    opts.embeddingsProvider === undefined &&
    envCfg.embeddingsProvider !== undefined &&
    normalizeProvider(envCfg.embeddingsProvider) === undefined
  ) {
    p.note(
      `${pc.yellow('⚠')} Unrecognized EMBEDDINGS_PROVIDER=${envCfg.embeddingsProvider} in .env — expected xenova|ollama; the embedding-model check is disabled.`,
      'verify',
    );
  }

  return mergeOllamaModelConfig(opts, envCfg);
}

// Read SUPABASE_URL from the node `.env` for the sanity check. Same node-repo
// gating as the Ollama resolver so an unrelated cwd never trips a false warn.
async function resolveSupabaseUrlVerifyInput(opts: VerifyOptions): Promise<string | undefined> {
  const explicit = opts.repoDir !== undefined;
  const dir = opts.repoDir ?? process.cwd();
  if (!explicit && !(await looksLikeNodeRepo(dir))) return undefined;
  return (await readEnvModelConfig(dir)).supabaseUrl;
}

// Run the checks behind a single spinner that advances per phase.
async function runVerifyWithSpinner(args: {
  apiHost: string;
  certWarnDays: number;
  cfToken: string | undefined;
  opts: VerifyOptions;
  images: string[];
  totalPhases: number;
  localOnly: boolean;
  ollama?: VerifyInput['ollama'];
}): Promise<VerifyReport> {
  const { apiHost, certWarnDays, cfToken, opts, images, totalPhases, localOnly, ollama } = args;

  let phaseIndex = 0;
  let activeSpin: ReturnType<typeof p.spinner> | null = null;
  const renderPhase = (ph: VerifyPhase): void => {
    phaseIndex++;
    const prefix = `[${phaseIndex}/${totalPhases}] ${ph.name}`;
    activeSpin?.stop(formatPhaseLine(prefix, ph));
    activeSpin = null;
  };

  const deps: VerifyDeps = { ...DEFAULT_DEPS, onPhase: renderPhase };

  activeSpin = p.spinner();
  activeSpin.start('Running checks…');

  const report = await runVerify(
    {
      apiHost,
      certWarnDays,
      cf: {
        ...(cfToken ? { token: cfToken } : {}),
        ...(opts.cfAccountId ? { accountId: opts.cfAccountId } : {}),
        ...(opts.tunnelId ? { tunnelId: opts.tunnelId } : {}),
      },
      images,
      localOnly,
      ...(ollama ? { ollama } : {}),
    },
    deps,
  );
  // If `runVerify` finished without firing onPhase for some pathological
  // reason, stop the spinner cleanly.
  activeSpin?.stop('Done.');
  return report;
}

// Render the per-phase summary note (hiding skipped phases unless asked).
function renderVerifySummary(
  report: VerifyReport,
  args: { opts: VerifyOptions; totalPhases: number },
): void {
  const { opts, totalPhases } = args;
  const visible = (opts.showSkipped ?? false)
    ? report.phases
    : report.phases.filter((ph) => ph.status !== 'skipped');
  const lines = visible.map((ph) => {
    const idx = report.phases.indexOf(ph) + 1;
    return `${phaseIcon(ph)} [${idx}/${totalPhases}] ${ph.name}: ${pc.dim(ph.detail)}`;
  });
  const skippedCount = report.phases.length - visible.length;
  if (skippedCount > 0 && !opts.showSkipped) {
    lines.push(pc.dim(`· ${skippedCount} phase${skippedCount === 1 ? '' : 's'} skipped (run with --show-skipped to see them)`));
  }
  p.note(lines.join('\n'), 'Summary');
}

// Final outro + exit code from the phase report.
function reportVerifyOutcome(report: VerifyReport): void {
  const summary = summarize(report);
  if (!summary.ok) {
    p.outro(pc.red(`${summary.failed} check${summary.failed === 1 ? '' : 's'} failed.`));
    process.exit(1);
  }
  if (summary.warned === 0) {
    p.outro(pc.green('All checks passed.'));
  } else {
    p.outro(pc.yellow(`Passed with ${summary.warned} warning${summary.warned === 1 ? '' : 's'}.`));
  }
}
