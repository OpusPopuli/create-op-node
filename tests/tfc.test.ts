import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOutput,
  findWorkspace,
  getRunStatus,
  isValidTfcOrgSlug,
  probeTfcToken,
} from '../src/lib/tfc.js';
import { API_REQUEST_TIMEOUT_MS } from '../src/lib/constants.js';

const TOKEN = 'fake-tfc-token';
const ORG = 'op-region-ca';

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

describe('isValidTfcOrgSlug', () => {
  it('accepts conventional org slugs', () => {
    expect(isValidTfcOrgSlug('op-region-ca')).toBe(true);
    expect(isValidTfcOrgSlug('OpusPopuli')).toBe(true);
    expect(isValidTfcOrgSlug('org_with_underscores')).toBe(true);
    expect(isValidTfcOrgSlug('a')).toBe(true);
  });

  it('rejects slugs that would break URL interpolation', () => {
    expect(isValidTfcOrgSlug('org/with/slash')).toBe(false);
    expect(isValidTfcOrgSlug('org?with=query')).toBe(false);
    expect(isValidTfcOrgSlug('org with space')).toBe(false);
    expect(isValidTfcOrgSlug('../traversal')).toBe(false);
    expect(isValidTfcOrgSlug('')).toBe(false);
  });

  it('rejects slugs over 40 chars', () => {
    expect(isValidTfcOrgSlug('a'.repeat(40))).toBe(true);
    expect(isValidTfcOrgSlug('a'.repeat(41))).toBe(false);
  });
});

describe('probeTfcToken', () => {
  it('rejects an invalid org slug before hitting the API', async () => {
    const fn = installFetch(() => ({ status: 200, body: {} }));
    const r = await probeTfcToken({ token: TOKEN, organization: 'bad/slug' });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatch(/isn't a valid TFC slug/);
    // No HTTP call should have happened.
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns ok=true when token + org both resolve', async () => {
    installFetch((path) => {
      if (path.endsWith('/account/details')) {
        return {
          status: 200,
          body: { data: { id: 'u-1', attributes: { username: 'rodney' } } },
        };
      }
      if (path.endsWith(`/organizations/${ORG}`)) {
        return { status: 200, body: { data: { id: 'org-1' } } };
      }
      return { status: 404, body: null };
    });

    const r = await probeTfcToken({ token: TOKEN, organization: ORG });
    expect(r.ok).toBe(true);
    expect(r.userName).toBe('rodney');
  });

  it('reports invalid token and stops before probing org', async () => {
    const fn = installFetch(() => ({
      status: 401,
      body: { errors: [{ status: '401', detail: 'invalid token' }] },
    }));
    const r = await probeTfcToken({ token: TOKEN, organization: ORG });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('TFC token invalid');
    // Should not have probed the org once auth failed.
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports a missing org distinctly from a missing token', async () => {
    installFetch((path) => {
      if (path.endsWith('/account/details')) {
        return { status: 200, body: { data: { id: 'u-1', attributes: {} } } };
      }
      return { status: 404, body: null };
    });
    const r = await probeTfcToken({ token: TOKEN, organization: ORG });
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toContain('not found');
  });
});

describe('findWorkspace', () => {
  it('returns the first match when no name disambiguator is provided', async () => {
    installFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            id: 'ws-1',
            attributes: { name: 'op-prod-cloudflare' },
            relationships: { 'current-run': { data: { id: 'run-7' } } },
          },
        ],
      },
    }));
    const ws = await findWorkspace({
      token: TOKEN,
      organization: ORG,
      tags: ['opuspopuli', 'cloudflare'],
    });
    expect(ws).toEqual({
      id: 'ws-1',
      name: 'op-prod-cloudflare',
      currentRunId: 'run-7',
    });
  });

  it('filters by name when multiple workspaces share the tag set', async () => {
    installFetch(() => ({
      status: 200,
      body: {
        data: [
          { id: 'ws-1', attributes: { name: 'one' }, relationships: {} },
          { id: 'ws-2', attributes: { name: 'two' }, relationships: {} },
        ],
      },
    }));
    const ws = await findWorkspace({
      token: TOKEN,
      organization: ORG,
      tags: ['x'],
      name: 'two',
    });
    expect(ws?.id).toBe('ws-2');
  });

  it('returns null when nothing matches the tag set', async () => {
    installFetch(() => ({ status: 200, body: { data: [] } }));
    const ws = await findWorkspace({ token: TOKEN, organization: ORG, tags: ['x'] });
    expect(ws).toBeNull();
  });
});

describe('getRunStatus', () => {
  it('flags a finished + succeeded run', async () => {
    installFetch(() => ({
      status: 200,
      body: { data: { id: 'run-7', attributes: { status: 'applied' } } },
    }));
    const r = await getRunStatus({ token: TOKEN, organization: ORG }, 'run-7');
    expect(r).toEqual({
      id: 'run-7',
      status: 'applied',
      finished: true,
      succeeded: true,
    });
  });

  it('flags a finished + failed run', async () => {
    installFetch(() => ({
      status: 200,
      body: { data: { id: 'run-7', attributes: { status: 'errored' } } },
    }));
    const r = await getRunStatus({ token: TOKEN, organization: ORG }, 'run-7');
    expect(r?.finished).toBe(true);
    expect(r?.succeeded).toBe(false);
  });

  it('treats "planning" as in-flight', async () => {
    installFetch(() => ({
      status: 200,
      body: { data: { id: 'run-7', attributes: { status: 'planning' } } },
    }));
    const r = await getRunStatus({ token: TOKEN, organization: ORG }, 'run-7');
    expect(r?.finished).toBe(false);
  });
});

describe('fetchOutput', () => {
  it('returns the named output value when present', async () => {
    installFetch(() => ({
      status: 200,
      body: {
        data: [
          {
            attributes: { name: 'tunnel_token', value: 'eyJh…', sensitive: true },
          },
          { attributes: { name: 'something_else', value: 'nope', sensitive: false } },
        ],
      },
    }));
    const v = await fetchOutput({ token: TOKEN, organization: ORG }, 'ws-1', 'tunnel_token');
    expect(v).toEqual({ kind: 'value', value: 'eyJh…' });
  });

  it('reports absent when the request succeeds but the named output is missing', async () => {
    installFetch(() => ({ status: 200, body: { data: [] } }));
    const v = await fetchOutput({ token: TOKEN, organization: ORG }, 'ws-1', 'tunnel_token');
    expect(v).toEqual({ kind: 'absent' });
  });

  it('reports absent when the output is present but not a string', async () => {
    installFetch(() => ({
      status: 200,
      body: { data: [{ attributes: { name: 'tunnel_token', value: { nested: 1 } } }] },
    }));
    const v = await fetchOutput({ token: TOKEN, organization: ORG }, 'ws-1', 'tunnel_token');
    expect(v).toEqual({ kind: 'absent' });
  });

  it('reports error (retryable) on a non-200 — e.g. state still settling', async () => {
    installFetch(() => ({ status: 404, body: null }));
    const v = await fetchOutput({ token: TOKEN, organization: ORG }, 'ws-1', 'tunnel_token');
    expect(v).toEqual({ kind: 'error' });
  });
});

describe('network resilience (issue #31)', () => {
  it('probeTfcToken reports a network error (not "token invalid") when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const r = await probeTfcToken({ token: TOKEN, organization: ORG });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/couldn't reach terraform cloud/i);
    expect(r.issues.join(' ')).not.toMatch(/token invalid/i);
  });

  it('probeTfcToken reports an org-level network error when the org probe fails', async () => {
    // Account probe succeeds; the org probe hits a network failure.
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        url.includes('/account/details')
          ? Promise.resolve(
              new Response(JSON.stringify({ data: { attributes: { username: 'op' } } }), {
                status: 200,
              }),
            )
          : Promise.reject(new Error('ECONNRESET')),
      ),
    );
    const r = await probeTfcToken({ token: TOKEN, organization: ORG });
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/couldn't reach terraform cloud while checking the organization/i);
  });

  it('findWorkspace / getRunStatus degrade to null and fetchOutput to error when fetch throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNRESET'))),
    );
    await expect(
      findWorkspace({ token: TOKEN, organization: ORG, tags: ['opuspopuli', 'cloudflare'] }),
    ).resolves.toBeNull();
    await expect(
      getRunStatus({ token: TOKEN, organization: ORG }, 'run-123'),
    ).resolves.toBeNull();
    // A thrown fetch degrades to status 0 → retryable `error`, NOT `absent`, so
    // the poll loop retries instead of misreporting a missing output. (#59)
    await expect(
      fetchOutput({ token: TOKEN, organization: ORG }, 'ws-1', 'tunnel_token'),
    ).resolves.toEqual({ kind: 'error' });
  });

  it('aborts and reports a network error when a request exceeds the timeout', async () => {
    vi.useFakeTimers();
    // A fetch that never settles on its own but rejects (like the real one)
    // when its AbortSignal fires.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('The operation was aborted.', 'AbortError')),
            );
          }),
      ),
    );
    const pending = probeTfcToken({ token: TOKEN, organization: ORG });
    await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
    const r = await pending;
    vi.useRealTimers();
    expect(r.ok).toBe(false);
    expect(r.issues.join(' ')).toMatch(/network error or timeout/i);
  });
});
