import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  disableDiskSleep,
  enableAutoRestartOnPowerFailure,
  inspectSystem,
  parseFileVault,
  parsePmsetBool,
} from '../src/lib/macos.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('parsePmsetBool', () => {
  const SAMPLE = [
    'System-wide power settings:',
    'Currently in use:',
    '  lidwake              1',
    '  autorestart          1',
    '  disksleep            0',
    '  sleep                30',
  ].join('\n');

  it('finds autorestart=1', () => {
    expect(parsePmsetBool(SAMPLE, 'autorestart', 1)).toBe(true);
  });

  it('finds disksleep=0', () => {
    expect(parsePmsetBool(SAMPLE, 'disksleep', 0)).toBe(true);
  });

  it('returns false when the expected value does NOT match', () => {
    expect(parsePmsetBool(SAMPLE, 'autorestart', 0)).toBe(false);
    expect(parsePmsetBool(SAMPLE, 'disksleep', 1)).toBe(false);
  });

  it('returns false when the key is absent entirely', () => {
    expect(parsePmsetBool(SAMPLE, 'nosuchkey', 1)).toBe(false);
  });

  it('tolerates extra whitespace + odd indentation', () => {
    expect(parsePmsetBool('   autorestart   1   ', 'autorestart', 1)).toBe(true);
  });
});

describe('parseFileVault', () => {
  it('recognizes "On"', () => {
    expect(parseFileVault('FileVault is On.')).toBe(true);
  });

  it('recognizes "Off"', () => {
    expect(parseFileVault('FileVault is Off.')).toBe(false);
  });

  it('treats in-progress encryption as on (still protecting data)', () => {
    expect(parseFileVault('Encryption in progress: 42%')).toBe(true);
  });

  it("returns 'unknown' on an unexpected output", () => {
    expect(parseFileVault('???')).toBe('unknown');
    expect(parseFileVault('')).toBe('unknown');
  });
});

describe('inspectSystem', () => {
  it('returns a snapshot stitched from five probes', async () => {
    execaMock
      // hostname
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'op-prod-01.local\n', stderr: '' })
      // sw_vers -productVersion
      .mockResolvedValueOnce({ exitCode: 0, stdout: '15.2\n', stderr: '' })
      // pmset -g
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: '  autorestart  1\n  disksleep  0\n',
        stderr: '',
      })
      // fdesetup status
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'FileVault is Off.\n', stderr: '' })
      // uname -m
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'arm64\n', stderr: '' });

    const snap = await inspectSystem();
    expect(snap).toEqual({
      hostname: 'op-prod-01.local',
      osVersion: '15.2',
      autoRestartOnPowerFailure: true,
      diskSleepDisabled: true,
      fileVaultEnabled: false,
      isAppleSilicon: true,
    });
  });

  it('osVersion is null when sw_vers fails', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'h\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'sw_vers oops' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'FileVault is On.\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'arm64\n', stderr: '' });

    const snap = await inspectSystem();
    expect(snap.osVersion).toBeNull();
    expect(snap.fileVaultEnabled).toBe(true);
  });

  it('flags Intel Macs as isAppleSilicon=false (so the wizard can refuse)', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'h\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '15.2\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'FileVault is Off.\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'x86_64\n', stderr: '' });

    const snap = await inspectSystem();
    expect(snap.isAppleSilicon).toBe(false);
  });

  it('tolerates a missing binary (ENOENT) — null result becomes a sensible default', async () => {
    const err = Object.assign(new Error('spawn hostname ENOENT'), { code: 'ENOENT' });
    execaMock
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '15.2\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '???\n', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'arm64\n', stderr: '' });

    const snap = await inspectSystem();
    expect(snap.hostname).toBe('unknown');
    expect(snap.fileVaultEnabled).toBe('unknown');
  });
});

describe('enableAutoRestartOnPowerFailure', () => {
  it('shells out to `sudo pmset -a autorestart 1`', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const r = await enableAutoRestartOnPowerFailure();
    expect(r.ok).toBe(true);
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('sudo');
    expect(args).toEqual(['pmset', '-a', 'autorestart', '1']);
  });

  it('reports a clear reason on non-zero exit', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'pmset: error',
    });
    const r = await enableAutoRestartOnPowerFailure();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('pmset: error');
  });

  it('reports a clear reason when sudo itself is unavailable (ENOENT)', async () => {
    const err = Object.assign(new Error('spawn sudo ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await enableAutoRestartOnPowerFailure();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('sudo');
  });
});

describe('disableDiskSleep', () => {
  it('shells out to `sudo pmset -a disksleep 0`', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await disableDiskSleep();
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['pmset', '-a', 'disksleep', '0']);
  });
});
