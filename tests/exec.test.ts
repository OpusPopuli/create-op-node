import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import { safeExeca } from '../src/lib/exec.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('safeExeca', () => {
  it('returns the result object on a normal exit (zero or non-zero)', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'ok', stderr: '' });
    const r = await safeExeca('foo', ['--bar']);
    expect(r).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
  });

  it('returns the result object even when exit code is non-zero', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 2, stdout: '', stderr: 'nope' });
    const r = await safeExeca('foo', []);
    expect(r?.exitCode).toBe(2);
    expect(r?.stderr).toBe('nope');
  });

  it('returns null when the binary is not on PATH (ENOENT)', async () => {
    const err = Object.assign(new Error('spawn foo ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await safeExeca('foo', []);
    expect(r).toBeNull();
  });

  it('returns null on ENOTDIR (path component is not a directory)', async () => {
    const err = Object.assign(new Error('spawn foo ENOTDIR'), { code: 'ENOTDIR' });
    execaMock.mockRejectedValueOnce(err);
    const r = await safeExeca('foo', []);
    expect(r).toBeNull();
  });

  it('re-throws errors that are not spawn failures', async () => {
    const err = Object.assign(new Error('boom'), { code: 'EPIPE' });
    execaMock.mockRejectedValueOnce(err);
    await expect(safeExeca('foo', [])).rejects.toThrow('boom');
  });

  it('passes through undefined exitCode when the child is signal-killed', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: undefined,
      stdout: '',
      stderr: 'killed',
    });
    const r = await safeExeca('foo', []);
    expect(r?.exitCode).toBeUndefined();
  });

  it('forwards options (stdin via `input`) to execa', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    await safeExeca('foo', ['--bar'], { input: 'sekrit' });
    const call = execaMock.mock.calls[0] as [string, string[], { input?: string; reject?: boolean }];
    expect(call[2].input).toBe('sekrit');
    expect(call[2].reject).toBe(false);
  });
});
