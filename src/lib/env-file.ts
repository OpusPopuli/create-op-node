/**
 * Manages the model-config block inside the operator's region-node `.env`.
 *
 * **Why a `.env` file (and why only for THIS config):**
 * docker compose resolves `${LLM_MODEL:-…}` interpolation with the precedence
 * shell/launchd env > `.env` > compose default. Model identifiers used to be
 * pushed into the launchd session via `launchctl setenv` — but that shadows
 * `.env` and, worse, only reaches launchd-spawned processes (never SSH shells
 * or a Terminal.app that was already open), so partial container recreates
 * baked divergent `LLM_MODEL` values at creation time. Writing the model to a
 * compose-auto-loaded `.env` makes every service resolve the SAME value
 * regardless of recreate order or how the operator's shell was started.
 *
 * This file deliberately carries ONLY non-secret substitution config
 * (`LLM_MODEL`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_OLLAMA_MODEL`, `NODE_ENV`).
 * Bootstrap-critical SECRETS stay in the macOS Keychain and are hydrated into
 * the compose subprocess by `bin/op-compose` (see `op-compose-script.ts`) —
 * they never touch a plaintext `.env`, preserving the vault-first principle.
 *
 * **Managed block, not full ownership:**
 * In docker-compose semantics `.env` is fundamentally the operator's file, and
 * operators hand-edit it. So we own only a delimited region:
 *
 *     # >>> op-node managed >>>
 *     LLM_MODEL=…
 *     # <<< op-node managed <<<
 *
 * Everything outside the markers is preserved verbatim. On first encounter
 * with a pre-existing `.env`, any managed keys the operator already set are
 * ADOPTED into the block (import-don't-clobber) rather than overwritten — the
 * exact drift this whole effort exists to prevent. The block is rewritten only
 * on an explicit model (re)selection (`overwrite: true`); a read-only consumer
 * like `verify` must never rewrite it.
 */

import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Delimiters bounding the region create-op-node owns. Matched exactly (after
 *  trimming) when locating an existing block. */
export const MANAGED_BEGIN = '# >>> op-node managed >>>';
export const MANAGED_END = '# <<< op-node managed <<<';

/** Keys create-op-node manages inside the block, in stable emit order so diffs
 *  across re-runs only show real value changes. */
export const MANAGED_KEYS = [
  'LLM_MODEL',
  'EMBEDDINGS_PROVIDER',
  'EMBEDDINGS_OLLAMA_MODEL',
  'NODE_ENV',
] as const;
export type ManagedKey = (typeof MANAGED_KEYS)[number];

/** `.env` value safety: model names + provider/NODE_ENV enums never contain
 *  whitespace, `#`, quotes, `$`, or newlines. Rejecting them keeps a value
 *  from silently truncating the line (inline `#`), spawning interpolation
 *  (`$`), or breaking the file across a newline. Mirrors launchagent's
 *  MODEL_NAME_RE for model ids and is a strict superset-safe check for the
 *  fixed enums. */
const ENV_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

export interface ManagedEnvSelection {
  /** Resolved LLM model id (e.g. `qwen3.6:35b-a3b`). Always present — bootstrap
   *  always resolves one via flag/prompt/default. */
  llmModel: string;
  /** Resolved embeddings model id. Written as `EMBEDDINGS_OLLAMA_MODEL` — the
   *  exact key the backend's embeddings config reads
   *  (packages/config-provider/src/configs/embeddings.config.ts). Emitted even
   *  under `xenova` (documents the intended model); only the knowledge service
   *  under `EMBEDDINGS_PROVIDER=ollama` actually reads it. */
  embeddingModel?: string;
  /** `xenova` (in-process, default) or `ollama`. */
  embeddingsProvider?: string;
  /** `development` for `--local-only` nodes; omitted otherwise. */
  nodeEnv?: string;
}

/** The managed keys mapped from the caller's selection. */
function selectionToPairs(sel: ManagedEnvSelection): ReadonlyArray<[ManagedKey, string | undefined]> {
  return [
    ['LLM_MODEL', sel.llmModel],
    ['EMBEDDINGS_PROVIDER', sel.embeddingsProvider],
    ['EMBEDDINGS_OLLAMA_MODEL', sel.embeddingModel],
    ['NODE_ENV', sel.nodeEnv],
  ];
}

export interface WriteEnvFileResult {
  ok: boolean;
  /** Absolute path to the written file, when ok=true. */
  path?: string;
  /** True when the managed block's rendered content was unchanged, so no write
   *  happened. Lets bootstrap report "already current" instead of implying a
   *  rewrite. */
  unchanged?: boolean;
  reason?: string;
}

// ----------------------------------------------------------------------------
// Pure parsing / rendering (exported for unit tests)
// ----------------------------------------------------------------------------

/**
 * Parse `KEY=value` lines into a last-wins map. Ignores blank lines and
 * comments. Deliberately simple — matches docker compose's own naive `.env`
 * reader (no quoting, no escapes, no multi-line). We only look up our own
 * MANAGED_KEYS, which are always simple tokens.
 */
export function parseEnvContent(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return out;
}

interface SplitEnv {
  /** Operator lines before the managed block (or the whole file when absent). */
  before: string[];
  /** Operator lines after the managed block. Empty when no block existed. */
  after: string[];
  /** Parsed key=value pairs found INSIDE an existing managed block. */
  blockValues: Map<string, string>;
  hasBlock: boolean;
}

/**
 * Split file content into the operator regions surrounding our managed block
 * plus the block's parsed values. When no block exists, the whole file is
 * `before` and `hasBlock` is false.
 */
export function splitManaged(content: string): SplitEnv {
  const lines = content.split('\n');
  const beginIdx = lines.findIndex((l) => l.trim() === MANAGED_BEGIN);
  if (beginIdx === -1) {
    return { before: lines, after: [], blockValues: new Map(), hasBlock: false };
  }
  const endIdx = lines.findIndex((l, i) => i > beginIdx && l.trim() === MANAGED_END);
  if (endIdx === -1) {
    // Opening marker but no close (hand-mangled). Treat everything from the
    // marker on as ours to replace — don't try to preserve a broken block.
    return {
      before: lines.slice(0, beginIdx),
      after: [],
      blockValues: parseEnvContent(lines.slice(beginIdx + 1).join('\n')),
      hasBlock: true,
    };
  }
  return {
    before: lines.slice(0, beginIdx),
    after: lines.slice(endIdx + 1),
    blockValues: parseEnvContent(lines.slice(beginIdx + 1, endIdx).join('\n')),
    hasBlock: true,
  };
}

/** Drop lines from an operator region that assign one of our managed keys —
 *  those values get consolidated INTO the block, so leaving the bare line
 *  would create a duplicate (and, if it sorts after the block, shadow it). */
function stripManagedKeyLines(region: string[]): string[] {
  return region.filter((raw) => {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) return true;
    const eq = line.indexOf('=');
    if (eq <= 0) return true;
    return !MANAGED_KEYS.includes(line.slice(0, eq).trim() as ManagedKey);
  });
}

/** Render the managed block for a set of resolved key/value pairs (only keys
 *  with a defined value are emitted). */
function renderBlock(values: ReadonlyArray<[ManagedKey, string]>): string[] {
  return [
    MANAGED_BEGIN,
    '# Auto-generated by `create-op-node bootstrap`. Non-secret model config,',
    '# read by docker compose via `.env` auto-load. Edit LLM_MODEL here to',
    '# change the model for every service; re-running bootstrap preserves your',
    "# edits unless you explicitly re-select a model. Secrets do NOT live here.",
    ...values.map(([k, v]) => `${k}=${v}`),
    MANAGED_END,
  ];
}

/**
 * Compute the final managed content from the existing file + a selection.
 *
 * Reconciliation per key:
 *   - `overwrite` (explicit model re-selection): the selection wins; fall back
 *     to any existing/imported value when the selection omits the key.
 *   - otherwise (import-don't-clobber, the default): an existing value —
 *     whether already in the block or a bare operator line being imported —
 *     is preserved; the selection only fills keys the operator hasn't set.
 *
 * Returns `null` when a resolved value fails `.env`-safety validation (caller
 * turns it into an error result).
 */
export function buildManagedEnvContent(
  existing: string,
  selection: ManagedEnvSelection,
  opts: { overwrite?: boolean } = {},
): { content: string } | { error: string } {
  const split = splitManaged(existing);
  // Bare operator lines (outside any block) that set a managed key — the
  // import-don't-clobber source on first encounter.
  const importedBefore = filterManaged(parseEnvContent(split.before.join('\n')));
  const importedAfter = filterManaged(parseEnvContent(split.after.join('\n')));

  const resolved: Array<[ManagedKey, string]> = [];
  for (const [key, selected] of selectionToPairs(selection)) {
    const existingVal =
      split.blockValues.get(key) ?? importedBefore.get(key) ?? importedAfter.get(key);
    const final = opts.overwrite ? (selected ?? existingVal) : (existingVal ?? selected);
    if (final === undefined) continue;
    if (!ENV_VALUE_RE.test(final)) {
      return { error: `${key} value ${JSON.stringify(final)} is not safe for a .env line` };
    }
    resolved.push([key, final]);
  }

  const before = stripManagedKeyLines(split.before);
  const after = stripManagedKeyLines(split.after);
  const block = renderBlock(resolved);

  // Reassemble: operator preamble, exactly one blank separator, block,
  // operator postamble. Trailing newline so the file is POSIX-clean.
  const parts = [joinTrimmed(before), block.join('\n'), joinTrimmed(after)].filter(
    (s) => s.length > 0,
  );
  return { content: parts.join('\n\n') + '\n' };
}

/** Keep only entries whose key is one we manage. */
function filterManaged(all: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of MANAGED_KEYS) {
    const v = all.get(key);
    if (v !== undefined) out.set(key, v);
  }
  return out;
}

/** Join a region and trim surrounding newlines so reassembly doesn't
 *  accumulate blank runs across re-runs. Hand-rolled (no regex) to avoid the
 *  anchored-quantifier backtracking the Sonar gate flags. */
function joinTrimmed(region: string[]): string {
  const joined = region.join('\n');
  let start = 0;
  let end = joined.length;
  while (start < end && joined[start] === '\n') start++;
  while (end > start && joined[end - 1] === '\n') end--;
  return joined.slice(start, end);
}

// ----------------------------------------------------------------------------
// Read (for verify / #97) + write
// ----------------------------------------------------------------------------

export interface NodeEnvModelConfig {
  llmModel?: string;
  embeddingModel?: string;
  embeddingsProvider?: string;
  nodeEnv?: string;
}

/**
 * Read the effective model config from `<repoDir>/.env` (last-wins across the
 * whole file, so the managed block and any operator override resolve the same
 * way docker compose would). Missing file → empty config. Read-only: never
 * rewrites the block.
 */
export async function readEnvModelConfig(repoDir: string): Promise<NodeEnvModelConfig> {
  let content: string;
  try {
    content = await readFile(join(repoDir, '.env'), 'utf8');
  } catch {
    return {};
  }
  const map = parseEnvContent(content);
  const cfg: NodeEnvModelConfig = {};
  const llm = map.get('LLM_MODEL');
  const emb = map.get('EMBEDDINGS_OLLAMA_MODEL');
  const prov = map.get('EMBEDDINGS_PROVIDER');
  const node = map.get('NODE_ENV');
  if (llm !== undefined) cfg.llmModel = llm;
  if (emb !== undefined) cfg.embeddingModel = emb;
  if (prov !== undefined) cfg.embeddingsProvider = prov;
  if (node !== undefined) cfg.nodeEnv = node;
  return cfg;
}

/**
 * Upsert the managed block in `<repoDir>/.env`, preserving all operator
 * content outside it. Writes atomically (temp + rename) so an interrupted
 * bootstrap can't leave a half-written file. Skips the write (unchanged=true)
 * when the rendered file is byte-identical to what's on disk — so a re-run
 * that changed nothing doesn't churn the file mtime.
 *
 * `overwrite: true` signals an explicit model (re)selection — the selection
 * wins. Default (false) is import-don't-clobber: existing values are kept.
 */
export async function writeManagedEnv(
  repoDir: string,
  selection: ManagedEnvSelection,
  opts: { overwrite?: boolean } = {},
): Promise<WriteEnvFileResult> {
  const target = join(repoDir, '.env');

  let existing = '';
  let existingMode: number | undefined;
  try {
    existing = await readFile(target, 'utf8');
    existingMode = (await stat(target)).mode & 0o777;
  } catch {
    // No file yet — first run.
  }

  const built = buildManagedEnvContent(existing, selection, opts);
  if ('error' in built) return { ok: false, reason: built.error };
  if (built.content === existing) return { ok: true, path: target, unchanged: true };

  // Non-secret config, but default to 0644 for a fresh file (world-readable is
  // fine and matches a normal `.env`); preserve the operator's mode if the
  // file already existed so we don't silently loosen/tighten it.
  const mode = existingMode ?? 0o644;
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(tmp, built.content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, target); // atomic on POSIX
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, reason: `writing ${target} failed: ${(err as Error).message}` };
  }
}
