import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  assessHealth,
  composeDown,
  composePs,
  composePull,
  composeRemoveService,
  composeUp,
  dockerLogout,
  GHCR_REGISTRY,
  loginToGhcr,
  parseComposePs,
  waitForHealthy,
  type ContainerSnapshot,
  type WaitForHealthyDeps,
} from '../src/lib/docker.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('loginToGhcr', () => {
  it('three calls in sequence: gh auth token → gh api user → docker login', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ghp_xyz\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'octocat\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'Login Succeeded\n', stderr: '' });

    const r = await loginToGhcr();
    expect(r.ok).toBe(true);

    const dockerCall = execaMock.mock.calls[2] as [string, string[], { input: string }];
    expect(dockerCall[0]).toBe('docker');
    expect(dockerCall[1]).toEqual(['login', GHCR_REGISTRY, '-u', 'octocat', '--password-stdin']);
    // Token MUST go via stdin, never argv.
    expect(dockerCall[1]).not.toContain('ghp_xyz');
    expect(dockerCall[2].input).toBe('ghp_xyz');
  });

  it("reports 'gh not installed' on ENOENT at the token step", async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await loginToGhcr();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not installed');
  });

  it("reports 'gh not signed in' when gh auth token is empty", async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '\n', stderr: '' });
    const r = await loginToGhcr();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('gh auth login');
  });

  it('reports docker login failure with stderr', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'ghp_xyz\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'octocat\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'denied: invalid token' });

    const r = await loginToGhcr();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('denied: invalid token');
  });
});

describe('composePull / composeUp', () => {
  it('composePull builds `docker compose -f X -f Y pull`', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const r = await composePull({ files: ['a.yml', 'b.yml'], cwd: '/tmp' });
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', '-f', 'b.yml', 'pull']);
  });

  it('composeUp adds --remove-orphans', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    await composeUp({ files: ['a.yml'], cwd: '/tmp' });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'up', '-d', '--remove-orphans']);
  });

  it('includes --env-file when supplied', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeUp({
      files: ['a.yml'],
      cwd: '/tmp',
      envFile: '.env.prod',
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', '--env-file', '.env.prod', 'up', '-d', '--remove-orphans']);
  });

  it('inserts --profile flags between files and the subcommand', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeUp({
      files: ['a.yml'],
      cwd: '/tmp',
      profiles: ['public', 'observability'],
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      'compose', '-f', 'a.yml',
      '--profile', 'public', '--profile', 'observability',
      'up', '-d', '--remove-orphans',
    ]);
  });

  it('omits --profile flags entirely when profiles is empty / absent (local-only)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeUp({ files: ['a.yml'], cwd: '/tmp', profiles: [] });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).not.toContain('--profile');
  });

  it('reports clean reason when docker is missing', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await composePull({ files: ['a.yml'], cwd: '/tmp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not installed');
  });
});

describe('composeDown', () => {
  it('builds `docker compose -f X down` without -v by default', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await composeDown({ files: ['a.yml'], cwd: '/tmp' });
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'down']);
    expect(args).not.toContain('-v');
  });

  it('adds -v when wipeVolumes is true', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeDown({ files: ['a.yml'], cwd: '/tmp', wipeVolumes: true });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'down', '-v']);
  });

  it('adds --remove-orphans when removeOrphans is true', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeDown({
      files: ['a.yml'],
      cwd: '/tmp',
      wipeVolumes: true,
      removeOrphans: true,
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'down', '-v', '--remove-orphans']);
  });

  it('labels the failure reason "compose down -v" when wipeVolumes was set', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'volume in use' });
    const r = await composeDown({ files: ['a.yml'], cwd: '/tmp', wipeVolumes: true });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('compose down -v');
    expect(r.reason).toContain('volume in use');
  });

  it('adds --rmi all when removeImages: "all"', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeDown({
      files: ['a.yml'],
      cwd: '/tmp',
      wipeVolumes: true,
      removeImages: 'all',
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'down', '-v', '--rmi', 'all']);
  });

  it('adds --rmi local when removeImages: "local"', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeDown({
      files: ['a.yml'],
      cwd: '/tmp',
      removeImages: 'local',
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'down', '--rmi', 'local']);
  });

  it('labels the failure reason with --rmi mode when removeImages is set', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'image in use' });
    const r = await composeDown({
      files: ['a.yml'],
      cwd: '/tmp',
      wipeVolumes: true,
      removeImages: 'all',
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('compose down -v --rmi all');
    expect(r.reason).toContain('image in use');
  });
});

describe('composeRemoveService', () => {
  it('builds `docker compose -f X rm -sfv <service>`', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await composeRemoveService({ files: ['a.yml'], cwd: '/tmp' }, 'cloudflared');
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['compose', '-f', 'a.yml', 'rm', '-sfv', 'cloudflared']);
  });

  it('passes through env-file + profiles in the args order', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await composeRemoveService(
      {
        files: ['a.yml'],
        cwd: '/tmp',
        envFile: '.env.prod',
        profiles: ['public'],
      },
      'cloudflared',
    );
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      'compose', '-f', 'a.yml',
      '--env-file', '.env.prod',
      '--profile', 'public',
      'rm', '-sfv', 'cloudflared',
    ]);
  });

  it('reports failure cleanly', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no such service' });
    const r = await composeRemoveService({ files: ['a.yml'], cwd: '/tmp' }, 'nope');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('compose rm nope');
    expect(r.reason).toContain('no such service');
  });
});

describe('dockerLogout', () => {
  it('shells out to `docker logout ghcr.io` by default', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await dockerLogout();
    expect(r.ok).toBe(true);
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('docker');
    expect(args).toEqual(['logout', 'ghcr.io']);
  });

  it('accepts an override registry', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await dockerLogout('registry.example.org');
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['logout', 'registry.example.org']);
  });

  it('reports docker missing cleanly', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await dockerLogout();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not installed');
  });
});

describe('parseComposePs', () => {
  it('handles NDJSON (one object per line — compose v2 default)', () => {
    const stdout = [
      JSON.stringify({ Name: 'api', State: 'running', Health: 'healthy' }),
      JSON.stringify({ Name: 'db', State: 'running', Health: 'starting' }),
    ].join('\n');
    const snaps = parseComposePs(stdout);
    expect(snaps).toEqual([
      { name: 'api', state: 'running', health: 'healthy', exitCode: null },
      { name: 'db', state: 'running', health: 'starting', exitCode: null },
    ]);
  });

  it('handles a single-line JSON array (older compose versions)', () => {
    const stdout = JSON.stringify([
      { Name: 'api', State: 'running', Health: 'healthy' },
    ]);
    const snaps = parseComposePs(stdout);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]?.name).toBe('api');
  });

  it('normalizes ExitCode for one-shot containers like db-migrate', () => {
    const stdout = JSON.stringify({ Name: 'db-migrate', State: 'exited', ExitCode: 0 });
    const snaps = parseComposePs(stdout);
    expect(snaps[0]?.exitCode).toBe(0);
    expect(snaps[0]?.state).toBe('exited');
  });

  it('returns [] for empty output', () => {
    expect(parseComposePs('')).toEqual([]);
  });

  it('skips non-JSON lines (warnings interleaved on stdout)', () => {
    const stdout =
      'Warning: some compose warning\n' +
      JSON.stringify({ Name: 'api', State: 'running', Health: 'healthy' });
    const snaps = parseComposePs(stdout);
    expect(snaps).toHaveLength(1);
  });

  it("classifies missing Health as 'none'", () => {
    const stdout = JSON.stringify({ Name: 'redis', State: 'running' });
    const snaps = parseComposePs(stdout);
    expect(snaps[0]?.health).toBe('none');
  });
});

describe('composePs', () => {
  it('returns null when docker compose ps fails (distinguishes from empty)', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'compose not found',
    });
    const snaps = await composePs({ files: ['a.yml'], cwd: '/tmp' });
    expect(snaps).toBeNull();
  });

  it('returns [] when ps succeeds but no containers are listed yet', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '',
      stderr: '',
    });
    const snaps = await composePs({ files: ['a.yml'], cwd: '/tmp' });
    expect(snaps).toEqual([]);
  });
});

describe('assessHealth', () => {
  const make = (over: Partial<ContainerSnapshot>): ContainerSnapshot => ({
    name: 'x',
    state: 'running',
    health: 'healthy',
    exitCode: null,
    ...over,
  });

  it("returns 'healthy' when every container is happy", () => {
    const r = assessHealth([
      make({ name: 'api', state: 'running', health: 'healthy' }),
      make({ name: 'db-migrate', state: 'exited', exitCode: 0, health: 'none' }),
    ]);
    expect(r.kind).toBe('healthy');
  });

  it("returns 'unhealthy' if any container reports unhealthy", () => {
    const r = assessHealth([
      make({ name: 'api', health: 'unhealthy' }),
    ]);
    expect(r.kind).toBe('unhealthy');
    expect(r.problem).toContain('api');
  });

  it("returns 'unhealthy' if any container exited non-zero", () => {
    const r = assessHealth([
      make({ name: 'db-migrate', state: 'exited', exitCode: 1, health: 'none' }),
    ]);
    expect(r.kind).toBe('unhealthy');
    expect(r.problem).toContain('code 1');
  });

  it("returns 'pending' while any required container is still starting", () => {
    const r = assessHealth(
      [
        make({ name: 'api', state: 'running', health: 'starting' }),
        make({ name: 'redis', state: 'running', health: 'healthy' }),
      ],
      ['api', 'redis'],
    );
    expect(r.kind).toBe('pending');
  });

  it("returns 'pending' when a required container isn't in the snapshot list yet", () => {
    const r = assessHealth(
      [make({ name: 'redis', state: 'running', health: 'healthy' })],
      ['api', 'redis'],
    );
    expect(r.kind).toBe('pending');
  });

  it('treats `none` health as fine when state is running', () => {
    const r = assessHealth([
      make({ name: 'cloudflared', state: 'running', health: 'none' }),
    ]);
    expect(r.kind).toBe('healthy');
  });
});

describe('waitForHealthy', () => {
  it('returns healthy when the very first ps says so', async () => {
    const deps: WaitForHealthyDeps = {
      ps: vi.fn().mockResolvedValue([
        { name: 'api', state: 'running', health: 'healthy', exitCode: null },
      ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
    };
    const r = await waitForHealthy(
      { files: ['a.yml'], cwd: '/tmp' },
      { timeoutMs: 1000, pollMs: 100 },
      deps,
    );
    expect(r.kind).toBe('healthy');
  });

  it('returns timeout when stuck in starting past the budget', async () => {
    let now = 0;
    const deps: WaitForHealthyDeps = {
      ps: vi
        .fn()
        .mockResolvedValue([
          { name: 'api', state: 'running', health: 'starting', exitCode: null },
        ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => (now += 200),
    };
    const r = await waitForHealthy(
      { files: ['a.yml'], cwd: '/tmp' },
      { timeoutMs: 500, pollMs: 100 },
      deps,
    );
    expect(r.kind).toBe('timeout');
  });

  it('returns unhealthy fast when a container reports unhealthy mid-loop', async () => {
    const deps: WaitForHealthyDeps = {
      ps: vi
        .fn()
        .mockResolvedValueOnce([
          { name: 'api', state: 'running', health: 'starting', exitCode: null },
        ])
        .mockResolvedValueOnce([
          { name: 'api', state: 'running', health: 'unhealthy', exitCode: null },
        ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
    };
    const r = await waitForHealthy(
      { files: ['a.yml'], cwd: '/tmp' },
      { timeoutMs: 1000, pollMs: 10 },
      deps,
    );
    expect(r.kind).toBe('unhealthy');
  });

  it('emits onPoll callbacks with the snapshot list each tick', async () => {
    const snaps: ContainerSnapshot[][] = [];
    const deps: WaitForHealthyDeps = {
      ps: vi.fn().mockResolvedValue([
        { name: 'api', state: 'running', health: 'healthy', exitCode: null },
      ]),
      sleep: vi.fn().mockResolvedValue(undefined),
      now: () => 0,
    };
    await waitForHealthy(
      { files: ['a.yml'], cwd: '/tmp' },
      { timeoutMs: 1000, pollMs: 100, onPoll: (s) => snaps.push(s) },
      deps,
    );
    expect(snaps.length).toBe(1);
    expect(snaps[0]?.[0]?.name).toBe('api');
  });
});
