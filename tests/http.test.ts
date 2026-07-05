import { describe, expect, it, vi } from 'vitest';

import { graphqlProbe, httpProbe } from '../src/lib/http.js';

function mockFetch(handler: (req: { url: string; init?: RequestInit }) => { status: number; body: string }): typeof fetch {
  return vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
    const r = handler({ url: String(url), init });
    // 204/304 disallow a body in the Response constructor — pass null + drop in.
    const noBody = r.status === 204 || r.status === 304 || r.status === 205;
    return Promise.resolve(new Response(noBody ? null : r.body, { status: r.status }));
  }) as unknown as typeof fetch;
}

describe('httpProbe', () => {
  it('returns ok=true + status + body preview on the expected status', async () => {
    const fetchImpl = mockFetch(() => ({ status: 200, body: 'OK' }));
    const r = await httpProbe({ url: 'https://api.example.org/health', fetchImpl });
    expect(r).toEqual({ ok: true, status: 200, bodyPreview: 'OK' });
  });

  it('caps the body preview at 200 chars', async () => {
    const big = 'x'.repeat(1000);
    const fetchImpl = mockFetch(() => ({ status: 200, body: big }));
    const r = await httpProbe({ url: 'https://api.example.org/health', fetchImpl });
    if (!r.ok) throw new Error('expected ok');
    expect(r.bodyPreview).toHaveLength(200);
  });

  it('fails when the status does not match expectedStatus', async () => {
    const fetchImpl = mockFetch(() => ({ status: 503, body: 'unavailable' }));
    const r = await httpProbe({ url: 'https://api.example.org/health', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(503);
      expect(r.reason).toContain('expected HTTP 200');
    }
  });

  it('allows overriding expectedStatus', async () => {
    const fetchImpl = mockFetch(() => ({ status: 204, body: '' }));
    const r = await httpProbe({
      url: 'https://api.example.org/x',
      expectedStatus: 204,
      fetchImpl,
    });
    expect(r.ok).toBe(true);
  });

  it('reports network errors via the failure reason', async () => {
    const fetchImpl = vi.fn(() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;
    const r = await httpProbe({ url: 'https://api.example.org/health', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('ECONNRESET');
  });

  it('reports an AbortError as a timeout reason', async () => {
    const fetchImpl = vi.fn(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const r = await httpProbe({
      url: 'https://api.example.org/health',
      fetchImpl,
      timeoutMs: 5,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('timed out');
  });
});

describe('graphqlProbe', () => {
  it('returns ok + typename on a well-formed gateway response', async () => {
    const fetchImpl = mockFetch(({ url, init }) => {
      expect(url).toBe('https://api.example.org/api');
      if (!init) throw new Error('expected fetch init to be set');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
      const body = JSON.parse(init.body as string) as { query: string };
      expect(body.query).toBe('{ __typename }');
      return { status: 200, body: JSON.stringify({ data: { __typename: 'Query' } }) };
    });
    const r = await graphqlProbe({ url: 'https://api.example.org/api', fetchImpl });
    expect(r).toEqual({ ok: true, typename: 'Query' });
  });

  it('fails when the response is HTML (proxy 404 case)', async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: '<!doctype html><title>Not Found</title>',
    }));
    const r = await graphqlProbe({ url: 'https://api.example.org/api', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('not JSON');
  });

  it('fails when the JSON envelope is missing data.__typename', async () => {
    const fetchImpl = mockFetch(() => ({
      status: 200,
      body: JSON.stringify({ errors: [{ message: 'no public schema' }] }),
    }));
    const r = await graphqlProbe({ url: 'https://api.example.org/api', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('__typename');
  });

  it('fails with the status when the gateway 5xxes', async () => {
    const fetchImpl = mockFetch(() => ({ status: 502, body: 'bad gateway' }));
    const r = await graphqlProbe({ url: 'https://api.example.org/api', fetchImpl });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(502);
      expect(r.reason).toContain('expected HTTP 200');
    }
  });

  it('reports timeout cleanly via AbortError', async () => {
    const fetchImpl = vi.fn(() => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }) as unknown as typeof fetch;
    const r = await graphqlProbe({
      url: 'https://api.example.org/api',
      fetchImpl,
      timeoutMs: 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('timed out');
  });
});
