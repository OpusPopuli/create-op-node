import { describe, expect, it } from 'vitest';

import { buildComposeEnv, checkPublicProfileSecrets, estimatedPullTime, LLM_MODEL_CHOICES, planSignatureGate, recommendLlmModel, resolveComposeFiles, resolveModels } from '../src/commands/bootstrap.js';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_LLM_MODEL } from '../src/lib/ollama.js';
import { WELL_KNOWN_GATEWAY_HMAC_SECRET } from '../src/lib/constants.js';

const SECRETS = {
  pgsodiumKey: 'a'.repeat(64),
  tunnelToken: 'ey.tunnel.tok',
  postgresPassword: 'pg-pw',
  jwtSecret: 'jwt-secret-value',
  supabaseAnonKey: 'anon.jwt',
  supabaseServiceRoleKey: 'service.jwt',
  dashboardPassword: 'dash-pw',
  gatewayHmacSecret: 'gw-hmac-real-per-node',
  grafanaAdminPassword: 'grafana-pw',
  promptServiceUrl: 'https://prompts.opuspopuli.org',
  supabaseUrl: 'https://supabase.example.org',
};

describe('buildComposeEnv', () => {
  it('maps every secret to its compose env var', () => {
    const env = buildComposeEnv({ secrets: SECRETS, llmModel: 'qwen3.5:9b', embeddingModel: 'nomic-embed-text' });
    expect(env).toMatchObject({
      PGSODIUM_ROOT_KEY: SECRETS.pgsodiumKey,
      POSTGRES_PASSWORD: SECRETS.postgresPassword,
      JWT_SECRET: SECRETS.jwtSecret,
      SUPABASE_ANON_KEY: SECRETS.supabaseAnonKey,
      SUPABASE_SERVICE_ROLE_KEY: SECRETS.supabaseServiceRoleKey,
      DASHBOARD_PASSWORD: SECRETS.dashboardPassword,
      GATEWAY_HMAC_SECRET: SECRETS.gatewayHmacSecret,
      GRAFANA_ADMIN_PASSWORD: SECRETS.grafanaAdminPassword,
      SUPABASE_URL: SECRETS.supabaseUrl,
      TUNNEL_TOKEN: SECRETS.tunnelToken,
      LLM_MODEL: 'qwen3.5:9b',
      EMBEDDINGS_MODEL: 'nomic-embed-text',
    });
  });

  it('derives API_KEYS as {"api-gateway":"<GATEWAY_HMAC_SECRET>"} so the gateway signature verifies', () => {
    const env = buildComposeEnv({ secrets: SECRETS, llmModel: 'm', embeddingModel: 'e' });
    expect(env.API_KEYS).toBe(`{"api-gateway":"${SECRETS.gatewayHmacSecret}"}`);
    const parsed = JSON.parse(env.API_KEYS!) as Record<string, string>;
    expect(parsed['api-gateway']).toBe(env.GATEWAY_HMAC_SECRET);
  });

  it('omits TUNNEL_TOKEN in local-only mode (tunnelToken undefined)', () => {
    const env = buildComposeEnv({
      secrets: { ...SECRETS, tunnelToken: undefined },
      llmModel: 'qwen3.5:9b',
      embeddingModel: 'nomic-embed-text',
    });
    expect(env).not.toHaveProperty('TUNNEL_TOKEN');
  });

  it('defaults AUTH_JWT_SECRET to the JWT secret when not set in the environment', () => {
    const prev = process.env['AUTH_JWT_SECRET'];
    delete process.env['AUTH_JWT_SECRET'];
    try {
      const env = buildComposeEnv({ secrets: SECRETS, llmModel: 'm', embeddingModel: 'e' });
      expect(env.AUTH_JWT_SECRET).toBe(SECRETS.jwtSecret);
    } finally {
      if (prev !== undefined) process.env['AUTH_JWT_SECRET'] = prev;
    }
  });
});

describe('resolveComposeFiles', () => {
  it('uses the default compose path when no flag is passed', () => {
    expect(resolveComposeFiles('/Users/op/Development/opuspopuli-node-us-ca', undefined)).toEqual([
      '/Users/op/Development/opuspopuli-node-us-ca/docker-compose-prod.yml',
    ]);
  });

  it('joins relative paths against the repo root', () => {
    expect(
      resolveComposeFiles('/repo', ['docker-compose-prod.yml', 'docker-compose-backup.yml']),
    ).toEqual([
      '/repo/docker-compose-prod.yml',
      '/repo/docker-compose-backup.yml',
    ]);
  });

  it('passes absolute paths through unchanged', () => {
    expect(
      resolveComposeFiles('/repo', ['/etc/some.yml', 'docker-compose-prod.yml']),
    ).toEqual(['/etc/some.yml', '/repo/docker-compose-prod.yml']);
  });

  it('normalizes trailing-slash repo paths via path.join', () => {
    expect(resolveComposeFiles('/repo/', ['x.yml'])).toEqual(['/repo/x.yml']);
  });
});

describe('resolveModels', () => {
  it('returns the defaults when no flags are passed', () => {
    expect(resolveModels({})).toEqual([DEFAULT_EMBEDDING_MODEL, DEFAULT_LLM_MODEL]);
  });

  it('overrides only the LLM when --llm-model is passed', () => {
    expect(resolveModels({ llmModel: 'llama3.3:70b' })).toEqual([
      DEFAULT_EMBEDDING_MODEL,
      'llama3.3:70b',
    ]);
  });

  it('overrides only the embedding model when --embedding-model is passed', () => {
    expect(resolveModels({ embeddingModel: 'mxbai-embed-large' })).toEqual([
      'mxbai-embed-large',
      DEFAULT_LLM_MODEL,
    ]);
  });

  it('overrides both when both flags are passed', () => {
    expect(
      resolveModels({ llmModel: 'qwen2.5:72b', embeddingModel: 'mxbai-embed-large' }),
    ).toEqual(['mxbai-embed-large', 'qwen2.5:72b']);
  });

  it('returns [embedding, llm] order so the small model pulls + warms first', () => {
    // Embedding models are ~500 MB; LLMs can be 40+ GB. Embedding first =
    // visible "✓" milestone before the long pull dominates. (review S3)
    const [first, second] = resolveModels({});
    expect(first).toBe(DEFAULT_EMBEDDING_MODEL);
    expect(second).toBe(DEFAULT_LLM_MODEL);
  });
});

describe('LLM_MODEL_CHOICES', () => {
  it('exports a non-empty curated list of model choices for the interactive picker', () => {
    expect(LLM_MODEL_CHOICES.length).toBeGreaterThan(0);
    for (const choice of LLM_MODEL_CHOICES) {
      expect(choice).toHaveProperty('value');
      expect(choice).toHaveProperty('label');
      expect(choice).toHaveProperty('hint');
    }
  });

  it('includes a 70B-class option as the lead choice', () => {
    expect(LLM_MODEL_CHOICES[0]?.value).toBe('qwen2.5:72b');
  });

  it('includes the 9B-class default for smaller Studios', () => {
    const values = LLM_MODEL_CHOICES.map((c) => c.value);
    expect(values).toContain(DEFAULT_LLM_MODEL); // qwen3.5:9b
  });

  it('every hint mentions RAM or pull-time so operators can pick based on hardware', () => {
    for (const choice of LLM_MODEL_CHOICES) {
      expect(choice.hint).toMatch(/RAM|min|pull/i);
    }
  });

  it('every option is a Qwen model (Spanish-language platform constraint)', () => {
    // We deliberately curate Qwen-only because Qwen has the strongest
    // multilingual + Spanish capability of the open-weight options in
    // this size class. Operators who need a non-Qwen model use "Other…"
    // at the prompt.
    for (const choice of LLM_MODEL_CHOICES) {
      expect(choice.value.toLowerCase()).toContain('qwen');
    }
  });
});

describe('estimatedPullTime', () => {
  it('returns 9B-class estimate for small models', () => {
    expect(estimatedPullTime('qwen3.5:9b')).toMatch(/3–5 min/);
    expect(estimatedPullTime('mistral:7b')).toMatch(/3–5 min/);
  });

  it('returns 32B estimate for mid-tier models', () => {
    expect(estimatedPullTime('qwen2.5:32b')).toMatch(/15–30 min/);
  });

  it('returns 70B estimate for large models', () => {
    expect(estimatedPullTime('qwen2.5:72b')).toMatch(/30–60 min/);
    expect(estimatedPullTime('llama3.3:70b')).toMatch(/30–60 min/);
  });

  it('returns frontier-MoE estimate for sparse-MoE shapes', () => {
    expect(estimatedPullTime('mixtral:8x22b-q4')).toMatch(/60\+ min/);
    // two-digit expert count still matches the bounded MoE pattern
    expect(estimatedPullTime('deepseek:16x17b')).toMatch(/60\+ min/);
  });

  it('returns frontier-class estimate for 3-digit sizes', () => {
    // e.g. DeepSeek 671B — the bounded `\d{1,4}b` group must still capture it
    expect(estimatedPullTime('deepseek-r1:671b')).toMatch(/60\+ min for frontier-class/);
    expect(estimatedPullTime('llama3.1:405b')).toMatch(/60\+ min for frontier-class/);
  });

  it('returns a soft fallback for unrecognized shapes', () => {
    expect(estimatedPullTime('unrecognized-model')).toMatch(/depends on/);
  });
});

describe('recommendLlmModel', () => {
  it('returns null when ram detection failed (caller falls back to platform default)', () => {
    expect(recommendLlmModel(null)).toBeNull();
  });

  it('recommends qwen2.5:72b for 128 GB / 96 GB Studios', () => {
    expect(recommendLlmModel(128)).toBe('qwen2.5:72b');
    expect(recommendLlmModel(96)).toBe('qwen2.5:72b');
  });

  it('recommends qwen2.5:32b for 48-64 GB Studios', () => {
    expect(recommendLlmModel(64)).toBe('qwen2.5:32b');
    expect(recommendLlmModel(48)).toBe('qwen2.5:32b');
    expect(recommendLlmModel(95)).toBe('qwen2.5:32b'); // just under the 96-GB threshold
  });

  it('recommends qwen3.5:9b for ≤ 36 GB Studios', () => {
    expect(recommendLlmModel(36)).toBe('qwen3.5:9b');
    expect(recommendLlmModel(16)).toBe('qwen3.5:9b');
    expect(recommendLlmModel(47)).toBe('qwen3.5:9b'); // just under the 48-GB threshold
  });

  it('every recommendation matches a curated option (no orphan recommendations)', () => {
    const values = LLM_MODEL_CHOICES.map((c) => c.value);
    for (const ram of [16, 36, 48, 64, 96, 128]) {
      const rec = recommendLlmModel(ram);
      expect(rec).not.toBeNull();
      expect(values).toContain(rec!);
    }
  });
});

describe('planSignatureGate (fail-closed image gate — #34)', () => {
  const imgs = [
    'ghcr.io/opuspopuli/api:latest',
    'postgres:16',
    'ghcr.io/opuspopuli/region-worker:sha-abc',
  ];

  it('bypasses when --skip-signature-check is set (even with images present)', () => {
    expect(planSignatureGate(imgs, { skipSignatureCheck: true })).toEqual({ kind: 'skip' });
  });

  it('reports enumerate-failed when the compose image list is null', () => {
    expect(planSignatureGate(null, {})).toEqual({ kind: 'enumerate-failed' });
  });

  it('reports no-images when nothing matches the opuspopuli prefix', () => {
    expect(planSignatureGate(['postgres:16', 'redis:7'], {})).toEqual({ kind: 'no-images' });
  });

  it('plans to verify only the opuspopuli-published images', () => {
    expect(planSignatureGate(imgs, {})).toEqual({
      kind: 'verify',
      images: ['ghcr.io/opuspopuli/api:latest', 'ghcr.io/opuspopuli/region-worker:sha-abc'],
    });
  });

  it('skip takes precedence over a null image list', () => {
    expect(planSignatureGate(null, { skipSignatureCheck: true })).toEqual({ kind: 'skip' });
  });
});

describe('checkPublicProfileSecrets (public-profile HMAC guard — #27)', () => {
  const realKeys = {
    GATEWAY_HMAC_SECRET: 'gw-hmac-real-per-node',
    API_KEYS: '{"api-gateway":"gw-hmac-real-per-node"}',
  };

  it('allows real per-node values', () => {
    expect(checkPublicProfileSecrets(realKeys)).toEqual({ ok: true });
  });

  it('rejects the well-known default GATEWAY_HMAC_SECRET', () => {
    const verdict = checkPublicProfileSecrets({
      GATEWAY_HMAC_SECRET: WELL_KNOWN_GATEWAY_HMAC_SECRET,
      API_KEYS: `{"api-gateway":"${WELL_KNOWN_GATEWAY_HMAC_SECRET}"}`,
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toMatch(/well-known/i);
  });

  it('rejects when API_KEYS still wraps the well-known default even if GATEWAY_HMAC_SECRET is real', () => {
    const verdict = checkPublicProfileSecrets({
      GATEWAY_HMAC_SECRET: 'gw-hmac-real-per-node',
      API_KEYS: `{"api-gateway":"${WELL_KNOWN_GATEWAY_HMAC_SECRET}"}`,
    });
    expect(verdict.ok).toBe(false);
  });

  it('rejects an unset GATEWAY_HMAC_SECRET', () => {
    expect(checkPublicProfileSecrets({ API_KEYS: realKeys.API_KEYS }).ok).toBe(false);
  });

  it('rejects an unset API_KEYS', () => {
    expect(
      checkPublicProfileSecrets({ GATEWAY_HMAC_SECRET: realKeys.GATEWAY_HMAC_SECRET }).ok,
    ).toBe(false);
  });

  it('rejects an empty-string value', () => {
    expect(
      checkPublicProfileSecrets({ GATEWAY_HMAC_SECRET: '', API_KEYS: realKeys.API_KEYS }).ok,
    ).toBe(false);
  });

  it('accepts the env buildComposeEnv produces for a real bootstrap', () => {
    // End-to-end: the guard must PASS on exactly what bootstrap injects, so a
    // normal production bootstrap is never blocked by its own backstop.
    const env = buildComposeEnv({ secrets: SECRETS, llmModel: 'm', embeddingModel: 'e' });
    expect(checkPublicProfileSecrets(env)).toEqual({ ok: true });
  });
});
