import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import { probeCloudflareToken } from '../lib/cloudflare.js';

interface InitOptions {
  domain?: string;
  region?: string;
  cfToken?: string;
  cfAccount?: string;
  cfZone?: string;
  yes?: boolean;
}

export const initCommand = new Command('init')
  .description(
    'Stand up the node repo + Cloudflare infrastructure for a new region. ' +
      'Run this on your laptop.',
  )
  .addOption(
    new Option('--domain <domain>', 'Your registered domain (e.g. example.org)'),
  )
  .addOption(
    new Option('--region <slug>', 'Short label for your region (e.g. us-ca)'),
  )
  .addOption(
    new Option('--cf-token <token>', 'Cloudflare Account API token').env('CF_TOKEN'),
  )
  .addOption(
    new Option('--cf-account <id>', 'Cloudflare account ID').env('CF_ACCOUNT'),
  )
  .addOption(
    new Option('--cf-zone <id>', 'Cloudflare zone ID for your domain').env('CF_ZONE'),
  )
  .addOption(new Option('-y, --yes', 'Skip confirmation prompts').default(false))
  .action(async (opts: InitOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node ')));

    p.note(
      [
        'This walks you from a sealed Mac Studio + a Cloudflare account to a',
        'live federation node serving traffic at api.<your-domain>.',
        '',
        pc.dim('Phase 1: laptop side — Cloudflare, GitHub, Terraform Cloud.'),
        pc.dim('Phase 2: Studio side — run `create-op-node bootstrap` on the Mac.'),
      ].join('\n'),
      'Welcome',
    );

    // ---- Step 1: collect / confirm region values ----
    const values = await p.group(
      {
        domain: () =>
          opts.domain
            ? Promise.resolve(opts.domain)
            : p.text({
                message: 'Domain registered in Cloudflare?',
                placeholder: 'example.org',
                validate: (v) =>
                  !v ? 'Required' : v.includes('.') ? undefined : 'Looks like that domain is missing a TLD',
              }),
        region: () =>
          opts.region
            ? Promise.resolve(opts.region)
            : p.text({
                message: 'Short region label (used as a prefix in 1Password + R2)?',
                placeholder: 'us-ca',
                validate: (v) => (/^[a-z0-9-]{2,32}$/.test(v ?? '') ? undefined : 'lowercase letters, digits, hyphens; 2–32 chars'),
              }),
      },
      {
        onCancel: () => {
          p.cancel('Cancelled.');
          process.exit(0);
        },
      },
    );

    // ---- Step 2: Cloudflare token verification ----
    const tokenSpinner = p.spinner();

    let cfToken = opts.cfToken;
    if (!cfToken) {
      const v = await p.password({
        message: 'Paste your Cloudflare Account API token (input hidden)',
        validate: (v) => (v && v.length >= 30 ? undefined : 'Token looks too short'),
      });
      if (p.isCancel(v)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      cfToken = v;
    }

    let cfAccount = opts.cfAccount;
    if (!cfAccount) {
      const v = await p.text({
        message: 'Cloudflare account ID',
        placeholder: '0000000000000000000000000000000',
        validate: (v) => (/^[a-f0-9]{32}$/.test(v ?? '') ? undefined : 'Expected 32 hex characters'),
      });
      if (p.isCancel(v)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      cfAccount = v;
    }

    let cfZone = opts.cfZone;
    if (!cfZone) {
      const v = await p.text({
        message: `Cloudflare zone ID for ${values.domain}`,
        placeholder: '0000000000000000000000000000000',
        validate: (v) => (/^[a-f0-9]{32}$/.test(v ?? '') ? undefined : 'Expected 32 hex characters'),
      });
      if (p.isCancel(v)) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
      cfZone = v;
    }

    tokenSpinner.start('Verifying token + scopes against the Cloudflare API…');
    const probe = await probeCloudflareToken({
      token: cfToken,
      accountId: cfAccount,
      zoneId: cfZone,
    });
    if (probe.ok) {
      tokenSpinner.stop(pc.green('✓ Token valid, all 5 scopes present.'));
    } else {
      tokenSpinner.stop(pc.red('✗ Token check failed.'));
      for (const issue of probe.issues) {
        console.error(`  - ${issue}`);
      }
      p.cancel('Fix the token in the Cloudflare dashboard, then re-run.');
      process.exit(1);
    }

    // ---- Step 3: stub — the rest comes in v0.0.2 ----
    p.note(
      [
        pc.yellow('Stopping here in v0.0.1. Coming next:'),
        '',
        '  • Validate Terraform Cloud token',
        '  • `gh repo create --template OpusPopuli/opuspopuli-node`',
        '  • Seed 5 GitHub Secrets via Octokit',
        '  • Write environments/prod.tfvars from your answers',
        '  • Generate pgsodium master key + stash in 1Password (via `op` if available)',
        '  • Open the first PR; wait for `terraform apply` to complete',
        '  • Retrieve Tunnel token from TF Cloud outputs',
        '  • Print next steps for `create-op-node bootstrap` on the Mac Studio',
      ].join('\n'),
      'Roadmap',
    );

    p.outro(pc.cyan(`Ready for the next session. Your region: opuspopuli-node-${values.region}`));
  });
