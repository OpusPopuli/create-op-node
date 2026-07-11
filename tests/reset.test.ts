import { describe, expect, it, vi } from 'vitest';

import {
  buildResetInput,
  RESET_COMPOSE_ENV,
  RESET_PHASES,
  runReset,
  type ResetDeps,
  type ResetInput,
  type ResetPhase,
} from '../src/commands/reset.js';

function depsFor(overrides: Partial<ResetDeps> = {}): ResetDeps {
  return {
    composeDown: vi.fn(() => Promise.resolve({ ok: true })),
    teardownLaunchAgent: vi.fn(() =>
      Promise.resolve({
        ok: true,
        steps: [
          { step: 'unload' as const, ok: true },
          { step: 'rm-plist' as const, ok: true },
          { step: 'rm-key-file' as const, ok: true },
        ],
      }),
    ),
    dockerLogout: vi.fn(() => Promise.resolve({ ok: true })),
    ...overrides,
  };
}

const fullInput = (): ResetInput => ({
  stack: {
    repoPath: '/repo',
    composeFiles: ['/repo/docker-compose-prod.yml'],
    wipeVolumes: false,
    wipeImages: false,
    removeOrphans: true,
  },
  launchAgent: {
    paths: { keyFile: '/k', plistFile: '/p.plist' },
    keepKeyFile: false,
  },
  dockerLogout: { registry: 'ghcr.io' },
  dryRun: false,
});

describe('RESET_PHASES', () => {
  it('exports stable phase names', () => {
    expect(RESET_PHASES).toEqual({
      STOP_STACK: 'Stop stack',
      LAUNCH_AGENT: 'LaunchAgent',
      DOCKER_LOGOUT: 'docker logout',
    });
  });
});

describe('buildResetInput', () => {
  const paths = { keyFile: '/k', plistFile: '/p.plist' };
  const base = {
    opts: {},
    repoPath: undefined as string | undefined,
    plistExists: false,
    launchAgentPaths: paths,
    wipeData: false,
    wipeImages: false,
    removeOrphans: true,
  };

  it('includes the stack (with resolved compose files) when a repo path is present', () => {
    const input = buildResetInput({
      ...base,
      repoPath: '/repo',
      wipeData: true,
      wipeImages: true,
    });
    expect(input.stack).toEqual({
      repoPath: '/repo',
      composeFiles: ['/repo/docker-compose-prod.yml'],
      wipeVolumes: true,
      wipeImages: true,
      removeOrphans: true,
    });
  });

  it('omits the stack when no repo path is resolved', () => {
    expect(buildResetInput({ ...base, repoPath: undefined }).stack).toBeUndefined();
  });

  it('includes the LaunchAgent only when the plist exists and it is not skipped', () => {
    expect(buildResetInput({ ...base, plistExists: true }).launchAgent).toEqual({
      paths,
      keepKeyFile: false,
    });
    expect(buildResetInput({ ...base, plistExists: false }).launchAgent).toBeUndefined();
    expect(
      buildResetInput({ ...base, plistExists: true, opts: { skipLaunchAgent: true } }).launchAgent,
    ).toBeUndefined();
  });

  it('honors --keep-key-file', () => {
    const input = buildResetInput({ ...base, plistExists: true, opts: { keepKeyFile: true } });
    expect(input.launchAgent?.keepKeyFile).toBe(true);
  });

  it('includes docker-logout with the default registry unless skipped', () => {
    expect(buildResetInput(base).dockerLogout).toEqual({ registry: 'ghcr.io' });
    expect(
      buildResetInput({ ...base, opts: { registry: 'registry.example.com' } }).dockerLogout,
    ).toEqual({ registry: 'registry.example.com' });
    expect(buildResetInput({ ...base, opts: { skipDockerLogout: true } }).dockerLogout).toBeUndefined();
  });

  it('defaults dryRun to false when the flag is absent', () => {
    expect(buildResetInput(base).dryRun).toBe(false);
    expect(buildResetInput({ ...base, opts: { dryRun: true } }).dryRun).toBe(true);
  });
});

describe('runReset', () => {
  it('runs all three phases on a clean default reset', async () => {
    const deps = depsFor();
    const report = await runReset(fullInput(), deps);
    expect(report.phases.map((ph) => ph.name)).toEqual([
      RESET_PHASES.STOP_STACK,
      RESET_PHASES.LAUNCH_AGENT,
      RESET_PHASES.DOCKER_LOGOUT,
    ]);
    expect(report.phases.every((ph) => ph.status === 'ok')).toBe(true);
    expect(deps.composeDown).toHaveBeenCalledTimes(1);
    expect(deps.teardownLaunchAgent).toHaveBeenCalledTimes(1);
    expect(deps.dockerLogout).toHaveBeenCalledTimes(1);
  });

  it('passes wipeVolumes + removeOrphans through to composeDown', async () => {
    const deps = depsFor();
    const input = fullInput();
    input.stack!.wipeVolumes = true;
    input.stack!.removeOrphans = false;
    await runReset(input, deps);
    expect(deps.composeDown).toHaveBeenCalledWith(
      expect.objectContaining({ wipeVolumes: true, removeOrphans: false }),
    );
  });

  it('passes inert interpolation values to composeDown without loading real secrets', async () => {
    const deps = depsFor();
    await runReset(fullInput(), deps);
    expect(deps.composeDown).toHaveBeenCalledWith(
      expect.objectContaining({ env: RESET_COMPOSE_ENV }),
    );
    expect(Object.keys(RESET_COMPOSE_ENV)).toEqual(expect.arrayContaining([
      'POSTGRES_PASSWORD',
      'JWT_SECRET',
      'PGSODIUM_ROOT_KEY',
      'PROMPTS_DB_PASSWORD',
      'PROMPT_SERVICE_API_KEY',
      'BACKUPS_DIR_HOST',
    ]));
    expect(new Set(Object.values(RESET_COMPOSE_ENV))).toEqual(
      new Set(['reset-interpolation-only', process.cwd()]),
    );
  });

  it('detail line distinguishes wipe vs preserve in Stop stack phase', async () => {
    const wipe = fullInput();
    wipe.stack!.wipeVolumes = true;
    const reportW = await runReset(wipe, depsFor());
    const reportP = await runReset(fullInput(), depsFor());
    expect(reportW.phases.find((ph) => ph.name === RESET_PHASES.STOP_STACK)?.detail).toContain('destroyed');
    expect(reportP.phases.find((ph) => ph.name === RESET_PHASES.STOP_STACK)?.detail).toContain('preserved');
  });

  it('passes removeImages: "all" through to composeDown when wipeImages is set', async () => {
    const deps = depsFor();
    const input = fullInput();
    input.stack!.wipeImages = true;
    input.stack!.wipeVolumes = true; // CLI enforces this combo
    await runReset(input, deps);
    expect(deps.composeDown).toHaveBeenCalledWith(
      expect.objectContaining({ removeImages: 'all' }),
    );
  });

  it('omits removeImages when wipeImages is false', async () => {
    const deps = depsFor();
    await runReset(fullInput(), deps);
    const call = (deps.composeDown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as object;
    expect(call).not.toHaveProperty('removeImages');
  });

  it('detail mentions images removed when wipeImages is set', async () => {
    const input = fullInput();
    input.stack!.wipeImages = true;
    input.stack!.wipeVolumes = true;
    const report = await runReset(input, depsFor());
    const detail = report.phases.find((ph) => ph.name === RESET_PHASES.STOP_STACK)?.detail;
    expect(detail).toContain('images removed');
  });

  it('dry-run detail shows --rmi all when wipeImages set', async () => {
    const input = fullInput();
    input.dryRun = true;
    input.stack!.wipeImages = true;
    input.stack!.wipeVolumes = true;
    const report = await runReset(input, depsFor());
    expect(report.phases.find((ph) => ph.name === RESET_PHASES.STOP_STACK)?.detail).toContain('--rmi all');
  });

  it('skips Stop stack when input.stack is undefined', async () => {
    const deps = depsFor();
    const input = fullInput();
    delete (input as Partial<ResetInput>).stack;
    const report = await runReset(input as ResetInput, deps);
    const ph = report.phases.find((p) => p.name === RESET_PHASES.STOP_STACK);
    expect(ph?.status).toBe('skipped');
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('skips LaunchAgent when input.launchAgent is undefined', async () => {
    const deps = depsFor();
    const input = fullInput();
    delete (input as Partial<ResetInput>).launchAgent;
    const report = await runReset(input as ResetInput, deps);
    expect(report.phases.find((ph) => ph.name === RESET_PHASES.LAUNCH_AGENT)?.status).toBe('skipped');
    expect(deps.teardownLaunchAgent).not.toHaveBeenCalled();
  });

  it('passes keepKeyFile through to teardownLaunchAgent', async () => {
    const deps = depsFor();
    const input = fullInput();
    input.launchAgent!.keepKeyFile = true;
    await runReset(input, deps);
    expect(deps.teardownLaunchAgent).toHaveBeenCalledWith(
      input.launchAgent!.paths,
      { keepKeyFile: true },
    );
  });

  it('detail omits rm-key-file when keepKeyFile=true (review S5)', async () => {
    const deps = depsFor({
      teardownLaunchAgent: vi.fn(() =>
        Promise.resolve({
          ok: true,
          steps: [
            { step: 'unload' as const, ok: true },
            { step: 'rm-plist' as const, ok: true },
            // No rm-key-file step because keepKeyFile=true upstream.
          ],
        }),
      ),
    });
    const input = fullInput();
    input.launchAgent!.keepKeyFile = true;
    const report = await runReset(input, deps);
    const detail = report.phases.find((ph) => ph.name === RESET_PHASES.LAUNCH_AGENT)?.detail;
    expect(detail).toContain('rm-plist');
    expect(detail).not.toContain('rm-key-file');
  });

  it('reports docker logout as warn (not fail) on non-zero exit', async () => {
    const deps = depsFor({
      dockerLogout: vi.fn(() => Promise.resolve({ ok: false, reason: 'not logged in' })),
    });
    const report = await runReset(fullInput(), deps);
    const ph = report.phases.find((p) => p.name === RESET_PHASES.DOCKER_LOGOUT);
    expect(ph?.status).toBe('warn');
    expect(ph?.detail).toContain('not logged in');
  });

  it('passes the registry through to dockerLogout', async () => {
    const deps = depsFor();
    const input = fullInput();
    input.dockerLogout = { registry: 'private.registry.example' };
    await runReset(input, deps);
    expect(deps.dockerLogout).toHaveBeenCalledWith('private.registry.example');
  });

  it('reports composeDown failure as fail and surfaces reason', async () => {
    const deps = depsFor({
      composeDown: vi.fn(() => Promise.resolve({ ok: false, reason: 'volume in use' })),
    });
    const report = await runReset(fullInput(), deps);
    const ph = report.phases.find((p) => p.name === RESET_PHASES.STOP_STACK);
    expect(ph?.status).toBe('fail');
    expect(ph?.detail).toContain('volume in use');
  });

  it('preserves the LaunchAgent after compose failure but still runs docker logout', async () => {
    const deps = depsFor({
      composeDown: vi.fn(() => Promise.resolve({ ok: false, reason: 'boom' })),
    });
    const report = await runReset(fullInput(), deps);
    expect(deps.teardownLaunchAgent).not.toHaveBeenCalled();
    expect(report.phases.find((ph) => ph.name === RESET_PHASES.LAUNCH_AGENT)).toMatchObject({
      status: 'warn',
      detail: expect.stringContaining('stack could still be running'),
    });
    expect(deps.dockerLogout).toHaveBeenCalledTimes(1);
  });

  it('reports LaunchAgent failure with the offending step name', async () => {
    const deps = depsFor({
      teardownLaunchAgent: vi.fn(() =>
        Promise.resolve({
          ok: false,
          steps: [
            { step: 'unload' as const, ok: true },
            { step: 'rm-plist' as const, ok: false, reason: 'permission denied' },
          ],
        }),
      ),
    });
    const report = await runReset(fullInput(), deps);
    const ph = report.phases.find((p) => p.name === RESET_PHASES.LAUNCH_AGENT);
    expect(ph?.status).toBe('fail');
    expect(ph?.detail).toContain('rm-plist');
    expect(ph?.detail).toContain('permission denied');
  });

  it('dry-run reports planned actions without calling deps', async () => {
    const deps = depsFor();
    const input = fullInput();
    input.dryRun = true;
    input.stack!.wipeVolumes = true;
    const report = await runReset(input, deps);
    expect(deps.composeDown).not.toHaveBeenCalled();
    expect(deps.teardownLaunchAgent).not.toHaveBeenCalled();
    expect(deps.dockerLogout).not.toHaveBeenCalled();
    expect(report.phases.every((ph) => ph.status === 'dry-run' || ph.status === 'skipped')).toBe(true);
    expect(report.phases.find((p) => p.name === RESET_PHASES.STOP_STACK)?.detail).toContain('down -v');
  });

  it('dry-run detail line includes --remove-orphans when set', async () => {
    const input = fullInput();
    input.dryRun = true;
    input.stack!.removeOrphans = true;
    const report = await runReset(input, depsFor());
    expect(report.phases.find((p) => p.name === RESET_PHASES.STOP_STACK)?.detail).toContain('--remove-orphans');
  });

  it('skips docker logout when input.dockerLogout is undefined', async () => {
    const deps = depsFor();
    const input = fullInput();
    delete (input as Partial<ResetInput>).dockerLogout;
    const report = await runReset(input as ResetInput, deps);
    expect(report.phases.find((p) => p.name === RESET_PHASES.DOCKER_LOGOUT)?.status).toBe('skipped');
    expect(deps.dockerLogout).not.toHaveBeenCalled();
  });

  it('fires onPhase in order, once per phase', async () => {
    const seen: ResetPhase[] = [];
    const deps = depsFor({ onPhase: (ph) => seen.push(ph) });
    const report = await runReset(fullInput(), deps);
    expect(seen).toHaveLength(report.phases.length);
    expect(seen.map((p) => p.name)).toEqual(report.phases.map((p) => p.name));
  });
});
