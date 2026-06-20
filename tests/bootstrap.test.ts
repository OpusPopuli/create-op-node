import { describe, expect, it } from 'vitest';

import { resolveComposeFiles, resolveModels } from '../src/commands/bootstrap.js';
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
