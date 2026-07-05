import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execaMock = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({
  execa: execaMock,
  ExecaError: class {},
}));

import {
  checkOllamaHealth,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_LLM_MODEL,
  DEFAULT_MODELS,
  OLLAMA_URL,
  PROBE_ALPINE_TAG,
  probeHostDockerInternal,
  pullModel,
  setupModels,
  startOllamaService,
  warmModel,
} from '../src/lib/ollama.js';

beforeEach(() => execaMock.mockReset());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    const r = handler(url, init);
    return Promise.resolve(new Response(JSON.stringify(r.body), { status: r.status }));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('DEFAULT_MODELS + OLLAMA_URL', () => {
  it('uses qwen3.5:9b + nomic-embed-text by default', () => {
    expect(DEFAULT_MODELS).toEqual(['qwen3.5:9b', 'nomic-embed-text']);
  });

  it('exports DEFAULT_LLM_MODEL + DEFAULT_EMBEDDING_MODEL scalars', () => {
    expect(DEFAULT_LLM_MODEL).toBe('qwen3.5:9b');
    expect(DEFAULT_EMBEDDING_MODEL).toBe('nomic-embed-text');
  });

  it('DEFAULT_MODELS is composed from the two scalars (no drift)', () => {
    expect(DEFAULT_MODELS).toEqual([DEFAULT_LLM_MODEL, DEFAULT_EMBEDDING_MODEL]);
  });

  it('points at localhost:11434', () => {
    expect(OLLAMA_URL).toBe('http://localhost:11434');
  });
});

describe('checkOllamaHealth', () => {
  it('returns reachable=true + extracted model names on 200', async () => {
    stubFetch((url) => {
      expect(url).toContain('/api/tags');
      return {
        status: 200,
        body: {
          models: [{ name: 'qwen3.5:9b' }, { name: 'nomic-embed-text' }],
        },
      };
    });
    const h = await checkOllamaHealth();
    expect(h).toEqual({
      reachable: true,
      models: ['qwen3.5:9b', 'nomic-embed-text'],
    });
  });

  it('returns reachable=false on a non-2xx response', async () => {
    stubFetch(() => ({ status: 500, body: {} }));
    const h = await checkOllamaHealth();
    expect(h).toEqual({ reachable: false, models: [] });
  });

  it('returns reachable=false when fetch throws (daemon not up)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))),
    );
    const h = await checkOllamaHealth();
    expect(h.reachable).toBe(false);
  });

  it('tolerates a response with no `models` key', async () => {
    stubFetch(() => ({ status: 200, body: {} }));
    const h = await checkOllamaHealth();
    expect(h.models).toEqual([]);
  });
});

describe('pullModel', () => {
  it('shells out to `ollama pull <name>`', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await pullModel('qwen3.5:9b');
    expect(r.ok).toBe(true);
    const [cmd, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('ollama');
    expect(args).toEqual(['pull', 'qwen3.5:9b']);
  });

  it("reports 'ollama not on PATH' on ENOENT", async () => {
    const err = Object.assign(new Error('spawn ollama ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await pullModel('x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not on PATH');
  });

  it('reports stderr on non-zero exit', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 2,
      stdout: '',
      stderr: 'pull failed: bad model name',
    });
    const r = await pullModel('nope');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('bad model name');
  });
});

describe('warmModel', () => {
  it('POSTs /api/generate with stream=false and the given model name', async () => {
    const fn = stubFetch((url, init) => {
      expect(url).toContain('/api/generate');
      expect(init?.method).toBe('POST');
      const body = JSON.parse(init?.body as string) as { model: string; prompt: string; stream: boolean };
      expect(body.model).toBe('qwen3.5:9b');
      expect(body.stream).toBe(false);
      return { status: 200, body: { response: 'hi' } };
    });
    const r = await warmModel('qwen3.5:9b');
    expect(r.ok).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('reports a clear reason on non-200', async () => {
    stubFetch(() => ({ status: 503, body: { error: 'overloaded' } }));
    const r = await warmModel('x');
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('HTTP 503');
  });
});

describe('probeHostDockerInternal', () => {
  it('runs an alpine probe to host.docker.internal:11434 with a pinned tag', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '{}', stderr: '' });
    const r = await probeHostDockerInternal();
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args[0]).toBe('run');
    expect(args.join(' ')).toContain('host.docker.internal:11434');
    expect(args).toContain(`alpine:${PROBE_ALPINE_TAG}`);
  });

  it('reports the Docker-Desktop-setting fix when the probe fails', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 7, stdout: '', stderr: 'curl: connect failed' });
    const r = await probeHostDockerInternal();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('host.docker.internal');
  });
});

describe('startOllamaService', () => {
  it('runs `brew services start ollama` and reports ok on exit 0', async () => {
    execaMock.mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });
    const r = await startOllamaService();
    expect(r.ok).toBe(true);
    const [, args] = execaMock.mock.calls[0] as [string, string[]];
    expect(args).toEqual(['services', 'start', 'ollama']);
  });

  it("reports 'brew not on PATH' when brew is missing", async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    execaMock.mockRejectedValueOnce(err);
    const r = await startOllamaService();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('not on PATH');
  });

  it('surfaces the stderr reason on non-zero exit', async () => {
    execaMock.mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'permission denied',
    });
    const r = await startOllamaService();
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('permission denied');
  });
});

describe('setupModels', () => {
  it('skips already-present models + pulls + warms', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return { status: 200, body: { models: [{ name: 'qwen3.5:9b' }] } };
      }
      return { status: 200, body: { response: 'hi' } };
    });
    execaMock
      // nomic-embed-text: ollama pull → ok
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const report = await setupModels(['qwen3.5:9b', 'nomic-embed-text']);
    expect(report.alreadyPresent).toEqual(['qwen3.5:9b']);
    expect(report.pulled).toEqual(['nomic-embed-text']);
    expect(report.failed).toEqual([]);
    expect(report.warmed).toEqual(['qwen3.5:9b']);
  });

  it('continues past a pull failure and reports it', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return { status: 200, body: { models: [] } };
      }
      return { status: 200, body: { response: 'hi' } };
    });
    execaMock
      .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'qwen pull borked' })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '' });

    const report = await setupModels(['qwen3.5:9b', 'nomic-embed-text']);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]?.model).toBe('qwen3.5:9b');
    expect(report.pulled).toEqual(['nomic-embed-text']);
    // Should still warm nomic-embed-text (first model in the list that's
    // available).
    expect(report.warmed).toEqual(['nomic-embed-text']);
  });

  it('emits per-model status callbacks', async () => {
    stubFetch((url) => {
      if (url.endsWith('/api/tags')) {
        return { status: 200, body: { models: [{ name: 'qwen3.5:9b' }] } };
      }
      return { status: 200, body: {} };
    });
    const seen: Array<[string, string]> = [];
    await setupModels(['qwen3.5:9b'], (m, s) => seen.push([m, s]));
    expect(seen).toEqual([
      ['qwen3.5:9b', 'present'],
      ['qwen3.5:9b', 'warming'],
      ['qwen3.5:9b', 'warmed'],
    ]);
  });
});
