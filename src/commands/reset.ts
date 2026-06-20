/**
 * `create-op-node reset` — reverse of bootstrap. Stops the stack, unloads
 * the LaunchAgent, removes the pgsodium key file. By default the docker
 * volumes (and therefore the database) are PRESERVED. Pass `--wipe-data`
 * for the destructive variant; it requires retyping the region label as
 * confirmation.
 *
 * Reset does NOT touch cloud-side state (Cloudflare resources, the GitHub
 * repo, the TFC workspace). It also leaves the Keychain items in place —
 * delete those manually via Keychain Access or `security delete-generic-
 * password` if you want a truly clean slate.
 */

import { access } from 'node:fs/promises';

import { Command, Option } from 'commander';
import * as p from '@clack/prompts';
import pc from 'picocolors';

import { composeDown, composePs, dockerLogout, GHCR_REGISTRY } from '../lib/docker.js';
import { defaultPaths as defaultLaunchAgentPaths, teardownLaunchAgent } from '../lib/launchagent.js';
import { locateOrCloneRepo, NODE_REPO_MARKERS } from '../lib/noderepo.js';
import { unwrap } from '../lib/prompts.js';
import type { ContainerSnapshot } from '../lib/docker.js';
import type { LaunchAgentPaths, TeardownResult } from '../lib/launchagent.js';

import { resolveComposeFiles } from './bootstrap.js';

interface ResetOptions {
  region?: string;
  owner?: string;
  repoDir?: string;
  composeFile?: string[];
  envFile?: string;
  wipeData?: boolean;
  wipeImages?: boolean;
  removeOrphans?: boolean;
  skipStack?: boolean;
  skipLaunchAgent?: boolean;
  keepKeyFile?: boolean;
  skipDockerLogout?: boolean;
  registry?: string;
  dryRun?: boolean;
  yes?: boolean;
}

const REGION_RE = /^[a-z0-9-]{2,32}$/;

/* ------------------------------------------------------------------ *
 *  Phase-name constants (review S4 / N7)                             *
 *                                                                    *
 *  Exported so the CLI wrapper, runReset, and tests all share one    *
 *  source of truth — renames flow through automatically instead of   *
 *  drifting between the CLI's spinner setup and the orchestration's  *
 *  emitted phase names.                                              *
 * ------------------------------------------------------------------ */

export const RESET_PHASES = {
  STOP_STACK: 'Stop stack',
  LAUNCH_AGENT: 'LaunchAgent',
  DOCKER_LOGOUT: 'docker logout',
} as const;

type ResetPhaseName = (typeof RESET_PHASES)[keyof typeof RESET_PHASES];

/* ------------------------------------------------------------------ *
 *  Orchestration                                                     *
 * ------------------------------------------------------------------ */

export interface ResetPhase {
  readonly name: string;
  /** `dry-run` is reset-specific — verify uses `skipped` for both
   *  "configured-off" and "would-do-but-not-running" because verify
   *  has no preview mode. Reset's preview mode wants a distinct icon. */
  readonly status: 'ok' | 'warn' | 'fail' | 'skipped' | 'dry-run';
  readonly detail: string;
}

export interface ResetReport {
  readonly phases: ReadonlyArray<ResetPhase>;
}

export interface ResetDeps {
  composeDown: typeof composeDown;
  teardownLaunchAgent: typeof teardownLaunchAgent;
  dockerLogout: typeof dockerLogout;
  /** Notification fan-out — lets the CLI render spinners. */
  onPhase?: (phase: ResetPhase) => void;
}

export interface ResetInput {
  /** Set when we have a repo path + compose files. When missing the stack
   *  phase is reported as skipped. */
  stack?: {
    repoPath: string;
    composeFiles: string[];
    envFile?: string;
    wipeVolumes: boolean;
    /** When true, also remove all images referenced by the compose files
     *  (passes `--rmi all` to compose down). Forces a fresh pull on the
     *  next bootstrap — used for "wipe everything and start over" loops. */
    wipeImages: boolean;
    removeOrphans: boolean;
  };
  launchAgent?: {
    paths: LaunchAgentPaths;
    keepKeyFile: boolean;
  };
  /** Set when the docker-logout phase should run. The registry value is
   *  the argument passed to `docker logout <registry>`. */
  dockerLogout?: { registry: string };
  dryRun: boolean;
}

const DEFAULT_DEPS: ResetDeps = {
  composeDown,
  teardownLaunchAgent,
  dockerLogout,
};

/**
 * Run the three reset phases in reverse-bootstrap order.
 *
 * **Continue-on-failure policy**: each phase runs independently — a
 * `composeDown` failure does NOT short-circuit the LaunchAgent or
 * docker-logout phases. This is intentional: reset is best-effort
 * cleanup, and the operator usually wants the LaunchAgent gone even if
 * the docker daemon is down. Use the returned `ResetReport` to inspect
 * which phases failed.
 *
 * Each phase calls `deps.onPhase` exactly once before runReset moves
 * on, so a CLI consumer can render spinners in lockstep.
 */
export async function runReset(input: ResetInput, deps: ResetDeps = DEFAULT_DEPS): Promise<ResetReport> {
  const phases: ResetPhase[] = [];
  const push = (ph: ResetPhase): void => {
    phases.push(ph);
    deps.onPhase?.(ph);
  };

  // ---- Phase 1: stop the stack ---------------------------------------
  if (!input.stack) {
    push({
      name: RESET_PHASES.STOP_STACK,
      status: 'skipped',
      detail: '--skip-stack or no repo path resolved',
    });
  } else if (input.dryRun) {
    push({
      name: RESET_PHASES.STOP_STACK,
      status: 'dry-run',
      detail: `would run: docker compose -f ${input.stack.composeFiles.join(' -f ')} down${input.stack.wipeVolumes ? ' -v' : ''}${input.stack.removeOrphans ? ' --remove-orphans' : ''}${input.stack.wipeImages ? ' --rmi all' : ''}`,
    });
  } else {
    const result = await deps.composeDown({
      files: input.stack.composeFiles,
      cwd: input.stack.repoPath,
      ...(input.stack.envFile ? { envFile: input.stack.envFile } : {}),
      wipeVolumes: input.stack.wipeVolumes,
      removeOrphans: input.stack.removeOrphans,
      ...(input.stack.wipeImages ? { removeImages: 'all' as const } : {}),
    });
    if (result.ok) {
      const bits = [
        input.stack.wipeVolumes ? 'volumes destroyed' : 'containers stopped, volumes preserved',
        input.stack.wipeImages ? 'images removed (next bootstrap will re-pull)' : null,
      ].filter(Boolean);
      push({
        name: RESET_PHASES.STOP_STACK,
        status: 'ok',
        detail: bits.join('; '),
      });
    } else {
      push({ name: RESET_PHASES.STOP_STACK, status: 'fail', detail: result.reason ?? 'unknown failure' });
    }
  }

  // ---- Phase 2: LaunchAgent ------------------------------------------
  if (!input.launchAgent) {
    push({ name: RESET_PHASES.LAUNCH_AGENT, status: 'skipped', detail: '--skip-launch-agent or no plist found' });
  } else if (input.dryRun) {
    push({
      name: RESET_PHASES.LAUNCH_AGENT,
      status: 'dry-run',
      detail: `would unload ${input.launchAgent.paths.plistFile}, rm plist${
        input.launchAgent.keepKeyFile ? '' : ' + key file'
      }`,
    });
  } else {
    const result: TeardownResult = await deps.teardownLaunchAgent(
      input.launchAgent.paths,
      { keepKeyFile: input.launchAgent.keepKeyFile },
    );
    if (result.ok) {
      const removed = result.steps.filter((s) => s.step !== 'unload').map((s) => s.step).join(', ');
      push({ name: RESET_PHASES.LAUNCH_AGENT, status: 'ok', detail: `unloaded + ${removed}` });
    } else {
      const fail = result.steps.find((s) => !s.ok);
      push({
        name: RESET_PHASES.LAUNCH_AGENT,
        status: 'fail',
        detail: `${fail?.step}: ${fail?.reason ?? 'unknown'}`,
      });
    }
  }

  // ---- Phase 3: docker logout ----------------------------------------
  if (!input.dockerLogout) {
    push({ name: RESET_PHASES.DOCKER_LOGOUT, status: 'skipped', detail: '--skip-docker-logout' });
  } else if (input.dryRun) {
    push({
      name: RESET_PHASES.DOCKER_LOGOUT,
      status: 'dry-run',
      detail: `would run: docker logout ${input.dockerLogout.registry}`,
    });
  } else {
    const result = await deps.dockerLogout(input.dockerLogout.registry);
    if (result.ok) {
      push({
        name: RESET_PHASES.DOCKER_LOGOUT,
        status: 'ok',
        detail: `credentials removed from ${input.dockerLogout.registry}`,
      });
    } else {
      // See dockerLogout() docstring — older Docker versions return non-zero
      // when not currently logged in. Render as warn so reset doesn't fail
      // overall when the operator wasn't logged in to begin with.
      push({ name: RESET_PHASES.DOCKER_LOGOUT, status: 'warn', detail: result.reason ?? 'unknown' });
    }
  }

  return { phases };
}

/* ------------------------------------------------------------------ *
 *  CLI wrapper                                                       *
 * ------------------------------------------------------------------ */

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function phaseIcon(ph: ResetPhase): string {
  switch (ph.status) {
    case 'ok': return pc.green('✓');
    case 'warn': return pc.yellow('⚠');
    case 'skipped': return pc.dim('·');
    case 'dry-run': return pc.cyan('?');
    case 'fail': return pc.red('✗');
  }
}

export const resetCommand = new Command('reset')
  .description(
    'Reverse the Mac Studio side of bootstrap: stop containers, unload the LaunchAgent, ' +
      'remove the pgsodium key file. Preserves docker volumes by default — pass --wipe-data ' +
      'for a full data nuke (requires retyping the region label).',
  )
  .addOption(new Option('--region <slug>', 'Region label (used for --wipe-data confirmation + finding the repo)'))
  .addOption(new Option('--owner <owner>', 'GitHub owner for the node repo').default('OpusPopuli'))
  .addOption(new Option('--repo-dir <path>', 'Explicit path to a checked-out node repo'))
  .addOption(
    new Option(
      '--compose-file <path>',
      'Repeatable. Compose file relative to repo root. Default: docker-compose-prod.yml',
    ).default(['docker-compose-prod.yml'] as string[]),
  )
  .addOption(new Option('--env-file <path>', 'Compose --env-file. Default: .env.production'))
  .addOption(
    new Option(
      '--wipe-data',
      'DESTROYS docker volumes (adds -v to `compose down`). Requires retyping the region label as confirmation. Default off — volumes preserved.',
    ).default(false),
  )
  .addOption(
    new Option(
      '--wipe-images',
      'ALSO remove all docker images referenced by the compose file (adds --rmi all). Forces a fresh pull on next bootstrap. Implies --wipe-data semantics for the iteration loop ("wipe everything and start over"). Default off.',
    ).default(false),
  )
  .addOption(
    new Option(
      '--no-remove-orphans',
      'Do NOT pass --remove-orphans to compose down. Preserves containers from compose files no longer included.',
    ),
  )
  .addOption(new Option('--skip-stack', "Don't touch docker compose").default(false))
  .addOption(new Option('--skip-launch-agent', "Don't touch the LaunchAgent").default(false))
  .addOption(
    new Option(
      '--keep-key-file',
      "Preserve the pgsodium key file (only matters when LaunchAgent teardown runs). Useful as belt-and-suspenders backup before a wipe-data run.",
    ).default(false),
  )
  .addOption(new Option('--skip-docker-logout', "Don't run `docker logout`").default(false))
  .addOption(new Option('--registry <registry>', 'Registry to log out of').default(GHCR_REGISTRY))
  .addOption(new Option('--dry-run', 'Show what would happen without acting').default(false))
  .addOption(new Option('-y, --yes', 'Skip non-destructive confirmations (wipe still confirms)').default(false))
  .action(async (opts: ResetOptions) => {
    p.intro(pc.bgCyan(pc.black(' create-op-node reset ')));

    const wipeImages = opts.wipeImages ?? false;
    // --wipe-images implies --wipe-data — the iteration loop semantics are
    // "wipe everything." If the operator passed --wipe-images but not
    // --wipe-data, we still wipe volumes (no point keeping data tied to
    // images that are about to disappear).
    const wipeData = (opts.wipeData ?? false) || wipeImages;
    const removeOrphans = opts.removeOrphans ?? true; // commander --no-remove-orphans sets this to false

    // ---- Region (needed for confirmation phrase + repo discovery) ----
    const region = opts.region
      ? opts.region
      : unwrap(
          await p.text({
            message: 'Region label (the slug used during init — e.g. us-ca)?',
            placeholder: 'us-ca',
            validate: (v) =>
              REGION_RE.test(v ?? '') ? undefined : 'lowercase letters, digits, hyphens; 2–32 chars',
          }),
        );
    if (!REGION_RE.test(region)) {
      p.cancel(`--region ${JSON.stringify(region)} is not a valid region slug.`);
      process.exit(2);
    }

    const owner = opts.owner ?? 'OpusPopuli';
    const repoName = `opuspopuli-node-${region}`;

    // ---- Snapshot what's currently present ---------------------------
    const launchAgentPaths = defaultLaunchAgentPaths();
    const plistExists = await fileExists(launchAgentPaths.plistFile);
    const keyFileExists = await fileExists(launchAgentPaths.keyFile);

    let repoPath: string | undefined;
    let stackSkipReason: string | undefined;
    if (!opts.skipStack) {
      const located = await locateOrCloneRepo({
        owner,
        name: repoName,
        cwd: process.cwd(),
        allowClone: false,
        ...(opts.repoDir ? { explicit: opts.repoDir } : {}),
      });
      // Exhaustive: every LocateOutcome variant has a deliberate path —
      // operator-supplied --repo-dir mismatch is HARD-fail, ambient cwd
      // miss is SOFT-skip with a visible reason. (review B1)
      switch (located.kind) {
        case 'found':
          repoPath = located.path;
          break;
        case 'explicit-not-a-node-repo':
          p.cancel(
            `--repo-dir ${JSON.stringify(located.path)} doesn't look like a node repo ` +
              `(missing one of: ${NODE_REPO_MARKERS.join(', ')}). ` +
              `Verify the path or drop --repo-dir to let reset search the cwd.`,
          );
          process.exit(2);
          break;
        case 'clone-disallowed':
          stackSkipReason = `no checkout found at ${process.cwd()}; pass --repo-dir to target one`;
          break;
        case 'cloned':
        case 'gh-not-installed':
        case 'clone-failed':
          // Should not be reachable — allowClone: false above. Treat as
          // soft-skip if it ever happens.
          stackSkipReason = `unexpected outcome ${located.kind} from locateOrCloneRepo with allowClone=false`;
          break;
        default: {
          const _exhaustive: never = located;
          void _exhaustive;
        }
      }
    } else {
      stackSkipReason = '--skip-stack';
    }

    let runningContainers: ContainerSnapshot[] | null = null;
    if (repoPath) {
      runningContainers = await composePs({
        files: resolveComposeFiles(repoPath, opts.composeFile),
        cwd: repoPath,
        ...(opts.envFile ? { envFile: opts.envFile } : {}),
      });
    }

    p.note(
      [
        `Region:                ${pc.cyan(region)}`,
        `Repo path:             ${
          repoPath
            ? pc.cyan(repoPath)
            : pc.dim(`not used (${stackSkipReason ?? 'no repo path resolved'})`)
        }`,
        `Running containers:    ${
          runningContainers === null
            ? pc.dim('unknown')
            : runningContainers.length === 0
              ? pc.dim('none')
              : pc.cyan(`${runningContainers.length} listed by compose ps`)
        }`,
        `LaunchAgent plist:     ${plistExists ? pc.cyan(launchAgentPaths.plistFile) : pc.dim('not present')}`,
        `pgsodium key file:     ${keyFileExists ? pc.cyan(launchAgentPaths.keyFile) : pc.dim('not present')}`,
        `Registry to log out:   ${pc.cyan(opts.registry ?? GHCR_REGISTRY)}`,
        `Volume policy:         ${wipeData ? pc.red('WIPE') : pc.green('preserve (default)')}`,
        `Image policy:          ${wipeImages ? pc.red('WIPE (re-pull on next bootstrap)') : pc.green('keep (default)')}`,
        `Dry run:               ${opts.dryRun ? pc.yellow('yes') : pc.dim('no')}`,
      ].join('\n'),
      'Snapshot',
    );

    // ---- Confirmation gates ------------------------------------------
    if (wipeData && !opts.dryRun) {
      // Typed retype of the region label. Modeled on `terraform destroy`:
      // the operator must derive the resource identifier from context,
      // proving they actually know what they're destroying. We deliberately
      // do NOT pre-fill the placeholder with the answer — the friction is
      // the point. (review B2)
      unwrap(
        await p.text({
          message: pc.red(`Type the region label to confirm WIPING all volumes (the slug you'd use with --region):`),
          validate: (v) => (v === region ? undefined : `must match the region label exactly`),
        }),
      );
    } else if (!opts.dryRun && !opts.yes) {
      const cont = unwrap(
        await p.confirm({
          message: 'Proceed with reset? (volumes will be preserved)',
          initialValue: true,
        }),
      );
      if (!cont) {
        p.cancel('Cancelled.');
        process.exit(0);
      }
    }

    // ---- Build the runReset input -------------------------------------
    const stack = repoPath
      ? {
          repoPath,
          composeFiles: resolveComposeFiles(repoPath, opts.composeFile),
          wipeVolumes: wipeData,
          wipeImages,
          removeOrphans,
          ...(opts.envFile ? { envFile: opts.envFile } : {}),
        }
      : undefined;
    const launchAgent =
      plistExists && !opts.skipLaunchAgent
        ? {
            paths: launchAgentPaths,
            keepKeyFile: opts.keepKeyFile ?? false,
          }
        : undefined;
    const dockerLogoutInput = !opts.skipDockerLogout
      ? { registry: opts.registry ?? GHCR_REGISTRY }
      : undefined;

    // ---- Run ----------------------------------------------------------
    // Start a spinner per phase that will actually act (not skipped, not
    // dry-run). The phase name comes from RESET_PHASES so it can't drift
    // from runReset's emitted names. (review S4 / N7)
    const phaseSpins = new Map<ResetPhaseName, ReturnType<typeof p.spinner>>();
    const actingPhases: ResetPhaseName[] = [];
    if (stack && !opts.dryRun) actingPhases.push(RESET_PHASES.STOP_STACK);
    if (launchAgent && !opts.dryRun) actingPhases.push(RESET_PHASES.LAUNCH_AGENT);
    if (dockerLogoutInput && !opts.dryRun) actingPhases.push(RESET_PHASES.DOCKER_LOGOUT);
    for (const name of actingPhases) {
      const s = p.spinner();
      s.start(`${name}…`);
      phaseSpins.set(name, s);
    }

    const renderPhase = (ph: ResetPhase): void => {
      const spin = phaseSpins.get(ph.name as ResetPhaseName);
      const line = `${phaseIcon(ph)} ${ph.name}: ${pc.dim(ph.detail)}`;
      if (spin) {
        spin.stop(line);
        phaseSpins.delete(ph.name as ResetPhaseName);
      } else {
        p.log.info(line);
      }
    };

    const report = await runReset(
      {
        ...(stack ? { stack } : {}),
        ...(launchAgent ? { launchAgent } : {}),
        ...(dockerLogoutInput ? { dockerLogout: dockerLogoutInput } : {}),
        dryRun: opts.dryRun ?? false,
      },
      { ...DEFAULT_DEPS, onPhase: renderPhase },
    );

    // Belt-and-suspenders: stop any orphan spinners runReset didn't fire
    // onPhase for. Shouldn't happen given the constants-based wiring above.
    for (const [, spin] of phaseSpins) spin.stop(pc.dim('— skipped'));

    const failed = report.phases.filter((ph) => ph.status === 'fail').length;
    if (failed > 0) {
      p.outro(pc.red(`${failed} step${failed === 1 ? '' : 's'} failed.`));
      process.exit(1);
    } else if (opts.dryRun) {
      p.outro(pc.cyan('Dry run complete. Re-run without --dry-run to apply.'));
    } else {
      p.outro(
        pc.green(
          wipeData
            ? `Reset complete — volumes wiped. Re-run \`create-op-node bootstrap --region ${region}\` to start fresh.`
            : `Reset complete — volumes preserved. Re-run \`create-op-node bootstrap --region ${region}\` to bring the stack back up.`,
        ),
      );
    }
  });
