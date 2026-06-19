import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  defaultPaths,
  LAUNCH_AGENT_LABEL,
  loadLaunchAgent,
  renderLaunchAgentPlist,
  setupLaunchAgent,
  teardownLaunchAgent,
  writeLaunchAgentPlist,
  writePgsodiumKeyFile,
} from '../src/lib/launchagent.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

const VALID_KEY = 'a'.repeat(64);
const VALID_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.dummy.token';

describe('defaultPaths', () => {
  it('puts the key under ~/.config/opuspopuli/ and the plist in ~/Library/LaunchAgents/', () => {
    const paths = defaultPaths('/Users/op');
    expect(paths.keyFile).toBe('/Users/op/.config/opuspopuli/pgsodium_root_key');
    expect(paths.plistFile).toBe(`/Users/op/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist`);
  });
});

describe('renderLaunchAgentPlist', () => {
  it('emits a valid plist with both env vars and Label set', () => {
    const out = renderLaunchAgentPlist({
      keyFilePath: '/Users/op/.config/opuspopuli/pgsodium_root_key',
      tunnelToken: VALID_TOKEN,
    });
    expect(out).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(out).toContain(`<string>${LAUNCH_AGENT_LABEL}</string>`);
    expect(out).toContain('launchctl setenv PGSODIUM_ROOT_KEY');
    expect(out).toContain('launchctl setenv TUNNEL_TOKEN');
    expect(out).toContain(VALID_TOKEN);
    expect(out).toContain('<key>RunAtLoad</key><true/>');
  });

  it('refuses a tunnel token with XML-unsafe characters', () => {
    expect(() =>
      renderLaunchAgentPlist({
        keyFilePath: '/k',
        tunnelToken: 'has<>special&chars',
      }),
    ).toThrow(/base64-url/);
  });

  it('refuses a keyFilePath with shell metacharacters (injection guard)', () => {
    for (const evil of [
      '/tmp/key;rm -rf $HOME',
      '/tmp/key$(echo pwned)',
      '/tmp/key`whoami`',
      '/tmp/key"quoted"',
      '/tmp/key\nnewline',
    ]) {
      expect(() =>
        renderLaunchAgentPlist({ keyFilePath: evil, tunnelToken: VALID_TOKEN }),
      ).toThrow(/launchd path interpolation/);
    }
  });

  it('accepts realistic keyFilePaths (the defaults the runbook documents)', () => {
    expect(() =>
      renderLaunchAgentPlist({
        keyFilePath: '/Users/op/.config/opuspopuli/pgsodium_root_key',
        tunnelToken: VALID_TOKEN,
      }),
    ).not.toThrow();
  });

  it('inlines the key file path (read at agent load via cat)', () => {
    const out = renderLaunchAgentPlist({
      keyFilePath: '/some/path/key',
      tunnelToken: VALID_TOKEN,
    });
    expect(out).toContain('cat /some/path/key');
  });
});

describe('writePgsodiumKeyFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'op-keyfile-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a 64-byte file at mode 0400', async () => {
    const target = join(dir, 'sub', 'pgsodium_root_key');
    const r = await writePgsodiumKeyFile(VALID_KEY, target);
    expect(r.ok).toBe(true);

    const contents = await readFile(target, 'utf8');
    expect(contents).toBe(VALID_KEY);

    const st = await stat(target);
    // On macOS/Linux mode bits include type; mask to perms.
    expect(st.mode & 0o777).toBe(0o400);
  });

  it('rejects a key that is not 64 lowercase hex', async () => {
    const target = join(dir, 'key');
    const r = await writePgsodiumKeyFile('not-hex', target);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('64 lowercase hex');
  });

  it('rejects a key with uppercase hex', async () => {
    const target = join(dir, 'key');
    const r = await writePgsodiumKeyFile('A'.repeat(64), target);
    expect(r.ok).toBe(false);
  });
});

describe('writeLaunchAgentPlist', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'op-plist-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the plist contents at mode 0600', async () => {
    const target = join(dir, 'LaunchAgents', 'org.opuspopuli.envloader.plist');
    const content = '<?xml version="1.0"?>\n<plist/>\n';
    const r = await writeLaunchAgentPlist(target, content);
    expect(r.ok).toBe(true);

    const read = await readFile(target, 'utf8');
    expect(read).toBe(content);

    const st = await stat(target);
    expect(st.mode & 0o777).toBe(0o600);
  });
});

describe('loadLaunchAgent', () => {
  it('unloads then loads, ignoring unload errors', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not loaded' }) // unload — ignored
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // load — ok

    const r = await loadLaunchAgent('/some/plist');
    expect(r.ok).toBe(true);
    expect(execaMock).toHaveBeenCalledTimes(2);
    expect((execaMock.mock.calls[0] as [string, string[]])[1]).toContain('unload');
    expect((execaMock.mock.calls[1] as [string, string[]])[1]).toContain('load');
  });

  it('reports a clear reason when load itself fails', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'plist invalid' });

    const r = await loadLaunchAgent('/some/plist');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('plist invalid');
  });

  it('reports launchctl-missing on ENOENT', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock
      .mockRejectedValueOnce(err) // unload — null result
      .mockRejectedValueOnce(err); // load — null result

    const r = await loadLaunchAgent('/some/plist');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('launchctl');
  });
});

describe('setupLaunchAgent', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'op-setup-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('runs all three steps and reports ok on success', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not loaded' }) // unload
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }); // load

    const paths = {
      keyFile: join(dir, '.config/opuspopuli/pgsodium_root_key'),
      plistFile: join(dir, 'Library/LaunchAgents/org.opuspopuli.envloader.plist'),
    };
    const r = await setupLaunchAgent({
      pgsodiumKey: VALID_KEY,
      tunnelToken: VALID_TOKEN,
      paths,
    });
    expect(r.ok).toBe(true);

    // Files should exist with the right contents + modes.
    const key = await readFile(paths.keyFile, 'utf8');
    expect(key).toBe(VALID_KEY);
    const plist = await readFile(paths.plistFile, 'utf8');
    expect(plist).toContain(VALID_TOKEN);
    expect(plist).toContain(paths.keyFile);
  });

  it('reports step=key-file when the pgsodium write fails', async () => {
    const r = await setupLaunchAgent({
      pgsodiumKey: 'bad-key',
      tunnelToken: VALID_TOKEN,
      paths: defaultPaths(dir),
    });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('key-file');
  });

  it('reports step=plist when the token rejects', async () => {
    const r = await setupLaunchAgent({
      pgsodiumKey: VALID_KEY,
      tunnelToken: 'bad<token>',
      paths: defaultPaths(dir),
    });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('plist');
  });

  it('reports step=load when launchctl fails', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' }) // unload ignored
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'launchctl failed' });

    const paths = {
      keyFile: join(dir, '.config/opuspopuli/pgsodium_root_key'),
      plistFile: join(dir, 'Library/LaunchAgents/org.opuspopuli.envloader.plist'),
    };
    const r = await setupLaunchAgent({
      pgsodiumKey: VALID_KEY,
      tunnelToken: VALID_TOKEN,
      paths,
    });
    expect(r.ok).toBe(false);
    expect(r.step).toBe('load');
  });
});

describe('teardownLaunchAgent', () => {
  it('unloads the agent and removes both files by default', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const tmp = await mkdtemp(join(tmpdir(), 'op-teardown-'));
    const paths = { keyFile: join(tmp, 'key'), plistFile: join(tmp, 'plist.plist') };

    // Pre-create both files so rm has something to delete.
    await writePgsodiumKeyFile(VALID_KEY, paths.keyFile);
    await writeLaunchAgentPlist(paths.plistFile, '<plist/>');

    const r = await teardownLaunchAgent(paths);
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(['unload', 'rm-plist', 'rm-key-file']);

    // Both files should be gone.
    await expect(stat(paths.keyFile)).rejects.toThrow();
    await expect(stat(paths.plistFile)).rejects.toThrow();

    await rm(tmp, { recursive: true, force: true });
  });

  it('keeps the key file when keepKeyFile=true', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const tmp = await mkdtemp(join(tmpdir(), 'op-teardown-'));
    const paths = { keyFile: join(tmp, 'key'), plistFile: join(tmp, 'plist.plist') };
    await writePgsodiumKeyFile(VALID_KEY, paths.keyFile);
    await writeLaunchAgentPlist(paths.plistFile, '<plist/>');

    const r = await teardownLaunchAgent(paths, { keepKeyFile: true });
    expect(r.ok).toBe(true);
    expect(r.steps.map((s) => s.step)).toEqual(['unload', 'rm-plist']);

    // Plist gone, key file still there.
    await expect(stat(paths.plistFile)).rejects.toThrow();
    await expect(stat(paths.keyFile)).resolves.toBeTruthy();

    await rm(tmp, { recursive: true, force: true });
  });

  it('treats `rm` of missing files as success (idempotent)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const tmp = await mkdtemp(join(tmpdir(), 'op-teardown-'));
    const paths = { keyFile: join(tmp, 'never-existed'), plistFile: join(tmp, 'never-existed.plist') };

    const r = await teardownLaunchAgent(paths);
    expect(r.ok).toBe(true);
    expect(r.steps.every((s) => s.ok)).toBe(true);

    await rm(tmp, { recursive: true, force: true });
  });

  it('marks unload step with reason when launchctl is missing, but does not fail teardown', async () => {
    // safeExeca returns null on ENOENT.
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);

    const tmp = await mkdtemp(join(tmpdir(), 'op-teardown-'));
    const paths = { keyFile: join(tmp, 'k'), plistFile: join(tmp, 'p.plist') };

    const r = await teardownLaunchAgent(paths);
    const unload = r.steps.find((s) => s.step === 'unload');
    expect(unload?.ok).toBe(true);
    expect(unload?.reason).toContain('not on PATH');
    expect(r.ok).toBe(true);

    await rm(tmp, { recursive: true, force: true });
  });
});
