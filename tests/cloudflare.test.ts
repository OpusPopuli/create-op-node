import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeCloudflareToken } from '../src/lib/cloudflare.js';

const TOKEN = 'cfat_FAKE0000000000000000000000000000000';
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ZONE = 'fedcba9876543210fedcba9876543210';

// Helpers to stub fetch in a typed way without pulling in msw for v0.0.1.
type FetchMock = (path: string) => { status: number; body: unknown };

function installFetch(mock: FetchMock) {
  const fn = vi.fn((url: string) => {
    const u = new URL(url);
    const result = mock(u.pathname + u.search);
    return Promise.resolve(
      new Response(JSON.stringify(result.body), { status: result.status }),
    );
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('probeCloudflareToken', () => {
  it('returns ok=true when verify + all 5 scope probes return 200', async () => {
    installFetch(() => ({ status: 200, body: { success: true } }));

    const result = await probeCloudflareToken({
      token: TOKEN,
      accountId: ACCOUNT,
      zoneId: ZONE,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it('reports invalid token early and stops without probing scopes', async () => {
    const fetchFn = installFetch((path) => {
      if (path.endsWith('/tokens/verify')) {
        return { status: 401, body: { success: false, errors: [{ code: 1000, message: 'Invalid API Token' }] } };
      }
      throw new Error(`unexpected probe after verify failure: ${path}`);
    });

    const result = await probeCloudflareToken({
      token: TOKEN,
      accountId: ACCOUNT,
      zoneId: ZONE,
    });

    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain('Token verify failed');
    // No scope probes should have run.
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('reports each missing scope by name', async () => {
    installFetch((path) => {
      if (path.endsWith('/tokens/verify')) {
        return { status: 200, body: { success: true } };
      }
      if (path.includes('/cfd_tunnel') || path.includes('/r2/buckets')) {
        return { status: 403, body: { success: false, errors: [{ code: 9109, message: 'forbidden' }] } };
      }
      return { status: 200, body: { success: true } };
    });

    const result = await probeCloudflareToken({
      token: TOKEN,
      accountId: ACCOUNT,
      zoneId: ZONE,
    });

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Cloudflare Tunnel'),
        expect.stringContaining('Workers R2 Storage'),
      ]),
    );
  });

  it('surfaces "R2 not enabled" with an actionable message (code 10042)', async () => {
    installFetch((path) => {
      if (path.endsWith('/tokens/verify')) {
        return { status: 200, body: { success: true } };
      }
      if (path.includes('/r2/buckets')) {
        return {
          status: 400,
          body: {
            success: false,
            errors: [{ code: 10042, message: 'Please enable R2 through the Cloudflare Dashboard.' }],
          },
        };
      }
      return { status: 200, body: { success: true } };
    });

    const result = await probeCloudflareToken({
      token: TOKEN,
      accountId: ACCOUNT,
      zoneId: ZONE,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('R2 not enabled'))).toBe(true);
  });
});
