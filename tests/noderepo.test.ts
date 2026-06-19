import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  locateOrCloneRepo,
  looksLikeNodeRepo,
  NODE_REPO_MARKERS,
} from '../src/lib/noderepo.js';

let dir: string;
beforeEach(async () => {
  execaMock.mockReset();
  dir = await mkdtemp(join(tmpdir(), 'op-noderepo-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function plantNodeRepo(root: string) {
  for (const marker of NODE_REPO_MARKERS) {
    const path = join(root, marker);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
  }
}

describe('looksLikeNodeRepo', () => {
  it('returns true when every marker file is present', async () => {
    await plantNodeRepo(dir);
    expect(await looksLikeNodeRepo(dir)).toBe(true);
  });

  it('returns false when any marker is missing', async () => {
    await plantNodeRepo(dir);
    await rm(join(dir, NODE_REPO_MARKERS[0]));
    expect(await looksLikeNodeRepo(dir)).toBe(false);
  });

  it('returns false for an empty directory', async () => {
    expect(await looksLikeNodeRepo(dir)).toBe(false);
  });
});

describe('locateOrCloneRepo', () => {
  it('returns found(explicit) when --repo-dir points at a real node repo', async () => {
    await plantNodeRepo(dir);
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      explicit: dir,
      cwd: '/tmp',
    });
    expect(r).toEqual({ kind: 'found', path: dir, source: 'explicit' });
    // Should NOT have shelled out to gh.
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('returns explicit-not-a-node-repo when --repo-dir misses the markers', async () => {
    // dir is empty
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      explicit: dir,
      cwd: '/tmp',
    });
    expect(r).toEqual({ kind: 'explicit-not-a-node-repo', path: dir });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('returns found(cwd) when current dir is a node repo', async () => {
    await plantNodeRepo(dir);
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      cwd: dir,
    });
    expect(r).toEqual({ kind: 'found', path: dir, source: 'cwd' });
    expect(execaMock).not.toHaveBeenCalled();
  });

  it('clones via gh when neither explicit nor cwd matches', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      cwd: dir, // empty dir — doesn't match
      cloneInto: '/Users/op/Development/opuspopuli-node-us-ca',
    });
    expect(r).toEqual({
      kind: 'cloned',
      path: '/Users/op/Development/opuspopuli-node-us-ca',
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual([
      'repo',
      'clone',
      'OpusPopuli/opuspopuli-node-us-ca',
      '/Users/op/Development/opuspopuli-node-us-ca',
    ]);
  });

  it('returns gh-not-installed on ENOENT', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      cwd: dir,
    });
    expect(r.kind).toBe('gh-not-installed');
  });

  it('returns clone-failed with stderr on non-zero exit', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'gh: repo not found',
    });
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'nonexistent',
      cwd: dir,
    });
    expect(r.kind).toBe('clone-failed');
    if (r.kind === 'clone-failed') {
      expect(r.reason).toContain('repo not found');
    }
  });

  it('returns clone-disallowed when allowClone=false and no existing path matches', async () => {
    const r = await locateOrCloneRepo({
      owner: 'OpusPopuli',
      name: 'opuspopuli-node-us-ca',
      cwd: dir,
      allowClone: false,
    });
    expect(r.kind).toBe('clone-disallowed');
    expect(execaMock).not.toHaveBeenCalled();
  });
});
