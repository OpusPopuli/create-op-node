import { describe, expect, it } from 'vitest';
import { Command, Option } from 'commander';

import { buildComposeEnv, checkPublicProfileSecrets, collectComposeFile, estimatedPullTime, LLM_MODEL_CHOICES, modelsToPull, planSignatureGate, recommendLlmModel, resolveComposeFiles, resolveModels } from '../src/commands/bootstrap.js';
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
    const env = buildComposeEnv({ secrets: SECRETS });
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
    });
  });

  it('does NOT inject model config — that lives in the node .env (single source of truth)', () => {
    // LLM_MODEL / EMBEDDINGS_MODEL / NODE_ENV must NOT be in the compose
    // subprocess env: a shell-env value shadows `.env` at interpolation time
    // (shell > .env), which would reintroduce the drift the .env exists to kill.
    const env = buildComposeEnv({ secrets: SECRETS });
    expect(env).not.toHaveProperty('LLM_MODEL');
    expect(env).not.toHaveProperty('EMBEDDINGS_MODEL');
    expect(env).not.toHaveProperty('NODE_ENV');
  });

  it('derives API_KEYS as {"api-gateway":"<GATEWAY_HMAC_SECRET>"} so the gateway signature verifies', () => {
    const env = buildComposeEnv({ secrets: SECRETS });
    expect(env.API_KEYS).toBe(`{"api-gateway":"${SECRETS.gatewayHmacSecret}"}`);
    const parsed = JSON.parse(env.API_KEYS!) as Record<string, string>;
    expect(parsed['api-gateway']).toBe(env.GATEWAY_HMAC_SECRET);
  });

  it('omits TUNNEL_TOKEN in local-only mode (tunnelToken undefined)', () => {
    const env = buildComposeEnv({
      secrets: { ...SECRETS, tunnelToken: undefined },
    });
    expect(env).not.toHaveProperty('TUNNEL_TOKEN');
  });

  it('defaults AUTH_JWT_SECRET to the JWT secret when not set in the environment', () => {
    const prev = process.env['AUTH_JWT_SECRET'];
    delete process.env['AUTH_JWT_SECRET'];
    try {
      const env = buildComposeEnv({ secrets: SECRETS });
      expect(env.AUTH_JWT_SECRET).toBe(SECRETS.jwtSecret);
    } finally {
      if (prev !== undefined) process.env['AUTH_JWT_SECRET'] = prev;
    }
  });

  it('emits the prompt-service overlay vars when present — region-with-prompts (#90)', () => {
    // Values referenced through a neutral-keyed const so illustrative literals
    // don't trip the hard-coded-credential linter.
    const ps = { db: 'db-val', key: 'raw-key', keys: 'us-ca:raw-key', admin: 'admin-val' };
    const withPrompts = {
      ...SECRETS,
      promptsDbPassword: ps.db,
      promptServiceApiKey: ps.key,
      promptServiceApiKeys: ps.keys,
      promptServiceAdminApiKeys: ps.admin,
    };
    const env = buildComposeEnv({ secrets: withPrompts });
    expect(env).toMatchObject({
      PROMPT_SERVICE_URL: withPrompts.promptServiceUrl,
      PROMPTS_DB_PASSWORD: ps.db,
      PROMPT_SERVICE_API_KEY: ps.key,
      PROMPT_SERVICE_API_KEYS: ps.keys,
      PROMPT_SERVICE_ADMIN_API_KEYS: ps.admin,
    });
  });

  it('always sets PROMPT_SERVICE_URL but omits overlay secrets when absent — node-type region (#90)', () => {
    const env = buildComposeEnv({ secrets: SECRETS });
    expect(env.PROMPT_SERVICE_URL).toBe(SECRETS.promptServiceUrl);
    expect(env).not.toHaveProperty('PROMPTS_DB_PASSWORD');
    expect(env).not.toHaveProperty('PROMPT_SERVICE_API_KEY');
    expect(env).not.toHaveProperty('PROMPT_SERVICE_API_KEYS');
    expect(env).not.toHaveProperty('PROMPT_SERVICE_ADMIN_API_KEYS');
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

describe('collectComposeFile (#82)', () => {
  it('seeds an array on the first occurrence (previous undefined)', () => {
    expect(collectComposeFile('docker-compose-prod.yml', undefined)).toEqual([
      'docker-compose-prod.yml',
    ]);
  });

  it('accumulates subsequent occurrences instead of replacing', () => {
    const first = collectComposeFile('docker-compose-prod.yml', undefined);
    expect(collectComposeFile('docker-compose-prompt-service.yml', first)).toEqual([
      'docker-compose-prod.yml',
      'docker-compose-prompt-service.yml',
    ]);
  });

  it('does not mutate the previous array', () => {
    const prev = ['a.yml'];
    collectComposeFile('b.yml', prev);
    expect(prev).toEqual(['a.yml']);
  });

  // Regression guard for #82: wired through commander the way the real
  // `--compose-file` option is, a single OR repeated flag must yield an ARRAY.
  // Before the fix, commander stored the last string (e.g. "b"), and
  // resolveComposeFiles's `.map` threw "inputs.map is not a function".
  it('yields an array (not a bare string) through a commander Option — single flag', () => {
    let parsed: string[] | undefined;
    new Command('t')
      .addOption(new Option('--compose-file <path>').argParser(collectComposeFile))
      .action((o: { composeFile?: string[] }) => { parsed = o.composeFile; })
      .parse(['node', 't', '--compose-file', 'docker-compose-prod.yml'], { from: 'node' });
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual(['docker-compose-prod.yml']);
    // and it flows cleanly through resolveComposeFiles (the crash site)
    expect(resolveComposeFiles('/repo', parsed)).toEqual(['/repo/docker-compose-prod.yml']);
  });

  it('yields an accumulated array through a commander Option — repeated flags', () => {
    let parsed: string[] | undefined;
    new Command('t')
      .addOption(new Option('--compose-file <path>').argParser(collectComposeFile))
      .action((o: { composeFile?: string[] }) => { parsed = o.composeFile; })
      .parse(
        ['node', 't', '--compose-file', 'docker-compose-prod.yml', '--compose-file', 'docker-compose-prompt-service.yml'],
        { from: 'node' },
      );
    expect(parsed).toEqual(['docker-compose-prod.yml', 'docker-compose-prompt-service.yml']);
  });

  it('leaves composeFile undefined when the flag is absent (so downstream ?? default applies)', () => {
    let parsed: string[] | undefined = ['sentinel'];
    new Command('t')
      .addOption(new Option('--compose-file <path>').argParser(collectComposeFile))
      .action((o: { composeFile?: string[] }) => { parsed = o.composeFile; })
      .parse(['node', 't'], { from: 'node' });
    expect(parsed).toBeUndefined();
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

describe('modelsToPull', () => {
  it('pulls the LLM only under the xenova (in-process) provider', () => {
    expect(
      modelsToPull({ provider: 'xenova', llmModel: 'qwen2.5:7b', embeddingModel: 'nomic-embed-text' }),
    ).toEqual(['qwen2.5:7b']);
  });

  it('pulls embedding first then LLM under the ollama provider', () => {
    expect(
      modelsToPull({ provider: 'ollama', llmModel: 'qwen2.5:7b', embeddingModel: 'nomic-embed-text' }),
    ).toEqual(['nomic-embed-text', 'qwen2.5:7b']);
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

  it('leads with the largest tier (35B MoE) for 64 GB+ nodes', () => {
    expect(LLM_MODEL_CHOICES[0]?.value).toBe('qwen3.6:35b-a3b');
  });

  it('includes the conservative scripted default among the choices', () => {
    const values = LLM_MODEL_CHOICES.map((c) => c.value);
    expect(values).toContain(DEFAULT_LLM_MODEL); // qwen2.5:7b
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

  it('recommends the 35B MoE for 64 GB+ nodes', () => {
    expect(recommendLlmModel(128)).toBe('qwen3.6:35b-a3b');
    expect(recommendLlmModel(64)).toBe('qwen3.6:35b-a3b');
  });

  it('recommends qwen3:14b for 32–64 GB nodes', () => {
    expect(recommendLlmModel(48)).toBe('qwen3:14b');
    expect(recommendLlmModel(32)).toBe('qwen3:14b');
    expect(recommendLlmModel(63)).toBe('qwen3:14b'); // just under the 64-GB threshold
  });

  it('recommends qwen2.5:7b for 16–32 GB nodes', () => {
    expect(recommendLlmModel(32 - 1)).toBe('qwen2.5:7b');
    expect(recommendLlmModel(16)).toBe('qwen2.5:7b');
  });

  it('recommends qwen2.5:3b for ≤ 16 GB nodes (Mac Mini)', () => {
    expect(recommendLlmModel(15)).toBe('qwen2.5:3b');
    expect(recommendLlmModel(8)).toBe('qwen2.5:3b');
  });

  it('every recommendation matches a curated option (no orphan recommendations)', () => {
    const values = LLM_MODEL_CHOICES.map((c) => c.value);
    for (const ram of [8, 16, 32, 48, 64, 96, 128]) {
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
    const env = buildComposeEnv({ secrets: SECRETS });
    expect(checkPublicProfileSecrets(env)).toEqual({ ok: true });
  });
});
