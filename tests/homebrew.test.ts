import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  detectBrew,
  HOMEBREW_INSTALL_COMMAND,
  installPackage,
  installPackages,
  isPackageInstalled,
  STUDIO_PACKAGES,
  type PackageSpec,
} from '../src/lib/homebrew.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('detectBrew', () => {
  it('returns installed=true + version when `brew --version` succeeds', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'Homebrew 4.4.10\nHomebrew/homebrew-core (git revision abc; last commit 2026-06-17)',
      stderr: '',
    });
    const r = await detectBrew();
    expect(r.installed).toBe(true);
    expect(r.version).toBe('Homebrew 4.4.10');
  });

  it('returns installed=false on ENOENT (no brew on PATH)', async () => {
    const err = Object.assign(new Error('spawn brew ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await detectBrew();
    expect(r).toEqual({ installed: false });
  });

  it('returns installed=false on non-zero exit', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: '?' });
    const r = await detectBrew();
    expect(r.installed).toBe(false);
  });
});

describe('STUDIO_PACKAGES + HOMEBREW_INSTALL_COMMAND', () => {
  it('lists every package the runbook installs on the Studio', () => {
    const names = STUDIO_PACKAGES.map((p) => p.name);
    expect(names).toEqual([
      'git',
      'gh',
      'pnpm',
      'jq',
      'cloudflared',
      'rclone',
      'ollama',
      'docker',
      'tailscale',
    ]);
  });

  it('marks docker + tailscale as casks (need GUI authorization)', () => {
    expect(STUDIO_PACKAGES.find((p) => p.name === 'docker')?.kind).toBe('cask');
    expect(STUDIO_PACKAGES.find((p) => p.name === 'tailscale')?.kind).toBe('cask');
  });

  it('HOMEBREW_INSTALL_COMMAND is the canonical one-liner', () => {
    expect(HOMEBREW_INSTALL_COMMAND).toContain('curl -fsSL');
    expect(HOMEBREW_INSTALL_COMMAND).toContain('Homebrew/install');
  });
});

describe('isPackageInstalled', () => {
  it('passes --formula flag for formulae', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await isPackageInstalled({ name: 'jq', kind: 'formula' });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['list', '--formula', 'jq']);
  });

  it('passes --cask flag for casks', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await isPackageInstalled({ name: 'docker', kind: 'cask' });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['list', '--cask', 'docker']);
  });

  it('returns true when exit 0', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    expect(await isPackageInstalled({ name: 'jq', kind: 'formula' })).toBe(true);
  });

  it('returns false when not installed (non-zero exit)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no such keg' });
    expect(await isPackageInstalled({ name: 'jq', kind: 'formula' })).toBe(false);
  });

  it('returns false when brew is missing entirely', async () => {
    const err = Object.assign(new Error('spawn brew ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    expect(await isPackageInstalled({ name: 'jq', kind: 'formula' })).toBe(false);
  });
});

describe('installPackage', () => {
  it('runs `brew install <name>` for formulae', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await installPackage({ name: 'jq', kind: 'formula' });
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['install', 'jq']);
  });

  it('runs `brew install --cask <name>` for casks', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await installPackage({ name: 'docker', kind: 'cask' });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['install', '--cask', 'docker']);
  });

  it('surfaces a clean error when brew is missing (ENOENT)', async () => {
    const err = Object.assign(new Error('spawn brew ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await installPackage({ name: 'jq', kind: 'formula' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not on PATH');
  });

  it('reports a clear reason on non-zero exit', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: cask docker conflicts',
    });
    const r = await installPackage({ name: 'docker', kind: 'cask' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('docker conflicts');
  });
});

describe('installPackages', () => {
  const PACKAGES: PackageSpec[] = [
    { name: 'git', kind: 'formula' },
    { name: 'jq', kind: 'formula' },
    { name: 'docker', kind: 'cask' },
  ];

  it('skips already-present packages and installs the rest', async () => {
    execaMock
      // git: list → exit 0 (present)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      // jq: list → exit 1 (absent), install → exit 0
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      // docker: list → exit 1 (absent), install → exit 0
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const report = await installPackages(PACKAGES);

    expect(report.alreadyPresent.map((p) => p.name)).toEqual(['git']);
    expect(report.installed.map((p) => p.name)).toEqual(['jq', 'docker']);
    expect(report.failed).toEqual([]);
  });

  it('continues past a failed install and reports it', async () => {
    execaMock
      // git: list → 1 (absent), install → 1 (failed)
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'install borked' })
      // jq: list → 0 (present)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      // docker: list → 1 (absent), install → 0
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const report = await installPackages(PACKAGES);

    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.pkg.name).toBe('git');
    expect(report.failed[0]?.reason).toContain('install borked');
    expect(report.installed.map((p) => p.name)).toEqual(['docker']);
    expect(report.alreadyPresent.map((p) => p.name)).toEqual(['jq']);
  });

  it('emits per-package status callbacks in the right order', async () => {
    execaMock
      // git: list → 0 (present)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const seen: Array<[string, string]> = [];
    await installPackages([{ name: 'git', kind: 'formula' }], (pkg, status) =>
      seen.push([pkg.name, status]),
    );

    expect(seen).toEqual([
      ['git', 'checking'],
      ['git', 'present'],
    ]);
  });
});
