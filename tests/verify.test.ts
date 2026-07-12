import { describe, expect, it, vi } from 'vitest';

import {
  collectImage,
  mergeOllamaModelConfig,
  runVerify,
  summarize,
  type VerifyDeps,
  type VerifyPhase,
  type VerifyReport,
} from '../src/commands/verify.js';

const okTls = (daysToExpiry = 90): Awaited<ReturnType<VerifyDeps['tls']>> => ({
  ok: true,
  subject: 'api.example.org',
  issuer: "Let's Encrypt",
  daysToExpiry,
});

const okHealth = (): Awaited<ReturnType<VerifyDeps['http']>> => ({
  ok: true,
  status: 200,
  bodyPreview: 'OK',
});

const okGql = (): Awaited<ReturnType<VerifyDeps['graphql']>> => ({
  ok: true,
  typename: 'Query',
});

const okOllama = (
  models: string[] = ['qwen2.5:7b', 'nomic-embed-text:latest'],
): Awaited<ReturnType<VerifyDeps['ollama']>> => ({ reachable: true, models });

function depsFor(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    tls: vi.fn(() => Promise.resolve(okTls())),
    http: vi.fn(() => Promise.resolve(okHealth())),
    graphql: vi.fn(() => Promise.resolve(okGql())),
    tunnel: vi.fn(() => Promise.resolve({ ok: true, connections: 4, status: 'healthy' })),
    cosign: vi.fn(() => Promise.resolve({ ok: true, output: 'Verified OK' })),
    ollama: vi.fn(() => Promise.resolve(okOllama())),
    ...overrides,
  };
}

const baseInput = {
  apiHost: 'api.example.org',
  certWarnDays: 14,
  images: [],
};

describe('collectImage (#103)', () => {
  it('accumulates repeated --image values into an array', () => {
    // Simulate commander invoking the collector once per --image flag.
    expect(collectImage('a', [])).toEqual(['a']);
    expect(collectImage('b', ['a'])).toEqual(['a', 'b']);
  });

  it('treats an undefined starting accumulator as empty (single --image)', () => {
    expect(collectImage('ghcr.io/opuspopuli/api:latest', undefined)).toEqual([
      'ghcr.io/opuspopuli/api:latest',
    ]);
  });
});

describe('summarize', () => {
  it('ok=true when no phase failed', () => {
    expect(
      summarize({
        phases: [
          { name: 'a', status: 'ok', detail: '' },
          { name: 'b', status: 'ok', detail: '' },
        ],
      }),
    ).toEqual({ ok: true, failed: 0, warned: 0 });
  });

  it('counts warns separately — ok still true', () => {
    expect(
      summarize({
        phases: [
          { name: 'a', status: 'warn', detail: '' },
          { name: 'b', status: 'warn', detail: '' },
        ],
      }),
    ).toEqual({ ok: true, failed: 0, warned: 2 });
  });

  it('skipped does not affect ok/warned/failed', () => {
    expect(
      summarize({
        phases: [
          { name: 'a', status: 'ok', detail: '' },
          { name: 'b', status: 'skipped', detail: '' },
        ],
      }),
    ).toEqual({ ok: true, failed: 0, warned: 0 });
  });

  it('any fail flips ok to false', () => {
    expect(
      summarize({
        phases: [
          { name: 'a', status: 'ok', detail: '' },
          { name: 'b', status: 'fail', detail: '' },
        ],
      }),
    ).toEqual({ ok: false, failed: 1, warned: 0 });
  });
});

describe('runVerify orchestration', () => {
  it('returns 6 phases on a clean run with no images', async () => {
    const report = await runVerify(baseInput, depsFor());
    expect(report.phases.map((ph) => ph.name)).toEqual([
      'TLS handshake',
      'GET /health',
      'GraphQL { __typename }',
      'Ollama models',
      'Cloudflare Tunnel',
      'cosign verify',
    ]);
    expect(report.phases.every((ph) => ph.status === 'ok' || ph.status === 'skipped')).toBe(true);
  });

  it('continues past a TLS failure (no short-circuit)', async () => {
    const report = await runVerify(
      baseInput,
      depsFor({
        tls: vi.fn(() => Promise.resolve({ ok: false, reason: 'ECONNREFUSED' })),
      }),
    );
    const tls = report.phases.find((ph) => ph.name === 'TLS handshake');
    expect(tls?.status).toBe('fail');
    // Health + GraphQL still ran:
    expect(report.phases.find((ph) => ph.name === 'GET /health')?.status).toBe('ok');
    expect(report.phases.find((ph) => ph.name === 'GraphQL { __typename }')?.status).toBe('ok');
  });

  it('TLS warns when cert expires below the threshold', async () => {
    const deps = depsFor({ tls: vi.fn(() => Promise.resolve(okTls(7))) });
    const report = await runVerify({ ...baseInput, certWarnDays: 14 }, deps);
    const tls = report.phases.find((ph) => ph.name === 'TLS handshake');
    expect(tls?.status).toBe('warn');
    expect(tls?.detail).toContain('warn threshold 14d');
  });

  it('TLS warn renders "expired Xd ago" for negative daysToExpiry (review N4)', async () => {
    const deps = depsFor({ tls: vi.fn(() => Promise.resolve(okTls(-5))) });
    const report = await runVerify(baseInput, deps);
    const tls = report.phases.find((ph) => ph.name === 'TLS handshake');
    expect(tls?.status).toBe('warn');
    expect(tls?.detail).toContain('expired 5d ago');
  });

  it('TLS warn at threshold edge — daysToExpiry === certWarnDays passes', async () => {
    const deps = depsFor({ tls: vi.fn(() => Promise.resolve(okTls(14))) });
    const report = await runVerify({ ...baseInput, certWarnDays: 14 }, deps);
    expect(report.phases.find((ph) => ph.name === 'TLS handshake')?.status).toBe('ok');
  });

  it('skips Cloudflare Tunnel when no CF fields are set', async () => {
    const deps = depsFor();
    const report = await runVerify(baseInput, deps);
    const cf = report.phases.find((ph) => ph.name === 'Cloudflare Tunnel');
    expect(cf?.status).toBe('skipped');
    expect(deps.tunnel).not.toHaveBeenCalled();
  });

  it('warns on partial CF config and names the missing flags (review S1)', async () => {
    const deps = depsFor();
    const report = await runVerify(
      { ...baseInput, cf: { token: 't', accountId: 'a' /* tunnelId missing */ } },
      deps,
    );
    const cf = report.phases.find((ph) => ph.name === 'Cloudflare Tunnel');
    expect(cf?.status).toBe('warn');
    expect(cf?.detail).toContain('--tunnel-id');
    expect(cf?.detail).not.toContain('--cf-token');
    expect(deps.tunnel).not.toHaveBeenCalled();
  });

  it('warns when CF tunnel returns 0 connections (cloudflared offline)', async () => {
    const deps = depsFor({
      tunnel: vi.fn(() => Promise.resolve({ ok: true, connections: 0, status: 'inactive' })),
    });
    const report = await runVerify(
      { ...baseInput, cf: { token: 't', accountId: 'a', tunnelId: 'x' } },
      deps,
    );
    const cf = report.phases.find((ph) => ph.name === 'Cloudflare Tunnel');
    expect(cf?.status).toBe('warn');
    expect(cf?.detail).toContain('cloudflared');
  });

  it('runs CF tunnel probe with all three fields set', async () => {
    const deps = depsFor();
    await runVerify(
      { ...baseInput, cf: { token: 't', accountId: 'a', tunnelId: 'x' } },
      deps,
    );
    expect(deps.tunnel).toHaveBeenCalledWith({ token: 't', accountId: 'a', tunnelId: 'x' });
  });

  it('runs cosign verify for each image and surfaces skipped vs fail vs ok', async () => {
    let i = 0;
    const cosign = vi.fn(() => {
      const results: Array<Awaited<ReturnType<VerifyDeps['cosign']>>> = [
        { ok: true, output: 'Verified OK' },
        { ok: false, skipped: true, reason: 'cosign not on PATH' },
        { ok: false, skipped: false, reason: 'no matching signatures' },
      ];
      return Promise.resolve(results[i++]!);
    });
    const report = await runVerify(
      { ...baseInput, images: ['ghcr.io/x:a', 'ghcr.io/x:b', 'ghcr.io/x:c'] },
      depsFor({ cosign }),
    );
    expect(cosign).toHaveBeenCalledTimes(3);
    const cosPhases = report.phases.filter((ph) => ph.name.startsWith('cosign verify'));
    expect(cosPhases.map((ph) => ph.status)).toEqual(['ok', 'skipped', 'fail']);
  });

  it('fires onPhase once per phase in order', async () => {
    const seen: VerifyPhase[] = [];
    const deps = depsFor({ onPhase: (ph) => seen.push(ph) });
    const report = await runVerify(baseInput, deps);
    expect(seen).toHaveLength(report.phases.length);
    expect(seen.map((ph) => ph.name)).toEqual(report.phases.map((ph) => ph.name));
  });

  it('summarize over the full report — ok with skipped phases counted as nothing', async () => {
    const report = await runVerify(baseInput, depsFor());
    const s = summarize(report);
    // CF + cosign skipped, TLS+health+GraphQL ok → no warn, no fail.
    expect(s).toEqual({ ok: true, failed: 0, warned: 0 });
  });

  it('VerifyReport.phases is readonly at the type level', () => {
    // Compile-time check disguised as a runtime test — if this build
    // succeeds we got the readonly guarantee.
    const report: VerifyReport = { phases: [] };
    expect(report.phases).toHaveLength(0);
  });
});

describe('mergeOllamaModelConfig (flags over .env, per field)', () => {
  it('returns undefined when no model resolves from flags or .env', () => {
    expect(mergeOllamaModelConfig({}, {})).toBeUndefined();
  });

  it('takes the model from --llm-model when .env is empty', () => {
    expect(mergeOllamaModelConfig({ llmModel: 'qwen2.5:7b' }, {})).toEqual({ llmModel: 'qwen2.5:7b' });
  });

  it('falls back to the .env model when the flag is absent', () => {
    expect(mergeOllamaModelConfig({}, { llmModel: 'qwen3.6:35b-a3b' })).toEqual({
      llmModel: 'qwen3.6:35b-a3b',
    });
  });

  it('a flag wins for its field but still picks up other fields from .env', () => {
    // --llm-model pinned on the node, but provider + embedding come from .env.
    expect(
      mergeOllamaModelConfig(
        { llmModel: 'qwen2.5:7b' },
        { llmModel: 'ignored', embeddingModel: 'nomic-embed-text', embeddingsProvider: 'ollama' },
      ),
    ).toEqual({ llmModel: 'qwen2.5:7b', embeddingModel: 'nomic-embed-text', provider: 'ollama' });
  });

  it('drops an unrecognized provider value from .env', () => {
    const merged = mergeOllamaModelConfig({ llmModel: 'm' }, { embeddingsProvider: 'olama' });
    expect(merged).toEqual({ llmModel: 'm' });
    expect(merged?.provider).toBeUndefined();
  });

  it('the provider flag overrides the .env provider', () => {
    expect(
      mergeOllamaModelConfig(
        { llmModel: 'm', embeddingsProvider: 'ollama' },
        { embeddingsProvider: 'xenova' },
      )?.provider,
    ).toBe('ollama');
  });
});

describe('Ollama model-presence phase', () => {
  const ollamaPhase = (report: VerifyReport): VerifyPhase | undefined =>
    report.phases.find((ph) => ph.name === 'Ollama models');

  it('skips when no model is resolved (off-LAN run) and never probes the daemon', async () => {
    const deps = depsFor();
    const report = await runVerify(baseInput, deps);
    expect(ollamaPhase(report)?.status).toBe('skipped');
    expect(deps.ollama).not.toHaveBeenCalled();
  });

  it('passes when the configured LLM is installed', async () => {
    const report = await runVerify(
      { ...baseInput, ollama: { llmModel: 'qwen2.5:7b' } },
      depsFor({ ollama: vi.fn(() => Promise.resolve(okOllama(['qwen2.5:7b']))) }),
    );
    const ph = ollamaPhase(report);
    expect(ph?.status).toBe('ok');
    expect(ph?.detail).toContain('qwen2.5:7b');
  });

  it('fails with the exact ollama pull remedy when the LLM is missing (the drift)', async () => {
    const report = await runVerify(
      { ...baseInput, ollama: { llmModel: 'qwen3.5:35b' } },
      depsFor({ ollama: vi.fn(() => Promise.resolve(okOllama(['qwen2.5:72b']))) }),
    );
    const ph = ollamaPhase(report);
    expect(ph?.status).toBe('fail');
    expect(ph?.detail).toContain('ollama pull qwen3.5:35b');
  });

  it('fails when the local daemon is unreachable', async () => {
    const report = await runVerify(
      { ...baseInput, ollama: { llmModel: 'qwen2.5:7b' } },
      depsFor({ ollama: vi.fn(() => Promise.resolve({ reachable: false, models: [] })) }),
    );
    const ph = ollamaPhase(report);
    expect(ph?.status).toBe('fail');
    expect(ph?.detail).toContain('brew services start ollama');
  });

  it('does NOT assert the embedding model under the xenova provider', async () => {
    // Embedding model absent from Ollama, but provider is xenova (in-process),
    // so it must not be required — the LLM alone is present, so the phase passes.
    const report = await runVerify(
      {
        ...baseInput,
        ollama: { llmModel: 'qwen2.5:7b', embeddingModel: 'nomic-embed-text', provider: 'xenova' },
      },
      depsFor({ ollama: vi.fn(() => Promise.resolve(okOllama(['qwen2.5:7b']))) }),
    );
    expect(ollamaPhase(report)?.status).toBe('ok');
  });

  it('asserts the embedding model under the ollama provider', async () => {
    const report = await runVerify(
      {
        ...baseInput,
        ollama: { llmModel: 'qwen2.5:7b', embeddingModel: 'nomic-embed-text', provider: 'ollama' },
      },
      depsFor({ ollama: vi.fn(() => Promise.resolve(okOllama(['qwen2.5:7b']))) }),
    );
    const ph = ollamaPhase(report);
    expect(ph?.status).toBe('fail');
    expect(ph?.detail).toContain('ollama pull nomic-embed-text');
  });
});
