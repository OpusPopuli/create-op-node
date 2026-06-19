import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  COSIGN_OIDC_ISSUER,
  cosignVerifyImage,
  DEFAULT_IDENTITY_REGEXP,
} from '../src/lib/cosign.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe('cosignVerifyImage', () => {
  it('passes the GitHub Actions OIDC issuer + identity regex by default', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'Verified OK', stderr: '' });
    const r = await cosignVerifyImage({ image: 'ghcr.io/opuspopuli/api:abc' });
    expect(r.ok).toBe(true);
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('cosign');
    expect(args).toContain('verify');
    expect(args).toContain('--certificate-identity-regexp');
    expect(args).toContain(DEFAULT_IDENTITY_REGEXP);
    expect(args).toContain('--certificate-oidc-issuer');
    expect(args).toContain(COSIGN_OIDC_ISSUER);
    expect(args[args.length - 1]).toBe('ghcr.io/opuspopuli/api:abc');
  });

  it('allows overriding the identity regex and OIDC issuer', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: 'OK', stderr: '' });
    await cosignVerifyImage({
      image: 'ghcr.io/x/y:z',
      certificateIdentityRegexp: '^custom$',
      certificateOidcIssuer: 'https://example.invalid',
    });
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('^custom$');
    expect(args).toContain('https://example.invalid');
  });

  it('returns skipped=true when cosign is not on PATH (ENOENT)', async () => {
    const err = Object.assign(new Error('spawn cosign ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await cosignVerifyImage({ image: 'ghcr.io/x:y' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.skipped).toBe(true);
      expect(r.reason).toContain('not on PATH');
      expect(r.reason).toContain('brew install cosign');
    }
  });

  it('returns skipped=false with stderr when cosign rejects the image', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'no matching signatures',
    });
    const r = await cosignVerifyImage({ image: 'ghcr.io/x:y' });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.skipped).toBe(false);
      expect(r.reason).toContain('no matching signatures');
    }
  });

  it('captures stdout as the output on success', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'Verified OK\n[{...}]',
      stderr: '',
    });
    const r = await cosignVerifyImage({ image: 'ghcr.io/x:y' });
    if (!r.ok) throw new Error('expected ok');
    expect(r.output).toContain('Verified OK');
  });
});
