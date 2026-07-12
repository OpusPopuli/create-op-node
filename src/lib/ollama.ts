/**
 * Ollama service + model management.
 *
 * Ollama is installed via Homebrew (handled by `lib/homebrew.ts`) and started
 * as a `brew services` job. This lib covers what the wizard does after that:
 *
 *   - HTTP health check on `localhost:11434` (the running daemon).
 *   - List installed models via the HTTP API (avoids parsing `ollama list`'s
 *     human-formatted output).
 *   - Pull a model — shells out to `ollama pull <name>` because the HTTP
 *     `/api/pull` endpoint streams NDJSON progress and is awkward to consume.
 *   - Warm a model with a single trivial generation so the first user request
 *     doesn't pay a ~90s cold-start.
 *   - Probe that containers can reach the host's Ollama via
 *     `host.docker.internal` — common Docker Desktop configuration mistake.
 */

import { safeExeca } from './exec.js';

export const OLLAMA_URL = 'http://localhost:11434';

/** Health probe (`/api/tags`) is a metadata read — it should answer almost
 *  instantly, so a short timeout keeps a hung daemon from stalling bootstrap. */
const OLLAMA_HEALTH_TIMEOUT_MS = 5_000;

/** Warming (`/api/generate`) loads the model into VRAM on first call, which
 *  for a 50 GB model legitimately takes minutes — hence a generous cap that
 *  still bounds a truly-wedged daemon. */
const OLLAMA_WARM_TIMEOUT_MS = 120_000;

/** Conservative default LLM for the `--yes` / scripted path and the fallback
 *  when unified-memory detection fails. Sized to fit a 16 GB machine once the
 *  ~22-container stack + Postgres take their share — capable enough to
 *  validate the inference path end-to-end. Interactive bootstrap tiers UP from
 *  here based on detected RAM (see `recommendLlmModel`); operators can override
 *  at bootstrap time with `--llm-model`. */
export const DEFAULT_LLM_MODEL = 'qwen2.5:7b';

/** Default embedding model used by the knowledge service when
 *  `EMBEDDINGS_PROVIDER=ollama`. With the default `xenova` (in-process)
 *  provider, this isn't pulled. Operators can override with
 *  `--embedding-model`. */
export const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';

/** Where embeddings are computed: `xenova` runs in-process (no Ollama pull
 *  needed), `ollama` uses the host daemon with DEFAULT_EMBEDDING_MODEL. */
export type EmbeddingsProvider = 'xenova' | 'ollama';

/** Platform default — in-process embeddings, so a fresh node needs no
 *  embedding-model pull unless the operator opts into the Ollama provider. */
export const DEFAULT_EMBEDDINGS_PROVIDER: EmbeddingsProvider = 'xenova';

/** Default model pull set for `bootstrap`. Kept as a `as const`-typed array
 *  so existing code can iterate without re-deriving from the two scalars. */
export const DEFAULT_MODELS = [DEFAULT_LLM_MODEL, DEFAULT_EMBEDDING_MODEL] as const;

/** Pinned alpine tag for the host.docker.internal probe. Latest is fine in
 *  practice (the image only runs `curl`) but pinning keeps the probe
 *  reproducible across operator machines. Bump when alpine cuts a major. */
export const PROBE_ALPINE_TAG = '3.20';

export interface OllamaHealth {
  /** True when the daemon answered the `/api/tags` probe with 200. */
  reachable: boolean;
  /** Names of currently-installed models, when reachable. */
  models: string[];
}

/**
 * Probe the daemon. We use `/api/tags` because it's the cheapest endpoint
 * that proves both reachability AND that the server is past initial bring-up
 * (a bare TCP-accept-but-not-ready Ollama returns 404 here, not 200).
 */
/**
 * Try to start the Ollama service via `brew services start ollama`.
 * Idempotent — brew services no-ops on an already-started service. Returns
 * `ok: false` only if brew itself is missing or the start command errored
 * for a non-trivial reason.
 */
export async function startOllamaService(): Promise<{ ok: boolean; reason?: string }> {
  const res = await safeExeca('brew', ['services', 'start', 'ollama']);
  if (res === null) return { ok: false, reason: '`brew` not on PATH' };
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason: `brew services start ollama failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true };
}

export async function checkOllamaHealth(url: string = OLLAMA_URL): Promise<OllamaHealth> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/tags`, { signal: ctrl.signal });
    if (!res.ok) return { reachable: false, models: [] };
    const body = (await res.json()) as { models?: Array<{ name?: string }> };
    const models = (body.models ?? [])
      .map((m) => m.name ?? '')
      .filter((n) => n.length > 0);
    return { reachable: true, models };
  } catch {
    // Unreachable, non-200, non-JSON, or timed out (AbortError) — all "not
    // healthy" from the caller's perspective.
    return { reachable: false, models: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Is `configured` present in the `installed` model list (from
 * `checkOllamaHealth().models` / `ollama list`)?
 *
 * Ollama treats a bare model name as its `:latest` tag — `ollama pull qwen2.5`
 * installs `qwen2.5:latest`, and `/api/tags` reports the fully-qualified name.
 * So we normalize BOTH sides to an explicit tag before comparing: a config of
 * `qwen2.5` matches an installed `qwen2.5:latest`, and vice-versa. A tag
 * mismatch (the incident: configured `qwen3.5:35b` vs installed `qwen2.5:72b`)
 * correctly returns false. Pure helper — the presence-check core for `verify`.
 */
export function modelPresent(configured: string, installed: readonly string[]): boolean {
  const norm = (m: string): string => (m.includes(':') ? m : `${m}:latest`);
  const target = norm(configured);
  return installed.some((m) => norm(m) === target);
}

export interface PullResult {
  ok: boolean;
  /** Set when ok=false. */
  reason?: string;
}

/**
 * Pull a model. `ollama pull` is idempotent — re-pulling a present model is
 * a fast no-op — so we don't pre-check installation.
 */
export async function pullModel(name: string): Promise<PullResult> {
  const res = await safeExeca('ollama', ['pull', name]);
  if (res === null) return { ok: false, reason: '`ollama` not on PATH' };
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason: `ollama pull ${name} failed (${res.exitCode ?? 'signal'}): ${res.stderr || res.stdout}`,
    };
  }
  return { ok: true };
}

export interface WarmResult {
  ok: boolean;
  reason?: string;
}

/**
 * Send a trivial `/api/generate` call so the model loads into memory. First
 * request on a cold daemon can take 30-90s; that latency lands on the wizard,
 * not on a real user. We stream=false + ignore the response body.
 */
export async function warmModel(name: string, url: string = OLLAMA_URL): Promise<WarmResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OLLAMA_WARM_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name, prompt: 'hi', stream: false }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        ok: false,
        reason: `warm ${name} returned HTTP ${res.status}: ${text || '(no body)'}`,
      };
    }
    // Drain the body to ensure the model finished loading.
    await res.text();
    return { ok: true };
  } catch (err) {
    const reason =
      (err as Error).name === 'AbortError'
        ? `warm ${name} timed out after ${OLLAMA_WARM_TIMEOUT_MS / 1000}s`
        : `warm ${name} failed: ${(err as Error).message}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify Docker containers can reach the host's Ollama via
 * `host.docker.internal`. Operators sometimes disable that hostname in Docker
 * Desktop settings; this probe catches the misconfig before the stack comes
 * up and fails opaquely.
 */
export async function probeHostDockerInternal(): Promise<{ ok: boolean; reason?: string }> {
  const res = await safeExeca('docker', [
    'run',
    '--rm',
    `alpine:${PROBE_ALPINE_TAG}`,
    'sh',
    '-c',
    'apk add --no-cache curl >/dev/null 2>&1 && curl -fsS http://host.docker.internal:11434/api/tags',
  ]);
  if (res === null) return { ok: false, reason: '`docker` not on PATH' };
  if (res.exitCode !== 0) {
    return {
      ok: false,
      reason:
        `container couldn't reach host.docker.internal:11434 — check Docker Desktop ` +
        `settings → Resources → Network → Enable host.docker.internal`,
    };
  }
  return { ok: true };
}

export interface SetupReport {
  pulled: string[];
  alreadyPresent: string[];
  failed: Array<{ model: string; reason: string }>;
  warmed: string[];
}

/**
 * Pull each model in `models` (skipping already-present ones) and warm the
 * first one. Continues past per-model failures so the operator sees the
 * whole landscape.
 */
export async function setupModels(
  models: readonly string[],
  onProgress?: (model: string, status: 'present' | 'pulling' | 'pulled' | 'failed' | 'warming' | 'warmed') => void,
): Promise<SetupReport> {
  const report: SetupReport = {
    pulled: [],
    alreadyPresent: [],
    failed: [],
    warmed: [],
  };

  const health = await checkOllamaHealth();
  const present = new Set(health.models);

  for (const m of models) {
    if (present.has(m)) {
      report.alreadyPresent.push(m);
      onProgress?.(m, 'present');
      continue;
    }
    onProgress?.(m, 'pulling');
    const r = await pullModel(m);
    if (r.ok) {
      report.pulled.push(m);
      onProgress?.(m, 'pulled');
    } else {
      report.failed.push({ model: m, reason: r.reason ?? 'unknown' });
      onProgress?.(m, 'failed');
    }
  }

  // Warm the first model that exists by name in the user-supplied list, not
  // necessarily the first to pull successfully — keeps the warm target
  // predictable for tests + operator UX.
  const warmTarget = models.find((m) => present.has(m) || report.pulled.includes(m));
  if (warmTarget) {
    onProgress?.(warmTarget, 'warming');
    const w = await warmModel(warmTarget);
    if (w.ok) {
      report.warmed.push(warmTarget);
      onProgress?.(warmTarget, 'warmed');
    }
    // A failed warm-up isn't fatal — it just means the first real user
    // request pays the cold-start cost. Surface in the report.
  }

  return report;
}
