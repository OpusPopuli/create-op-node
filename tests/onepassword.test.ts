import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock execa BEFORE importing the lib so vi can hook the import.
const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: execaMock }));

import { detectOp, readSecretFromOp, saveSecretToOp } from '../src/lib/onepassword.js';

beforeEach(() => {
  execaMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('detectOp', () => {
  it('reports installed=false when `op` is not on PATH (ENOENT)', async () => {
    const err = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await detectOp();
    expect(r).toEqual({ installed: false, signedIn: false });
  });

  it('reports installed=true but signedIn=false when whoami fails', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '2.0.0' })
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not signed in' });
    const r = await detectOp();
    expect(r.installed).toBe(true);
    expect(r.signedIn).toBe(false);
  });

  it('extracts email from whoami JSON when signed in', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '2.0.0' })
      .mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ email: 'user@example.com' }),
      });
    const r = await detectOp();
    expect(r).toEqual({
      installed: true,
      signedIn: true,
      email: 'user@example.com',
    });
  });

  it('still returns signedIn=true when whoami JSON is unparseable', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '2.0.0' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: 'not json' });
    const r = await detectOp();
    expect(r.signedIn).toBe(true);
    expect(r.email).toBeUndefined();
  });
});

describe('saveSecretToOp', () => {
  it('creates a fresh Secure Note when no item with that title exists', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' }) // op item get
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' }); // op item create

    const r = await saveSecretToOp({ title: 'op-us-ca-tunnel-token', value: 'eyJh…' });

    expect(r).toEqual({ written: true, alreadyExisted: false });
    const [, createArgs] = execaMock.mock.calls[1] as [string, string[]];
    expect(createArgs).toContain('create');
    expect(createArgs).toContain('--title');
    expect(createArgs).toContain('op-us-ca-tunnel-token');
    expect(createArgs.some((a) => a.startsWith('notesPlain='))).toBe(true);
  });

  it('reports alreadyExisted=true without overwriting by default', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"id":"abc"}',
    });

    const r = await saveSecretToOp({ title: 'dup', value: 'v' });

    expect(r).toEqual({ written: false, alreadyExisted: true });
    // Only the get call should have run — no create, no edit.
    expect(execaMock).toHaveBeenCalledTimes(1);
  });

  it('edits the existing item when overwrite=true', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"id":"abc"}' }) // op item get
      .mockResolvedValueOnce({ exitCode: 0, stdout: '' }); // op item edit

    const r = await saveSecretToOp({
      title: 'dup',
      value: 'new-value',
      overwrite: true,
    });

    expect(r).toEqual({ written: true, alreadyExisted: true });
    const [, editArgs] = execaMock.mock.calls[1] as [string, string[]];
    expect(editArgs[0]).toBe('item');
    expect(editArgs[1]).toBe('edit');
  });

  it('surfaces a non-zero exit from `op item create` as a clear reason', async () => {
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' })
      .mockResolvedValueOnce({
        exitCode: 1,
        stdout: '',
        stderr: 'op: vault permission denied',
      });

    const r = await saveSecretToOp({ title: 't', value: 'v' });

    expect(r.written).toBe(false);
    expect(r.alreadyExisted).toBe(false);
    expect(r.reason).toContain('vault permission denied');
  });

  it('reports a clean "op not installed" reason when execa raises ENOENT', async () => {
    const err = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await saveSecretToOp({ title: 't', value: 'v' });
    expect(r.written).toBe(false);
    expect(r.reason).toContain('`op` CLI not installed');
  });
});

describe('readSecretFromOp', () => {
  it('returns the notesPlain value when the item exists', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'aabbccdd1122334455',
      stderr: '',
    });
    const v = await readSecretFromOp({ title: 'k' });
    expect(v).toBe('aabbccdd1122334455');
  });

  it('returns null when `op` exits non-zero (item not found)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'not found' });
    const v = await readSecretFromOp({ title: 'missing' });
    expect(v).toBeNull();
  });

  it('returns null when execa raises ENOENT', async () => {
    const err = Object.assign(new Error('spawn op ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const v = await readSecretFromOp({ title: 'k' });
    expect(v).toBeNull();
  });
});
