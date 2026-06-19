import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  fetchOutput,
  findWorkspace,
  getRunStatus,
  probeTfcToken,
} from '../src/lib/tfc.js';

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

describe('probeTfcToken', () => {
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
    expect(v).toBe('eyJh…');
  });

  it('returns null when the named output is missing', async () => {
    installFetch(() => ({ status: 200, body: { data: [] } }));
    const v = await fetchOutput({ token: TOKEN, organization: ORG }, 'ws-1', 'tunnel_token');
    expect(v).toBeNull();
  });
});
