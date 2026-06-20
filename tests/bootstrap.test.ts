import { describe, expect, it } from 'vitest';

import { estimatedPullTime, LLM_MODEL_CHOICES, resolveComposeFiles, resolveModels } from '../src/commands/bootstrap.js';
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_LLM_MODEL } from '../src/lib/ollama.js';

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
  });

  it('returns a soft fallback for unrecognized shapes', () => {
    expect(estimatedPullTime('unrecognized-model')).toMatch(/depends on/);
  });
});
