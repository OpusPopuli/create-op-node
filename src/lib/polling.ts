/**
 * Generic two-phase TFC apply-and-output wait. Two independent clocks:
 *
 *   1. **Discovery phase** — wait for the workspace to have a current run.
 *      The cloudflare-infra workflow takes a few seconds to dispatch to TFC
 *      after the operator merges the PR, so we re-poll the workspace until
 *      a run id appears or the discovery budget elapses.
 *   2. **Run phase** — wait for that run to reach a terminal state. Sharing
 *      one clock with discovery would let slow discovery eat the run-wait
 *      budget; two independent clocks isolate them.
 *
 * Dependencies are injected so unit tests can drive the loop without real
 * timers or HTTP. `sleep` is a parameter; tests pass a no-op.
 */

import { fetchOutput, findWorkspace, getRunStatus } from './tfc.js';

export interface WaitInput {
  token: string;
  organization: string;
  workspaceId: string;
  /** Last-known run id when starting. `null` triggers the discovery phase. */
  runId: string | null;
  /** Tags used to re-discover the workspace's current run id. */
  workspaceTags: string[];
  /** Output to pull once the run is `applied`. */
  outputName: string;
}

export interface WaitBudgets {
  discoveryMs: number;
  runMs: number;
  pollMs: number;
}

export const DEFAULT_BUDGETS: WaitBudgets = {
  discoveryMs: 60 * 1000,
  runMs: 10 * 60 * 1000,
  pollMs: 10 * 1000,
};

export type WaitOutcome =
  | { kind: 'success'; value: string }
  | { kind: 'output-missing' }
  | { kind: 'no-run-started' }
  | { kind: 'run-failed'; status: string }
  | { kind: 'timeout' };

/** Test seam: lets tests inject fake findWorkspace / getRunStatus / fetchOutput. */
export interface WaitDeps {
  findWorkspace: typeof findWorkspace;
  getRunStatus: typeof getRunStatus;
  fetchOutput: typeof fetchOutput;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Optional progress callback for UI integration (spinner messages, etc.). */
  onProgress?: (phase: 'discovery' | 'run' | 'fetching' | 'retry') => void;
}

export const realDeps: WaitDeps = {
  findWorkspace,
  getRunStatus,
  fetchOutput,
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  now: () => Date.now(),
};

/**
 * Pure polling implementation. Returns a discriminated outcome so the caller
 * can render the right message for each terminal state.
 */
export async function waitForApply(
  input: WaitInput,
  budgets: WaitBudgets = DEFAULT_BUDGETS,
  deps: WaitDeps = realDeps,
): Promise<WaitOutcome> {
  let runId = input.runId;
  if (!runId) {
    runId = await discoverRunId(input, budgets, deps);
    if (!runId) return { kind: 'no-run-started' };
  }
  return waitForRunOutput(input, budgets, deps, runId);
}

// Run a single poll attempt, degrading any throw to `null` (treated as "no
// result this interval, try again"). Keeps a transient network failure from
// rejecting out of the multi-minute wait loops. `onRetry` fires on a swallowed
// throw so the caller can surface the hiccup instead of retrying in silence.
async function safePoll<T>(
  fn: () => Promise<T | null>,
  onRetry?: () => void,
): Promise<T | null> {
  try {
    return await fn();
  } catch {
    onRetry?.();
    return null;
  }
}

// Phase 1: discovery — poll the workspace until it has a current run, or the
// discovery budget expires. Returns the run id, or null on timeout.
async function discoverRunId(
  input: WaitInput,
  budgets: WaitBudgets,
  deps: WaitDeps,
): Promise<string | null> {
  deps.onProgress?.('discovery');
  const discoveryStart = deps.now();
  // Check first, THEN sleep: a run that already exists is found at t=0 rather
  // than a poll-interval late, and findWorkspace always runs at least once
  // regardless of the pollMs/discoveryMs ratio. (#35)
  while (deps.now() - discoveryStart < budgets.discoveryMs) {
    // A transient failure is not fatal to a multi-minute discovery window —
    // swallow it and retry on the next poll rather than rejecting the wait.
    // (The tfc helpers already degrade throws to null, so this is
    // belt-and-suspenders against any future throwing dep.)
    const ws = await safePoll(
      () =>
        deps.findWorkspace({
          token: input.token,
          organization: input.organization,
          tags: input.workspaceTags,
        }),
      () => deps.onProgress?.('retry'),
    );
    if (ws?.currentRunId) return ws.currentRunId;
    await deps.sleep(budgets.pollMs);
  }
  return null;
}

// Phase 2: run wait — poll the run until it finishes (fetching the output on
// success), or the run budget expires.
async function waitForRunOutput(
  input: WaitInput,
  budgets: WaitBudgets,
  deps: WaitDeps,
  runId: string,
): Promise<WaitOutcome> {
  deps.onProgress?.('run');
  const runStart = deps.now();
  while (deps.now() - runStart < budgets.runMs) {
    // Transient status-poll failure → retry next interval, don't abort the
    // ~10-minute run wait on a single bad packet.
    const r = await safePoll(
      () => deps.getRunStatus({ token: input.token, organization: input.organization }, runId),
      () => deps.onProgress?.('retry'),
    );
    if (r?.finished) {
      if (!r.succeeded) return { kind: 'run-failed', status: r.status };
      deps.onProgress?.('fetching');
      const value = await safePoll(
        () =>
          deps.fetchOutput(
            { token: input.token, organization: input.organization },
            input.workspaceId,
            input.outputName,
          ),
        () => deps.onProgress?.('retry'),
      );
      return value !== null ? { kind: 'success', value } : { kind: 'output-missing' };
    }
    await deps.sleep(budgets.pollMs);
  }

  return { kind: 'timeout' };
}
