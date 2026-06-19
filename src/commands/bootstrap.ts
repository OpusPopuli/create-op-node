import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import {
  detectBrew,
  HOMEBREW_INSTALL_COMMAND,
  installPackages,
  STUDIO_PACKAGES,
} from '../lib/homebrew.js';
import {
  disableDiskSleep,
  enableAutoRestartOnPowerFailure,
  inspectSystem,
} from '../lib/macos.js';
import { detectOp, readSecretFromOp } from '../lib/onepassword.js';
import { setupLaunchAgent } from '../lib/launchagent.js';
import { loginToGhcr, composePull, composeUp, waitForHealthy } from '../lib/docker.js';
import {
  DEFAULT_MODELS,
  checkOllamaHealth,
  probeHostDockerInternal,
  setupModels,
} from '../lib/ollama.js';
import { locateOrCloneRepo, type LocateOutcome } from '../lib/noderepo.js';
import { safeExeca } from '../lib/exec.js';

interface BootstrapOptions {
  region?: string;
  owner?: string;
  vault?: string;
  repoDir?: string;
  composeFile?: string[];
  envFile?: string;
  skipBrew?: boolean;
  skipLaunchAgent?: boolean;
  skipOllama?: boolean;
  skipStack?: boolean;
  yes?: boolean;
}

function unwrap<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel('Cancelled.');
    process.exit(0);
  }
  return value;
}

export const bootstrapCommand = new Command('bootstrap')
  .description(
    'Configure the Mac Studio and bring the stack up. Run this on the Studio itself, after `init` has finished on your laptop.',
  )
  .addOption(new Option('--region <slug>', 'Region label set during init (e.g. us-ca)'))
  .addOption(new Option('--owner <owner>', 'GitHub owner for the node repo').default('OpusPopuli'))
  .addOption(new Option('--vault <vault>', '1Password vault to read secrets from').default('Private'))
  .addOption(new Option('--repo-dir <path>', 'Explicit path to a checked-out node repo (overrides cwd + clone)'))
  .addOption(
    new Option(
      '--compose-file <path>',
      'Repeatable. Compose file relative to repo root. Default: docker-compose-prod.yml + docker-compose-backup.yml',
    ).default(['docker-compose-prod.yml', 'docker-compose-backup.yml'] as string[]),
  )
  .addOption(new Option('--env-file <path>', 'Compose --env-file. Default: .env.production'))
  .addOption(new Option('--skip-brew', "Skip the Homebrew package install pass").default(false))
  .addOption(
    new Option(
      '--skip-launch-agent',
      "Skip the LaunchAgent setup (assumes one is already in place)",
    ).default(false),
  )
  .addOption(new Option('--skip-ollama', "Skip the Ollama model pull + warm").default(false))
  .addOption(new Option('--skip-stack', "Stop before `docker compose pull && up`").default(false))
  .addOption(new Option('-y, --yes', 'Skip confirmation prompts').default(false))
  .action(async (opts: BootstrapOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node bootstrap ')));

    // ---- Region label (required to find 1Password items + repo name) ------
    const region = opts.region
      ? opts.region
      : unwrap(
          await p.text({
            message: 'Region label (the slug used during init — e.g. us-ca)?',
            placeholder: 'us-ca',
            validate: (v) =>
              /^[a-z0-9-]{2,32}$/.test(v ?? '') ? undefined : 'lowercase letters, digits, hyphens; 2–32 chars',
          }),
        );

    const owner = opts.owner ?? 'OpusPopuli';
    const repoName = `opuspopuli-node-${region}`;

    // ---- Phase 1: macOS sanity ----
    const sysSpin = p.spinner();
    sysSpin.start('Inspecting macOS…');
    const snap = await inspectSystem();
    sysSpin.stop(pc.green('✓ macOS inspected.'));

    if (!snap.isAppleSilicon) {
      p.cancel(
        `Bootstrap requires an Apple Silicon Mac (the runbook targets M-series). Detected: ${snap.osVersion ?? 'unknown'} (uname -m != arm64).`,
      );
      process.exit(1);
    }

    p.note(
      [
        `Hostname:                 ${pc.cyan(snap.hostname)}`,
        `macOS:                    ${pc.cyan(snap.osVersion ?? '(sw_vers failed)')}`,
        `Auto-restart on power:    ${kvBool(snap.autoRestartOnPowerFailure)}`,
        `Disk sleep disabled:      ${kvBool(snap.diskSleepDisabled)}`,
        `FileVault:                ${kvFileVault(snap.fileVaultEnabled)}`,
      ].join('\n'),
      'System snapshot',
    );

    if (!snap.autoRestartOnPowerFailure) {
      const fix = unwrap(
        await p.confirm({
          message: 'Auto-restart-on-power-failure is OFF. Enable now (requires sudo)?',
          initialValue: true,
        }),
      );
      if (fix) {
        const r = await enableAutoRestartOnPowerFailure();
        if (!r.ok) p.note(`${pc.red('✗')} ${r.reason}`, 'pmset failed');
      }
    }
    if (!snap.diskSleepDisabled) {
      const fix = unwrap(
        await p.confirm({
          message: 'Disk sleep is enabled. Disable now (requires sudo)?',
          initialValue: true,
        }),
      );
      if (fix) {
        const r = await disableDiskSleep();
        if (!r.ok) p.note(`${pc.red('✗')} ${r.reason}`, 'pmset failed');
      }
    }

    // ---- Phase 2: Homebrew + tool installs ----
    if (!opts.skipBrew) {
      const brewInfo = await detectBrew();
      if (!brewInfo.installed) {
        p.note(
          [
            `Homebrew is not installed. Open another shell and run:`,
            '',
            pc.cyan(HOMEBREW_INSTALL_COMMAND),
            '',
            pc.dim('Then come back and press Enter.'),
          ].join('\n'),
          'Manual step',
        );
        unwrap(await p.confirm({ message: 'Homebrew installed?', initialValue: true }));
      }

      const brewSpin = p.spinner();
      brewSpin.start('Installing Studio packages…');
      const report = await installPackages(STUDIO_PACKAGES, (pkg, status) => {
        brewSpin.message(`${status}: ${pkg.name}`);
      });
      brewSpin.stop(
        report.failed.length === 0
          ? pc.green(
              `✓ ${report.installed.length} installed, ${report.alreadyPresent.length} already present`,
            )
          : pc.yellow(
              `⚠ ${report.installed.length} installed, ${report.alreadyPresent.length} present, ${report.failed.length} failed`,
            ),
      );
      if (report.failed.length > 0) {
        p.note(
          report.failed.map((f) => `${pc.red('•')} ${f.pkg.name}: ${f.reason}`).join('\n'),
          'Brew failures',
        );
        const cont = unwrap(
          await p.confirm({ message: 'Continue anyway?', initialValue: false }),
        );
        if (!cont) process.exit(1);
      }
    }

    // ---- Phase 3: GitHub + Tailscale auth ----
    await ensureGhAuth();
    await promptTailscaleSignin();

    // ---- Phase 4: 1Password secrets ----
    const op = await detectOp();
    if (!op.installed || !op.signedIn) {
      p.cancel(
        '1Password CLI not installed or not signed in. Run `op signin` and re-run bootstrap. ' +
          '(Or paste pgsodium key + Tunnel token by hand — manual path not in v0.1.)',
      );
      process.exit(1);
    }
    const keyTitle = `opuspopuli-${region}-pgsodium-root-key`;
    const tunnelTitle = `opuspopuli-${region}-tunnel-token`;
    const vaultArg = opts.vault ? { vault: opts.vault } : {};

    const opSpin = p.spinner();
    opSpin.start('Reading pgsodium key + Tunnel token from 1Password…');
    const pgsodiumKey = await readSecretFromOp({ title: keyTitle, ...vaultArg });
    const tunnelToken = await readSecretFromOp({ title: tunnelTitle, ...vaultArg });
    if (!pgsodiumKey || !tunnelToken) {
      opSpin.stop(pc.red('✗ Required 1Password items missing.'));
      const missing = [
        pgsodiumKey ? null : keyTitle,
        tunnelToken ? null : tunnelTitle,
      ].filter(Boolean) as string[];
      p.cancel(
        `Missing in 1Password (vault: ${opts.vault ?? 'Private'}): ${missing.join(', ')}. ` +
          `Run \`create-op-node init\` first, or pass --vault if your items live elsewhere.`,
      );
      process.exit(1);
    }
    if (!/^[a-f0-9]{64}$/.test(pgsodiumKey)) {
      opSpin.stop(pc.red('✗ pgsodium item exists but isn\'t a 64-hex key.'));
      p.cancel('Inspect the item in 1Password; it should be 64 lowercase hex characters.');
      process.exit(1);
    }
    opSpin.stop(pc.green('✓ Secrets read from 1Password.'));

    // ---- Phase 5: LaunchAgent ----
    if (!opts.skipLaunchAgent) {
      const laSpin = p.spinner();
      laSpin.start('Writing pgsodium key file + LaunchAgent plist…');
      const la = await setupLaunchAgent({ pgsodiumKey, tunnelToken });
      if (!la.ok) {
        laSpin.stop(pc.red(`✗ LaunchAgent step ${la.step} failed.`));
        p.cancel(la.reason ?? 'LaunchAgent setup failed.');
        process.exit(1);
      }
      laSpin.stop(pc.green(`✓ LaunchAgent loaded (${la.paths.plistFile}).`));
    }

    // ---- Phase 6: ghcr.io login ----
    const ghcrSpin = p.spinner();
    ghcrSpin.start('Authenticating Docker to ghcr.io…');
    const ghcr = await loginToGhcr();
    if (!ghcr.ok) {
      ghcrSpin.stop(pc.red('✗ ghcr.io login failed.'));
      p.cancel(ghcr.reason ?? 'ghcr.io login failed.');
      process.exit(1);
    }
    ghcrSpin.stop(pc.green('✓ Logged in to ghcr.io.'));

    // ---- Phase 7: Ollama ----
    if (!opts.skipOllama) {
      const olSpin = p.spinner();
      olSpin.start('Pulling + warming Ollama models…');
      const olHealth = await checkOllamaHealth();
      if (!olHealth.reachable) {
        olSpin.stop(
          pc.yellow('⚠ Ollama not reachable yet — run `brew services start ollama` and re-run with --skip-brew.'),
        );
        p.cancel('Ollama needs to be running before bootstrap can pull models.');
        process.exit(1);
      }
      const modelReport = await setupModels(DEFAULT_MODELS, (model, status) => {
        olSpin.message(`${status}: ${model}`);
      });
      olSpin.stop(
        modelReport.failed.length === 0
          ? pc.green(
              `✓ ${modelReport.pulled.length} pulled, ${modelReport.alreadyPresent.length} present, ${modelReport.warmed.length} warmed`,
            )
          : pc.yellow(`⚠ ${modelReport.failed.length} model pull(s) failed`),
      );
      const probe = await probeHostDockerInternal();
      if (!probe.ok) {
        p.note(`${pc.yellow('⚠')} ${probe.reason}`, 'Docker host networking');
      }
    }

    // ---- Phase 8: Locate / clone node repo ----
    const repoSpin = p.spinner();
    repoSpin.start('Locating your region node repo…');
    const locateInputBase = {
      owner,
      name: repoName,
      cwd: process.cwd(),
    } as const;
    const located = await locateOrCloneRepo({
      ...locateInputBase,
      ...(opts.repoDir ? { explicit: opts.repoDir } : {}),
    });
    const repoPath = repoPathFromLocate(located);
    if (!repoPath) {
      repoSpin.stop(pc.red('✗ Couldn\'t locate or clone the region repo.'));
      handleLocateError(located, owner, repoName);
      process.exit(1);
    }
    repoSpin.stop(
      located.kind === 'cloned'
        ? pc.green(`✓ Cloned ${owner}/${repoName} to ${repoPath}`)
        : pc.green(`✓ Found region repo at ${repoPath}`),
    );

    // ---- Phase 9: docker compose pull + up ----
    if (opts.skipStack) {
      p.outro(
        pc.cyan(
          `Stack-up skipped. Run \`docker compose -f ${(opts.composeFile ?? ['docker-compose-prod.yml']).join(' -f ')} pull && up -d\` from ${repoPath} when ready.`,
        ),
      );
      return;
    }

    const composeFiles = (opts.composeFile ?? ['docker-compose-prod.yml']).map((f) =>
      f.startsWith('/') ? f : `${repoPath}/${f}`,
    );
    const composeOpts = {
      files: composeFiles,
      cwd: repoPath,
      ...(opts.envFile ? { envFile: opts.envFile } : {}),
    };

    const pullSpin = p.spinner();
    pullSpin.start('Pulling images from ghcr.io…');
    const pull = await composePull(composeOpts);
    if (!pull.ok) {
      pullSpin.stop(pc.red('✗ compose pull failed.'));
      p.cancel(pull.reason ?? 'compose pull failed.');
      process.exit(1);
    }
    pullSpin.stop(pc.green('✓ Images pulled.'));

    const upSpin = p.spinner();
    upSpin.start('Starting the stack…');
    const up = await composeUp(composeOpts);
    if (!up.ok) {
      upSpin.stop(pc.red('✗ compose up failed.'));
      p.cancel(up.reason ?? 'compose up failed.');
      process.exit(1);
    }
    upSpin.stop(pc.green('✓ Containers started — waiting for healthy…'));

    // ---- Phase 10: health-check loop ----
    const healthSpin = p.spinner();
    healthSpin.start('Polling for healthy containers (5s, up to 5 minutes)…');
    const outcome = await waitForHealthy(composeOpts, {
      onPoll: (snaps) => {
        const healthy = snaps.filter((s) => s.health === 'healthy').length;
        const running = snaps.filter((s) => s.state === 'running').length;
        healthSpin.message(`${healthy}/${running} healthy`);
      },
    });

    switch (outcome.kind) {
      case 'healthy':
        healthSpin.stop(pc.green(`✓ All ${outcome.snapshots.length} containers healthy.`));
        break;
      case 'unhealthy':
        healthSpin.stop(pc.red(`✗ ${outcome.problem}`));
        p.cancel(
          `Inspect with \`docker compose -f ${composeFiles.join(' -f ')} logs\`. Fix and re-run.`,
        );
        process.exit(1);
      case 'timeout':
        healthSpin.stop(pc.yellow('⚠ Timed out waiting for all containers to report healthy.'));
        p.note(
          outcome.snapshots
            .map((s) => `  ${kvHealth(s.health)} ${s.name} (${s.state})`)
            .join('\n'),
          'Container state at timeout',
        );
        break;
    }

    p.outro(
      pc.cyan(
        `Region ${region} is up. Next: verify off-LAN with \`npx create-op-node verify --domain <your-domain>\`.`,
      ),
    );
  });

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function kvBool(b: boolean): string {
  return b ? pc.green('on') : pc.yellow('off');
}

function kvFileVault(v: boolean | 'unknown'): string {
  if (v === 'unknown') return pc.dim('unknown');
  return v ? pc.green('on') : pc.dim('off');
}

function kvHealth(h: 'healthy' | 'unhealthy' | 'starting' | 'none'): string {
  switch (h) {
    case 'healthy':
      return pc.green('✓');
    case 'unhealthy':
      return pc.red('✗');
    case 'starting':
      return pc.yellow('…');
    case 'none':
      return pc.dim('-');
  }
}

function repoPathFromLocate(out: LocateOutcome): string | null {
  if (out.kind === 'found' || out.kind === 'cloned') return out.path;
  return null;
}

function handleLocateError(out: LocateOutcome, owner: string, name: string): void {
  switch (out.kind) {
    case 'explicit-not-a-node-repo':
      p.cancel(
        `${out.path} doesn't look like a node repo (missing one of docker-compose-prod.yml / supabase/init/pgsodium_getkey_env.sh). Point --repo-dir at the right place.`,
      );
      break;
    case 'gh-not-installed':
      p.cancel('`gh` not installed — install via `brew install gh` and re-run.');
      break;
    case 'clone-failed':
      p.cancel(
        `Couldn't clone ${owner}/${name}: ${out.reason}. Check repo exists + you have access.`,
      );
      break;
    case 'clone-disallowed':
      p.cancel(
        'No checked-out node repo found and --no-clone (or similar) was set. Provide --repo-dir.',
      );
      break;
  }
}

/**
 * Verify `gh` is signed in. If not, surface the one-line command to fix and
 * wait for the operator. Doesn't auto-run `gh auth login` since it opens a
 * browser flow and we don't want to fight it.
 */
async function ensureGhAuth(): Promise<void> {
  const status = await safeExeca('gh', ['auth', 'status']);
  if (status === null) {
    p.cancel('`gh` not on PATH. Install via `brew install gh` and re-run.');
    process.exit(1);
  }
  if (status.exitCode === 0) return;

  p.note(
    [
      '`gh` is not signed in. In another shell:',
      '',
      pc.cyan('gh auth login --web'),
      '',
      pc.dim('Then come back and press Enter.'),
    ].join('\n'),
    'Manual step',
  );
  unwrap(await p.confirm({ message: 'gh signed in?', initialValue: true }));
}

/**
 * Tailscale needs an interactive browser signin. We surface the command +
 * wait for confirmation rather than spawning it ourselves — operators run
 * different node setups (start at login vs. on-demand) and we don't want
 * to second-guess.
 */
async function promptTailscaleSignin(): Promise<void> {
  const status = await safeExeca('tailscale', ['status']);
  if (status !== null && status.exitCode === 0) return;

  p.note(
    [
      'Tailscale needs to be signed in. In another shell:',
      '',
      pc.cyan('tailscale up'),
      '',
      pc.dim('Accept the device on your tailnet, then come back and press Enter.'),
      pc.dim('(Skip this if you don\'t use Tailscale — pgsodium still works without it.)'),
    ].join('\n'),
    'Manual step',
  );
  unwrap(await p.confirm({ message: 'Tailscale signed in (or skipped)?', initialValue: true }));
}
