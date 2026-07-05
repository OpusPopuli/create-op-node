import { readFileSync } from 'node:fs';

import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import { tunnelStatus, type TunnelStatusInput, type TunnelStatusResult } from '../lib/cloudflare.js';
import { cosignVerifyImage, type CosignVerifyInput, type CosignVerifyResult } from '../lib/cosign.js';
import { graphqlProbe, httpProbe, type GraphqlProbeInput, type GraphqlProbeResult, type HttpProbeInput, type HttpProbeResult } from '../lib/http.js';
import { unwrap } from '../lib/prompts.js';
import { tlsHandshake, type TlsProbeInput, type TlsHandshakeResult } from '../lib/tls.js';

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
}

const DEFAULT_DEPS: VerifyDeps = {
  tls: tlsHandshake,
  http: httpProbe,
  graphql: graphqlProbe,
  tunnel: tunnelStatus,
  cosign: cosignVerifyImage,
};

export async function runVerify(input: VerifyInput, deps: VerifyDeps = DEFAULT_DEPS): Promise<VerifyReport> {
  const phases: VerifyPhase[] = [];
  const push = (ph: VerifyPhase): void => {
    phases.push(ph);
    deps.onPhase?.(ph);
  };

  // ---- Phase 1: TLS handshake ---------------------------------------
  const tls = await deps.tls({ host: input.apiHost });
  if (!tls.ok) {
    push({ name: 'TLS handshake', status: 'fail', detail: tls.reason });
  } else {
    const line = `subject=${tls.subject}, issuer=${tls.issuer}, ${formatExpiry(tls.daysToExpiry)}`;
    const warn = tls.daysToExpiry < input.certWarnDays;
    if (warn) {
      push({
        name: 'TLS handshake',
        status: 'warn',
        detail: tls.daysToExpiry < 0
          ? line
          : `${line} (< warn threshold ${input.certWarnDays}d)`,
      });
    } else {
      push({ name: 'TLS handshake', status: 'ok', detail: line });
    }
  }

  // ---- Phase 2: GET /health ------------------------------------------
  const healthUrl = `https://${input.apiHost}/health`;
  const health = await deps.http({ url: healthUrl });
  if (health.ok) {
    push({ name: 'GET /health', status: 'ok', detail: `HTTP ${health.status}` });
  } else {
    push({ name: 'GET /health', status: 'fail', detail: health.reason });
  }

  // ---- Phase 3: GraphQL { __typename } -------------------------------
  const gqlUrl = `https://${input.apiHost}/api`;
  const gql = await deps.graphql({ url: gqlUrl });
  if (gql.ok) {
    push({ name: 'GraphQL { __typename }', status: 'ok', detail: `typename=${gql.typename}` });
  } else {
    push({ name: 'GraphQL { __typename }', status: 'fail', detail: gql.reason });
  }

  // ---- Phase 4: Cloudflare Tunnel status (optional) ------------------
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
  } else if (cfSet.length < cfFields.length) {
    // (review S1) Partial config is operator-hostile — they almost certainly
    // meant to enable the check. Warn so the missing flag names are visible.
    const missing = cfFields.filter(([, v]) => v === undefined || v === '').map(([name]) => name).join(', ');
    push({
      name: 'Cloudflare Tunnel',
      status: 'warn',
      detail: `partial CF config — missing ${missing}; check skipped`,
    });
  } else {
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

  // ---- Phase 5: cosign signature check (optional) --------------------
  if (input.images.length === 0) {
    push({
      name: 'cosign verify',
      status: 'skipped',
      detail: 'pass --image <ref> (repeatable) to enable',
    });
  } else {
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

  return { phases };
}

/* ------------------------------------------------------------------ *
 *  CLI wrapper                                                       *
 * ------------------------------------------------------------------ */

function readTokenFile(path: string): string {
  const raw = readFileSync(path, 'utf8').trim();
  if (!raw) throw new Error(`--cf-token-file ${path} was empty`);
  return raw;
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
    new Option('--image <ref>', 'Repeatable. Image to cosign-verify (e.g. ghcr.io/opuspopuli/api:tag)').default(
      [] as string[],
    ),
  )
  .addOption(
    new Option('--cert-warn-days <n>', 'Warn if cert expires within N days').default('14'),
  )
  .addOption(
    new Option('--show-skipped', 'Include skipped phases in the summary').default(false),
  )
  .action(async (opts: VerifyOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node verify ')));

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

    // (review B1) Validate --cert-warn-days to a non-negative integer.
    const rawDays = opts.certWarnDays ?? '14';
    const certWarnDays = Number.parseInt(rawDays, 10);
    if (!Number.isFinite(certWarnDays) || certWarnDays < 0 || !/^\d+$/.test(rawDays)) {
      p.cancel(`--cert-warn-days must be a non-negative integer (got ${JSON.stringify(rawDays)}).`);
      process.exit(2);
    }

    if (opts.cfToken && opts.cfTokenFile) {
      p.cancel('Pass either --cf-token or --cf-token-file, not both.');
      process.exit(2);
    }
    let cfToken: string | undefined = opts.cfToken;
    if (!cfToken && opts.cfTokenFile) {
      try {
        cfToken = readTokenFile(opts.cfTokenFile);
      } catch (err) {
        p.cancel((err as Error).message);
        process.exit(2);
      }
    }

    const apiHost = opts.apiHost ?? `api.${domain}`;
    const images = opts.image ?? [];
    const totalPhases = 4 + (images.length === 0 ? 1 : images.length);

    let phaseIndex = 0;
    let activeSpin: ReturnType<typeof p.spinner> | null = null;
    const renderPhase = (ph: VerifyPhase): void => {
      phaseIndex++;
      const prefix = `[${phaseIndex}/${totalPhases}] ${ph.name}`;
      activeSpin?.stop(formatPhaseLine(prefix, ph));
      activeSpin = null;
    };

    // Each phase starts a spinner just before its dep call resolves; the
    // resolved phase is then rendered by `renderPhase`. We can't preempt
    // an in-flight spinner from inside `runVerify`, so we just stop the
    // previous one when the next phase lands.
    const deps: VerifyDeps = {
      ...DEFAULT_DEPS,
      onPhase: renderPhase,
    };

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
      },
      deps,
    );
    // If `runVerify` finished without firing onPhase for some pathological
    // reason, stop the spinner cleanly.
    activeSpin?.stop('Done.');

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

    const summary = summarize(report);
    if (summary.ok) {
      if (summary.warned === 0) {
        p.outro(pc.green('All checks passed.'));
      } else {
        p.outro(pc.yellow(`Passed with ${summary.warned} warning${summary.warned === 1 ? '' : 's'}.`));
      }
    } else {
      p.outro(pc.red(`${summary.failed} check${summary.failed === 1 ? '' : 's'} failed.`));
      process.exit(1);
    }
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
