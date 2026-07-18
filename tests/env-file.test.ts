import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildManagedEnvContent,
  MANAGED_BEGIN,
  MANAGED_END,
  parseEnvContent,
  readEnvModelConfig,
  splitManaged,
  writeManagedEnv,
} from '../src/lib/env-file.js';

/** Count occurrences of a `KEY=` assignment across the whole rendered file. */
function countAssignments(content: string, key: string): number {
  return content.split('\n').filter((l) => l.trim().startsWith(`${key}=`)).length;
}

describe('parseEnvContent', () => {
  it('parses KEY=value, ignoring blanks + comments, last-wins on dupes', () => {
    const map = parseEnvContent('# c\nA=1\n\nB=two\nA=override\n');
    expect(map.get('A')).toBe('override');
    expect(map.get('B')).toBe('two');
    expect(map.has('# c')).toBe(false);
  });
});

describe('buildManagedEnvContent — fresh file', () => {
  it('emits a managed block with the selected model config', () => {
    const built = buildManagedEnvContent('', {
      llmModel: 'qwen3.6:35b-a3b',
      embeddingModel: 'nomic-embed-text',
      embeddingsProvider: 'ollama',
      nodeEnv: 'development',
      supabaseUrl: 'https://supabase.us-ca.opuspopuli.org',
    });
    expect('content' in built).toBe(true);
    if (!('content' in built)) return;
    const map = parseEnvContent(built.content);
    expect(map.get('LLM_MODEL')).toBe('qwen3.6:35b-a3b');
    expect(map.get('EMBEDDINGS_PROVIDER')).toBe('ollama');
    expect(map.get('EMBEDDINGS_OLLAMA_MODEL')).toBe('nomic-embed-text');
    expect(map.get('NODE_ENV')).toBe('development');
    expect(map.get('SUPABASE_URL')).toBe('https://supabase.us-ca.opuspopuli.org');
    expect(built.content).toContain(MANAGED_BEGIN);
    expect(built.content).toContain(MANAGED_END);
  });

  it('preserves an operator SUPABASE_URL override on re-run (import, not clobber)', () => {
    // Operator pinned a public URL outside the block; a later bootstrap without
    // overwrite must not stomp it back to a bootstrap default.
    const existing = 'SUPABASE_URL=https://supabase.custom.example.org\n';
    const built = buildManagedEnvContent(existing, {
      llmModel: 'qwen2.5:7b',
      supabaseUrl: 'http://localhost:8000',
    });
    if (!('content' in built)) throw new Error('expected content');
    expect(parseEnvContent(built.content).get('SUPABASE_URL')).toBe(
      'https://supabase.custom.example.org',
    );
  });

  it('omits NODE_ENV when nodeEnv is not supplied (production node)', () => {
    const built = buildManagedEnvContent('', { llmModel: 'qwen2.5:7b', embeddingsProvider: 'xenova' });
    if (!('content' in built)) throw new Error('expected content');
    expect(built.content).not.toContain('NODE_ENV');
  });
});

describe('buildManagedEnvContent — preserves operator content', () => {
  it('keeps operator lines outside the managed block verbatim', () => {
    const existing = 'FOO=bar\n# operator note\nBAZ=qux\n';
    const built = buildManagedEnvContent(existing, { llmModel: 'qwen2.5:7b' }, { overwrite: true });
    if (!('content' in built)) throw new Error('expected content');
    expect(built.content).toContain('FOO=bar');
    expect(built.content).toContain('# operator note');
    expect(built.content).toContain('BAZ=qux');
    expect(parseEnvContent(built.content).get('LLM_MODEL')).toBe('qwen2.5:7b');
  });
});

describe('buildManagedEnvContent — import-don\'t-clobber', () => {
  const existing = 'NODE_ENV=development\nLLM_MODEL=qwen3.6:35b-a3b\nUNRELATED=keepme\n';

  it('adopts a pre-existing bare value into the block instead of overwriting (default)', () => {
    // Simulates the us-ca node: a hand-written .env whose LLM_MODEL must survive
    // a re-run that would otherwise apply a stale default.
    const built = buildManagedEnvContent(existing, { llmModel: 'qwen2.5:7b' });
    if (!('content' in built)) throw new Error('expected content');
    const map = parseEnvContent(built.content);
    expect(map.get('LLM_MODEL')).toBe('qwen3.6:35b-a3b'); // operator's value, not the default
    expect(map.get('NODE_ENV')).toBe('development'); // imported too
    expect(built.content).toContain('UNRELATED=keepme');
  });

  it('consolidates the imported bare key into the block (no duplicate assignment)', () => {
    const built = buildManagedEnvContent(existing, { llmModel: 'qwen2.5:7b' });
    if (!('content' in built)) throw new Error('expected content');
    expect(countAssignments(built.content, 'LLM_MODEL')).toBe(1);
    // and the surviving assignment sits inside the managed block
    const split = splitManaged(built.content);
    expect(split.blockValues.get('LLM_MODEL')).toBe('qwen3.6:35b-a3b');
  });

  it('overwrite:true (explicit re-selection) replaces the operator value', () => {
    const built = buildManagedEnvContent(existing, { llmModel: 'qwen2.5:7b' }, { overwrite: true });
    if (!('content' in built)) throw new Error('expected content');
    expect(parseEnvContent(built.content).get('LLM_MODEL')).toBe('qwen2.5:7b');
  });
});

describe('buildManagedEnvContent — idempotent', () => {
  it('re-running with the same selection yields byte-identical content', () => {
    const first = buildManagedEnvContent('FOO=bar\n', { llmModel: 'qwen2.5:7b', embeddingsProvider: 'xenova' }, { overwrite: true });
    if (!('content' in first)) throw new Error('expected content');
    const second = buildManagedEnvContent(first.content, { llmModel: 'qwen2.5:7b', embeddingsProvider: 'xenova' }, { overwrite: true });
    if (!('content' in second)) throw new Error('expected content');
    expect(second.content).toBe(first.content);
  });
});

describe('buildManagedEnvContent — validation', () => {
  it('rejects a value that would break a .env line', () => {
    for (const evil of ['evil;rm -rf', 'has space', 'a\nb', 'q$(x)', 'quote"d']) {
      const built = buildManagedEnvContent('', { llmModel: evil });
      expect('error' in built).toBe(true);
    }
  });
});

describe('writeManagedEnv + readEnvModelConfig (round-trip)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'op-env-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes .env and reads the config back', async () => {
    const res = await writeManagedEnv(
      dir,
      { llmModel: 'qwen3.6:35b-a3b', embeddingModel: 'nomic-embed-text', embeddingsProvider: 'ollama' },
      { overwrite: true },
    );
    expect(res.ok).toBe(true);
    expect(res.path).toBe(join(dir, '.env'));

    const cfg = await readEnvModelConfig(dir);
    expect(cfg.llmModel).toBe('qwen3.6:35b-a3b');
    expect(cfg.embeddingModel).toBe('nomic-embed-text');
    expect(cfg.embeddingsProvider).toBe('ollama');
  });

  it('reports unchanged (no rewrite) when content is already current', async () => {
    const sel = { llmModel: 'qwen2.5:7b', embeddingsProvider: 'xenova' as const };
    const first = await writeManagedEnv(dir, sel, { overwrite: true });
    expect(first.unchanged).not.toBe(true);
    const second = await writeManagedEnv(dir, sel, { overwrite: true });
    expect(second.ok).toBe(true);
    expect(second.unchanged).toBe(true);
  });

  it('preserves an operator-authored line already present in .env', async () => {
    await writeFile(join(dir, '.env'), 'CUSTOM=keepme\nLLM_MODEL=qwen3.6:35b-a3b\n');
    // Non-overwrite run (e.g. a re-bootstrap that didn't re-select): operator
    // value is imported, custom line preserved.
    await writeManagedEnv(dir, { llmModel: 'qwen2.5:7b' });
    const raw = await readFile(join(dir, '.env'), 'utf8');
    expect(raw).toContain('CUSTOM=keepme');
    expect(parseEnvContent(raw).get('LLM_MODEL')).toBe('qwen3.6:35b-a3b');
  });

  it('returns empty config when no .env exists', async () => {
    const cfg = await readEnvModelConfig(dir);
    expect(cfg).toEqual({});
  });
});
