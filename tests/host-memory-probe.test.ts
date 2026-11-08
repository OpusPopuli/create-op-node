import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  HOST_MEMORY_PROBE_URL,
  hostMemoryProbeScript,
  installHostMemoryProbe,
  parseHostMemoryBody,
  uninstallHostMemoryProbe,
} from '../src/lib/host-memory-probe.js';
import { hostMemoryProbeFailure } from '../src/commands/bootstrap.js';

let repo: string;

/** A node repo checkout carrying the installer (contents irrelevant — execa is mocked). */
async function withInstaller(): Promise<string> {
  const script = hostMemoryProbeScript(repo);
  await mkdir(join(repo, 'scripts', 'host-memory-probe'), { recursive: true });
  await writeFile(script, '#!/usr/bin/env bash\n');
  await chmod(script, 0o755);
  return script;
}

beforeEach(async () => {
  execaMock.mockReset();
  repo = await mkdtemp(join(tmpdir(), 'op-node-probe-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('HOST_MEMORY_PROBE_URL', () => {
  it('reads the probe on loopback at its default port', () => {
    expect(HOST_MEMORY_PROBE_URL).toBe('http://127.0.0.1:11500/memory');
  });
});

describe('installHostMemoryProbe', () => {
  it('reports a missing installer (older node repo) without running anything', async () => {
    const res = await installHostMemoryProbe({ repoPath: repo, nodePath: '/usr/local/bin/node' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missing).toBe(true);
    expect(res.reason).toContain('Pull the node repo');
    expect(execaMock).not.toHaveBeenCalled();
    // The bootstrap phase surfaces the reason as-is.
    expect(hostMemoryProbeFailure(res)).toBe(res.reason);
  });

  it('runs the installer with the given node binary', async () => {
    const script = await withInstaller();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'running\n', stderr: '' });
    const res = await installHostMemoryProbe({ repoPath: repo, nodePath: '/opt/node/bin/node' });
    expect(res).toEqual({ ok: true, output: 'running' });
    expect(execaMock).toHaveBeenCalledWith(
      'bash',
      [script],
      expect.objectContaining({ cwd: repo, env: { HOST_MEMORY_PROBE_NODE: '/opt/node/bin/node' } }),
    );
    expect(hostMemoryProbeFailure(res)).toBeNull();
  });

  it('defaults the node binary to the one running the CLI', async () => {
    await withInstaller();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
    await installHostMemoryProbe({ repoPath: repo });
    expect(execaMock.mock.calls[0]?.[2]).toMatchObject({
      env: { HOST_MEMORY_PROBE_NODE: process.execPath },
    });
  });

  it("fails with the installer's stderr", async () => {
    const script = await withInstaller();
    execaMock.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'need Node 22.6 or later, found v22.1.0\n',
    });
    const res = await installHostMemoryProbe({ repoPath: repo });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missing).toBe(false);
    expect(res.reason).toBe('need Node 22.6 or later, found v22.1.0');
    expect(hostMemoryProbeFailure(res)).toBe(`${script} failed: need Node 22.6 or later, found v22.1.0`);
  });
});

describe('uninstallHostMemoryProbe', () => {
  it('passes --uninstall', async () => {
    const script = await withInstaller();
    execaMock.mockResolvedValue({ exitCode: 0, stdout: 'Removed org.opuspopuli.host-memory-probe', stderr: '' });
    const res = await uninstallHostMemoryProbe(repo);
    expect(res.ok).toBe(true);
    expect(execaMock).toHaveBeenCalledWith('bash', [script, '--uninstall'], expect.anything());
  });

  it('reports a missing installer as missing', async () => {
    const res = await uninstallHostMemoryProbe(repo);
    expect(res.ok === false && res.missing).toBe(true);
  });
});

describe('parseHostMemoryBody', () => {
  it('reads reclaimableBytes', () => {
    expect(parseHostMemoryBody('{"reclaimableBytes":1024,"swapUsedBytes":0}')).toEqual({
      ok: true,
      reclaimableBytes: 1024,
    });
  });

  it.each(['nope', 'null', '{}', '{"reclaimableBytes":"1"}', '{"reclaimableBytes":-1}'])(
    'rejects %s',
    (body) => {
      expect(parseHostMemoryBody(body).ok).toBe(false);
    },
  );
});
