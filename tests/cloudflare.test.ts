import { afterEach, describe, expect, it, vi } from 'vitest';

import { probeCloudflareToken, tunnelStatus } from '../src/lib/cloudflare.js';

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

describe('tunnelStatus', () => {
  const TUNNEL = '11111111-2222-3333-4444-555555555555';

  function fetchOn(handler: (path: string) => { status: number; body: unknown }): typeof fetch {
    return vi.fn((url: RequestInfo | URL) => {
      const u = new URL(String(url));
      const r = handler(u.pathname);
      return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
    }) as unknown as typeof fetch;
  }

  it('returns ok + connection count + status on a healthy tunnel', async () => {
    const fetchImpl = fetchOn((path) => {
      expect(path).toBe(`/client/v4/accounts/${ACCOUNT}/cfd_tunnel/${TUNNEL}`);
      return {
        status: 200,
        body: {
          result: {
            status: 'healthy',
            connections: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }, { id: 'c4' }],
          },
        },
      };
    });
    const r = await tunnelStatus({
      token: TOKEN,
      accountId: ACCOUNT,
      tunnelId: TUNNEL,
      fetchImpl,
    });
    expect(r).toEqual({ ok: true, connections: 4, status: 'healthy' });
  });

  it('returns connections=0 when the result has an empty connections array', async () => {
    const fetchImpl = fetchOn(() => ({
      status: 200,
      body: { result: { status: 'inactive', connections: [] } },
    }));
    const r = await tunnelStatus({
      token: TOKEN,
      accountId: ACCOUNT,
      tunnelId: TUNNEL,
      fetchImpl,
    });
    if (!r.ok) throw new Error('expected ok');
    expect(r.connections).toBe(0);
    expect(r.status).toBe('inactive');
  });

  it('returns ok=false with the CF error message on non-200', async () => {
    const fetchImpl = fetchOn(() => ({
      status: 404,
      body: { errors: [{ code: 1003, message: 'Tunnel not found' }] },
    }));
    const r = await tunnelStatus({
      token: TOKEN,
      accountId: ACCOUNT,
      tunnelId: TUNNEL,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('HTTP 404');
      expect(r.reason).toContain('Tunnel not found');
    }
  });

  it('returns ok=false when fetch throws', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const r = await tunnelStatus({
      token: TOKEN,
      accountId: ACCOUNT,
      tunnelId: TUNNEL,
      fetchImpl,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ECONNRESET');
  });
});

