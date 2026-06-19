import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import { probeCloudflareToken } from '../lib/cloudflare.js';
import { probeTfcToken } from '../lib/tfc.js';
import { detectOp, readSecretFromOp, saveSecretToOp } from '../lib/onepassword.js';
import { safeExeca } from '../lib/exec.js';
import { unwrap } from '../lib/prompts.js';
import {
  commitFile,
  createBranch,
  createRepoFromTemplate,
  openPullRequest,
  setRepoSecret,
} from '../lib/github.js';
import { generatePgsodiumRootKey, renderProdTfvars } from '../lib/secrets.js';
import { findWorkspace } from '../lib/tfc.js';
import { waitForApply } from '../lib/polling.js';

interface InitOptions {
  domain?: string;
  region?: string;
  owner?: string;
  template?: string;
  project?: string;
  cfToken?: string;
  cfAccount?: string;
  cfZone?: string;
  tfToken?: string;
  tfOrg?: string;
  ghToken?: string;
  vault?: string;
  overwrite?: boolean;
  useExistingRepo?: boolean;
  skipWait?: boolean;
  yes?: boolean;
}

/** Pull the GitHub token from `gh auth token` if the CLI is signed in. Lets
 *  operators who use `gh` skip pasting their PAT. Returns null cleanly when
 *  `gh` isn't installed or isn't signed in. */
async function ghTokenFromCli(): Promise<string | null> {
  const r = await safeExeca('gh', ['auth', 'token']);
  if (r === null || r.exitCode !== 0) return null;
  const token = r.stdout.trim();
  return token.length > 0 ? token : null;
}

export const initCommand = new Command('init')
  .description(
    'Stand up the node repo + Cloudflare infrastructure for a new region. Run this on your laptop.',
  )
  .addOption(new Option('--domain <domain>', 'Your registered domain (e.g. example.org)'))
  .addOption(new Option('--region <slug>', 'Short label for your region (e.g. us-ca)'))
  .addOption(new Option('--owner <owner>', 'GitHub owner for the new node repo').default('OpusPopuli'))
  .addOption(
    new Option('--template <owner/repo>', 'Template repo to clone from').default(
      'OpusPopuli/opuspopuli-node',
    ),
  )
  .addOption(new Option('--project <name>', 'tfvars project prefix').default('opuspopuli'))
  .addOption(new Option('--cf-token <token>', 'Cloudflare Account API token').env('CF_TOKEN'))
  .addOption(new Option('--cf-account <id>', 'Cloudflare account ID').env('CF_ACCOUNT'))
  .addOption(new Option('--cf-zone <id>', 'Cloudflare zone ID for your domain').env('CF_ZONE'))
  .addOption(new Option('--tf-token <token>', 'Terraform Cloud user/team token').env('TF_API_TOKEN'))
  .addOption(new Option('--tf-org <org>', 'Terraform Cloud organization').env('TF_CLOUD_ORGANIZATION'))
  .addOption(new Option('--gh-token <token>', 'GitHub Personal Access Token (else gh CLI)').env('GH_TOKEN'))
  .addOption(new Option('--vault <vault>', '1Password vault for secrets').default('Private'))
  .addOption(
    new Option(
      '--overwrite',
      'Overwrite existing 1Password items (pgsodium key, Tunnel token) on a re-run',
    ).default(false),
  )
  .addOption(
    new Option(
      '--use-existing-repo',
      "Continue using a previously-created node repo (don't fail on 'already exists')",
    ).default(false),
  )
  .addOption(new Option('--skip-wait', "Don't poll for Terraform apply; exit after PR open").default(false))
  .addOption(new Option('-y, --yes', 'Skip the final confirmation').default(false))
  .action(async (opts: InitOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node init ')));

    p.note(
      [
        'This walks you from a sealed Mac Studio + a Cloudflare account to a',
        'live federation node serving traffic at api.<your-domain>.',
        '',
        pc.dim('Phase 1: laptop side (now) — Cloudflare, GitHub, Terraform Cloud.'),
        pc.dim('Phase 2: Studio side — run `create-op-node bootstrap` on the Mac.'),
      ].join('\n'),
      'Welcome',
    );

    // ---- Region values --------------------------------------------------
    const region = opts.region
      ? opts.region
      : unwrap(
          await p.text({
            message: 'Short region label (used as a prefix in 1Password + R2)?',
            placeholder: 'us-ca',
            validate: (v) =>
              /^[a-z0-9-]{2,32}$/.test(v ?? '') ? undefined : 'lowercase letters, digits, hyphens; 2–32 chars',
          }),
        );

    const domain = opts.domain
      ? opts.domain
      : unwrap(
          await p.text({
            message: 'Domain registered in Cloudflare?',
            placeholder: 'example.org',
            validate: (v) => (!v ? 'Required' : v.includes('.') ? undefined : 'Missing a TLD?'),
          }),
        );

    const owner = opts.owner ?? 'OpusPopuli';
    const newRepoName = `opuspopuli-node-${region}`;
    const newRepoFull = `${owner}/${newRepoName}`;

    // ---- Cloudflare token ----------------------------------------------
    const cfToken = await collectSecret(
      opts.cfToken,
      'Cloudflare Account API token (input hidden)',
      'cloudflare',
    );
    const cfAccount = await collectId(opts.cfAccount, 'Cloudflare account ID');
    const cfZone = await collectId(opts.cfZone, `Cloudflare zone ID for ${domain}`);

    const cfSpin = p.spinner();
    cfSpin.start('Verifying Cloudflare token + 5 scopes…');
    const cfProbe = await probeCloudflareToken({
      token: cfToken,
      accountId: cfAccount,
      zoneId: cfZone,
    });
    if (!cfProbe.ok) {
      cfSpin.stop(pc.red('✗ Cloudflare token check failed.'));
      for (const issue of cfProbe.issues) console.error(`  - ${issue}`);
      p.cancel('Fix the token in the Cloudflare dashboard, then re-run.');
      process.exit(1);
    }
    cfSpin.stop(pc.green('✓ Cloudflare token valid, 5 scopes present.'));

    // ---- Terraform Cloud token -----------------------------------------
    const tfToken = await collectSecret(
      opts.tfToken,
      'Terraform Cloud user/team API token',
      'tfc',
    );
    const tfOrg = opts.tfOrg
      ? opts.tfOrg
      : unwrap(
          await p.text({
            message: 'Terraform Cloud organization name?',
            placeholder: 'op-region-ca',
          }),
        );

    const tfSpin = p.spinner();
    tfSpin.start('Verifying Terraform Cloud token + organization…');
    const tfProbe = await probeTfcToken({ token: tfToken, organization: tfOrg });
    if (!tfProbe.ok) {
      tfSpin.stop(pc.red('✗ Terraform Cloud check failed.'));
      for (const issue of tfProbe.issues) console.error(`  - ${issue}`);
      p.cancel('Fix the token / org, then re-run.');
      process.exit(1);
    }
    tfSpin.stop(
      pc.green(
        `✓ TFC token valid${tfProbe.userName ? ` (as ${tfProbe.userName})` : ''}, org "${tfOrg}" reachable.`,
      ),
    );

    // ---- GitHub auth ---------------------------------------------------
    let ghToken = opts.ghToken;
    if (!ghToken) {
      const fromCli = await ghTokenFromCli();
      if (fromCli) {
        const useCli = unwrap(
          await p.confirm({
            message: 'Found a signed-in `gh` CLI — use its token?',
            initialValue: true,
          }),
        );
        if (useCli) ghToken = fromCli;
      }
    }
    if (!ghToken) {
      ghToken = await collectSecret(
        undefined,
        'GitHub Personal Access Token (repo scope)',
        'github',
      );
    }

    // ---- 1Password detection --------------------------------------------
    const op = await detectOp();
    const opNote = op.installed
      ? op.signedIn
        ? `✓ 1Password CLI signed in${op.email ? ` (${op.email})` : ''} — pgsodium key + Tunnel token will be saved automatically.`
        : `⚠ 1Password CLI installed but not signed in. Run \`op signin\` in another shell, or you'll be prompted to paste secrets.`
      : `⚠ 1Password CLI not installed. Secrets will be printed for you to paste into 1Password by hand.`;
    p.note(opNote, '1Password');

    // ---- Plan summary + confirm ----------------------------------------
    p.note(
      [
        `Region label:        ${pc.cyan(region)}`,
        `Domain:              ${pc.cyan(domain)}`,
        `New node repo:       ${pc.cyan(newRepoFull)}`,
        `Template:            ${pc.dim(opts.template ?? 'OpusPopuli/opuspopuli-node')}`,
        `TFC organization:    ${pc.cyan(tfOrg)}`,
        ``,
        `Will create the repo, seed 5 secrets, write prod.tfvars on a branch,`,
        `open a PR, generate a fresh pgsodium key, and (after you merge) wait`,
        `for terraform apply to finish and retrieve the Tunnel token.`,
      ].join('\n'),
      'Plan',
    );

    if (!opts.yes) {
      const go = unwrap(
        await p.confirm({ message: 'Proceed?', initialValue: true }),
      );
      if (!go) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
    }

    // ---- Execute: create repo ------------------------------------------
    const repoSpin = p.spinner();
    repoSpin.start(`Creating ${newRepoFull} from ${opts.template}…`);
    let created;
    try {
      created = await createRepoFromTemplate({
        token: ghToken,
        template: opts.template ?? 'OpusPopuli/opuspopuli-node',
        owner,
        name: newRepoName,
        description: `Opus Populi node deployment for ${region}`,
      });
      repoSpin.stop(pc.green(`✓ Created ${created.fullName}`));
    } catch (err) {
      // The most likely re-run failure mode: the repo already exists from a
      // previous partial run. The GitHub API responds with HTTP 422 for that
      // case — status code is the API contract, message text isn't. Don't
      // regex on the message; it can change.
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status: number }).status
          : 0;
      const message = (err as Error).message ?? 'unknown error';

      if (status !== 422) {
        repoSpin.stop(pc.red(`✗ Couldn't create repo: ${message}`));
        p.cancel('Fix the issue and re-run.');
        process.exit(1);
      }

      repoSpin.stop(pc.yellow(`⚠ ${newRepoFull} already exists.`));
      const reuse =
        opts.useExistingRepo ||
        unwrap(
          await p.confirm({
            message: `Continue with the existing ${newRepoFull}? (Re-seeds secrets + re-commits prod.tfvars on a fresh branch.)`,
            initialValue: true,
          }),
        );
      if (!reuse) {
        p.cancel(
          `Delete ${newRepoFull} on GitHub and re-run, or pass --use-existing-repo to skip this prompt.`,
        );
        process.exit(0);
      }
      // Synthesize the same shape `createRepoFromTemplate` returns so the rest
      // of the flow doesn't care which path got us here.
      created = {
        fullName: newRepoFull,
        htmlUrl: `https://github.com/${newRepoFull}`,
        defaultBranch: 'main',
      };
    }

    // ---- Execute: seed 5 secrets ---------------------------------------
    const secrets: Array<{ name: string; value: string }> = [
      { name: 'CLOUDFLARE_API_TOKEN', value: cfToken },
      { name: 'CLOUDFLARE_ACCOUNT_ID', value: cfAccount },
      { name: 'CLOUDFLARE_ZONE_ID', value: cfZone },
      { name: 'TF_API_TOKEN', value: tfToken },
      { name: 'TF_CLOUD_ORGANIZATION', value: tfOrg },
    ];
    const secSpin = p.spinner();
    secSpin.start(`Seeding ${secrets.length} repo secrets…`);
    const seeded: string[] = [];
    for (const s of secrets) {
      const r = await setRepoSecret({ repo: newRepoFull, name: s.name, value: s.value });
      if (!r.written) {
        secSpin.stop(pc.red(`✗ Failed to set ${s.name}: ${r.reason ?? 'unknown'}`));
        const remaining = secrets
          .slice(secrets.findIndex((x) => x.name === s.name))
          .map((x) => x.name);
        p.cancel(
          [
            seeded.length > 0
              ? `Already seeded on ${newRepoFull}: ${seeded.join(', ')}.`
              : `Nothing seeded yet on ${newRepoFull}.`,
            `Still pending: ${remaining.join(', ')}.`,
            '',
            `Make sure \`gh\` is installed and signed in (\`gh auth login\`).`,
            `Re-run with --use-existing-repo to retry (GitHub will overwrite the already-set secrets idempotently).`,
          ].join('\n'),
        );
        process.exit(1);
      }
      seeded.push(s.name);
    }
    secSpin.stop(pc.green(`✓ Seeded ${secrets.length} secrets on ${newRepoFull}`));

    // ---- Execute: branch + tfvars + PR ---------------------------------
    // Branch name is timestamped (ISO compact, UTC) so re-runs don't collide
    // with a leftover branch from a previous partial run. Keeps the PR list
    // readable and avoids a separate "branch already exists" idempotency
    // case.
    const branch = `init/region-${region}-${isoStampUtc(new Date())}`;
    const setupSpin = p.spinner();
    setupSpin.start(`Writing prod.tfvars on branch ${branch}…`);
    try {
      await createBranch({
        token: ghToken,
        repo: newRepoFull,
        branch,
        fromBranch: created.defaultBranch,
      });
      const tfvars = renderProdTfvars({
        project: opts.project ?? 'opuspopuli',
        domain,
      });
      await commitFile({
        token: ghToken,
        repo: newRepoFull,
        branch,
        path: 'infra/cloudflare/environments/prod.tfvars',
        content: tfvars,
        message: `init: prod.tfvars for ${region}`,
      });
    } catch (err) {
      setupSpin.stop(pc.red(`✗ Couldn't write tfvars: ${(err as Error).message}`));
      p.cancel('The repo exists but the branch / commit failed. Open it on GitHub and inspect.');
      process.exit(1);
    }
    setupSpin.stop(pc.green('✓ Wrote prod.tfvars'));

    const prSpin = p.spinner();
    prSpin.start('Opening pull request…');
    let pr;
    try {
      pr = await openPullRequest({
        token: ghToken,
        repo: newRepoFull,
        head: branch,
        base: created.defaultBranch,
        title: `init: bring up region ${region}`,
        body: [
          `Initial region deployment for **${region}** (${domain}).`,
          '',
          'Adds `infra/cloudflare/environments/prod.tfvars`. Merging this PR triggers',
          '`cloudflare-infra.yml` which runs `terraform apply` against the',
          `\`${tfOrg}\` Terraform Cloud organization, provisioning the Cloudflare`,
          'Tunnel, DNS records, R2 buckets, and Pages project.',
          '',
          `Generated by \`create-op-node init\`.`,
        ].join('\n'),
      });
    } catch (err) {
      prSpin.stop(pc.red(`✗ Couldn't open PR: ${(err as Error).message}`));
      p.cancel('Branch + tfvars are committed; open the PR by hand on GitHub.');
      process.exit(1);
    }
    prSpin.stop(pc.green(`✓ Opened PR #${pr.number}`));

    // ---- pgsodium master key (read existing OR generate fresh) ----------
    //
    // Three branches to handle cleanly:
    //   1. Op installed + signed in + key already in 1P + no --overwrite →
    //      surface the existing key (and use it, not a freshly-generated one).
    //   2. Op installed + signed in + no key OR --overwrite → generate fresh,
    //      save to 1P.
    //   3. Op unavailable → generate fresh, print for manual paste.
    const keyTitle = `opuspopuli-${region}-pgsodium-root-key`;
    const vaultArg = opts.vault ? { vault: opts.vault } : {};

    if (op.installed && op.signedIn) {
      const existing = opts.overwrite
        ? null
        : await readSecretFromOp({ title: keyTitle, ...vaultArg });
      if (existing && /^[a-f0-9]{64}$/.test(existing)) {
        p.note(
          `${pc.green('✓')} Re-using existing pgsodium master key from 1Password (${pc.cyan(keyTitle)}). Pass --overwrite to rotate.`,
          'Secret',
        );
      } else {
        const fresh = generatePgsodiumRootKey();
        const r = await saveSecretToOp({
          title: keyTitle,
          value: fresh,
          overwrite: opts.overwrite ?? false,
          ...vaultArg,
        });
        if (r.written) {
          p.note(
            `${pc.green('✓')} pgsodium master key${r.alreadyExisted ? ' rotated' : ' saved'} to 1Password as ${pc.cyan(keyTitle)}.`,
            'Secret',
          );
        } else if (r.alreadyExisted) {
          // Existed but didn't parse as 64-hex AND no --overwrite. Surface this
          // clearly rather than silently leaving the bad item in place.
          p.note(
            `${pc.yellow('!')} 1Password has an item titled ${pc.cyan(keyTitle)} but its value is NOT a 64-hex pgsodium key. Inspect it in 1Password; re-run with --overwrite to replace.`,
            'Secret',
          );
        } else {
          await printKeyForManualSave(fresh, keyTitle, r.reason);
        }
      }
    } else {
      const fresh = generatePgsodiumRootKey();
      await printKeyForManualSave(fresh, keyTitle);
    }

    // ---- Pause for operator to merge PR --------------------------------
    if (opts.skipWait) {
      p.outro(
        pc.cyan(
          `Review + merge ${pr.htmlUrl} when ready. Re-run with no --skip-wait or run \`npx create-op-node verify\` afterwards.`,
        ),
      );
      return;
    }

    p.note(
      [
        `Open the PR: ${pc.cyan(pr.htmlUrl)}`,
        '',
        'Review the `terraform plan` comment, then merge to main.',
        'The workflow then runs `terraform apply` against Terraform Cloud.',
      ].join('\n'),
      'Next step: review + merge',
    );
    const merged = unwrap(
      await p.confirm({ message: 'PR merged?', initialValue: false }),
    );
    if (!merged) {
      p.outro(
        pc.cyan(`No worries — re-run \`create-op-node init --skip-wait\` later to skip this step, or finish manually.`),
      );
      return;
    }

    // ---- Poll TFC for apply completion ---------------------------------
    const ws = await findWorkspace({
      token: tfToken,
      organization: tfOrg,
      tags: ['opuspopuli', 'cloudflare'],
    });
    if (!ws) {
      p.cancel(
        `Couldn't find a TFC workspace tagged opuspopuli + cloudflare in ${tfOrg}. ` +
          `Check the workflow's run log; the workspace is created on first apply.`,
      );
      process.exit(1);
    }

    const tunnelToken = await waitForApplyAndFetchTunnelToken({
      token: tfToken,
      organization: tfOrg,
      workspaceId: ws.id,
      runId: ws.currentRunId,
    });
    if (!tunnelToken) {
      p.cancel(
        `Terraform apply didn't produce a tunnel_token output. Check the run on TFC; if it succeeded, the output may be named differently — patch and re-run, or fetch via 'terraform output -raw tunnel_token'.`,
      );
      process.exit(1);
    }

    // ---- Save Tunnel token ----------------------------------------------
    const tunnelTitle = `opuspopuli-${region}-tunnel-token`;
    if (op.installed && op.signedIn) {
      const r = await saveSecretToOp({
        title: tunnelTitle,
        value: tunnelToken,
        ...(opts.vault ? { vault: opts.vault } : {}),
        overwrite: true,
      });
      if (r.written) {
        p.note(
          `${pc.green('✓')} Tunnel token saved to 1Password as ${pc.cyan(tunnelTitle)}.`,
          'Secret',
        );
      } else {
        await printKeyForManualSave(tunnelToken, tunnelTitle, r.reason);
      }
    } else {
      await printKeyForManualSave(tunnelToken, tunnelTitle);
    }

    // ---- Done -----------------------------------------------------------
    p.outro(
      pc.cyan(
        `Region ${region} is provisioned. Next: \`npx create-op-node bootstrap\` on the Mac Studio.`,
      ),
    );
  });

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/** Source-specific minimums — every real-world token from these issuers is
 *  longer than the floor, so a short input is a typo or paste error. */
const MIN_TOKEN_LENGTH: Record<SecretKind, number> = {
  cloudflare: 40,
  tfc: 40,
  github: 40,
  generic: 20,
};

type SecretKind = 'cloudflare' | 'tfc' | 'github' | 'generic';

async function collectSecret(
  preset: string | undefined,
  message: string,
  kind: SecretKind = 'generic',
): Promise<string> {
  if (preset) return preset;
  const min = MIN_TOKEN_LENGTH[kind];
  const v = unwrap(
    await p.password({
      message,
      validate: (v) =>
        v && v.length >= min
          ? undefined
          : `That looks too short — expected at least ${min} characters for a ${kind} token`,
    }),
  );
  return v;
}

async function collectId(preset: string | undefined, message: string): Promise<string> {
  if (preset) return preset;
  const v = unwrap(
    await p.text({
      message,
      placeholder: '0000000000000000000000000000000',
      validate: (v) =>
        /^[a-f0-9]{32}$/.test(v ?? '') ? undefined : 'Expected 32 hex characters',
    }),
  );
  return v;
}

async function printKeyForManualSave(
  value: string,
  title: string,
  reason?: string,
): Promise<void> {
  p.note(
    [
      reason ? `${pc.red('✗')} ${reason}` : '',
      `Save this value to 1Password as ${pc.cyan(title)}:`,
      '',
      pc.yellow(value),
      '',
      pc.dim('It will not be shown again.'),
    ]
      .filter((line) => line.length > 0)
      .join('\n'),
    'Manual save',
  );
  // Actually wait for the operator to confirm they've stashed it — previously
  // the doc said "Press Enter when stashed" but nothing paused. Operators
  // following the prompt literally would have hit a paradox.
  unwrap(
    await p.confirm({
      message: 'Value stashed in 1Password?',
      initialValue: true,
    }),
  );
}

/** Compact ISO timestamp suitable for a git branch name: 20260618-184530Z.
 *  UTC so re-runs across timezones sort coherently. */
function isoStampUtc(d: Date): string {
  const pad = (n: number, w = 2) => n.toString().padStart(w, '0');
  return (
    `${d.getUTCFullYear()}` +
    `${pad(d.getUTCMonth() + 1)}` +
    `${pad(d.getUTCDate())}` +
    `-` +
    `${pad(d.getUTCHours())}` +
    `${pad(d.getUTCMinutes())}` +
    `${pad(d.getUTCSeconds())}Z`
  );
}

interface WaitInput {
  token: string;
  organization: string;
  workspaceId: string;
  runId: string | null;
}

/** Thin command-side adapter for the polling lib — renders Clack spinner
 *  state from the lib's progress callback + maps the discriminated outcome
 *  to a single nullable result the command keeps using. */
async function waitForApplyAndFetchTunnelToken(input: WaitInput): Promise<string | null> {
  const spin = p.spinner();
  spin.start('Waiting for terraform apply to finish (polling every 10s)…');

  const outcome = await waitForApply({
    token: input.token,
    organization: input.organization,
    workspaceId: input.workspaceId,
    runId: input.runId,
    workspaceTags: ['opuspopuli', 'cloudflare'],
    outputName: 'tunnel_token',
  });

  switch (outcome.kind) {
    case 'success':
      spin.stop(pc.green('✓ Tunnel token retrieved.'));
      return outcome.value;
    case 'output-missing':
      spin.stop(pc.red('✗ Apply succeeded but tunnel_token output is missing.'));
      return null;
    case 'no-run-started':
      spin.stop(pc.red('✗ No run started in the workspace yet.'));
      return null;
    case 'run-failed':
      spin.stop(pc.red(`✗ Run finished with status "${outcome.status}".`));
      return null;
    case 'timeout':
      spin.stop(pc.red('✗ Timed out after 10 minutes.'));
      return null;
  }
}
