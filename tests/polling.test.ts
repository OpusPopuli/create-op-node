import { describe, expect, it, vi } from 'vitest';

import {
  type WaitDeps,
  waitForApply,
  type WaitBudgets,
  type WaitInput,
} from '../src/lib/polling.js';

function makeDeps(over: Partial<WaitDeps>): WaitDeps {
  return {
    findWorkspace: vi.fn().mockResolvedValue(null),
    getRunStatus: vi.fn().mockResolvedValue(null),
    fetchOutput: vi.fn().mockResolvedValue(null),
    sleep: vi.fn().mockResolvedValue(undefined),
    now: (() => {
      let t = 0;
      return () => (t += 1);
    })(),
    ...over,
  };
}

const BUDGETS: WaitBudgets = { discoveryMs: 100, runMs: 100, pollMs: 10 };

const INPUT: WaitInput = {
  token: 't',
  organization: 'org',
  workspaceId: 'ws-1',
  runId: 'run-1',
  workspaceTags: ['opuspopuli', 'cloudflare'],
  outputName: 'tunnel_token',
};

describe('waitForApply', () => {
  it('returns success + value when the run succeeds and output is present', async () => {
    const deps = makeDeps({
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ id: 'run-1', status: 'planning', finished: false, succeeded: false })
        .mockResolvedValueOnce({ id: 'run-1', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue('eyJh-the-token'),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r).toEqual({ kind: 'success', value: 'eyJh-the-token' });
    expect(deps.fetchOutput).toHaveBeenCalledTimes(1);
  });

  it('returns output-missing when the run succeeded but the output is null', async () => {
    const deps = makeDeps({
      getRunStatus: vi.fn().mockResolvedValueOnce({
        id: 'run-1',
        status: 'applied',
        finished: true,
        succeeded: true,
      }),
      fetchOutput: vi.fn().mockResolvedValue(null),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r.kind).toBe('output-missing');
  });

  it('returns run-failed with the status name when the run errors out', async () => {
    const deps = makeDeps({
      getRunStatus: vi.fn().mockResolvedValueOnce({
        id: 'run-1',
        status: 'errored',
        finished: true,
        succeeded: false,
      }),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r).toEqual({ kind: 'run-failed', status: 'errored' });
  });

  it('returns timeout when run keeps reporting planning past the budget', async () => {
    let now = 0;
    const deps = makeDeps({
      now: () => (now += 50),
      getRunStatus: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'planning', finished: false, succeeded: false }),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r.kind).toBe('timeout');
  });

  it('discovers a runId from the workspace when input.runId is null', async () => {
    const deps = makeDeps({
      findWorkspace: vi
        .fn()
        .mockResolvedValueOnce({ id: 'ws-1', name: 'x', currentRunId: null })
        .mockResolvedValueOnce({ id: 'ws-1', name: 'x', currentRunId: 'run-discovered' }),
      getRunStatus: vi.fn().mockResolvedValueOnce({
        id: 'run-discovered',
        status: 'applied',
        finished: true,
        succeeded: true,
      }),
      fetchOutput: vi.fn().mockResolvedValue('v'),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, BUDGETS, deps);
    expect(r.kind).toBe('success');
    // getRunStatus called with the discovered id, not the original null.
    const args = (deps.getRunStatus as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [unknown, string];
    expect(args[1]).toBe('run-discovered');
  });

  it('returns no-run-started when discovery times out without a runId', async () => {
    let now = 0;
    const deps = makeDeps({
      now: () => (now += 50),
      findWorkspace: vi.fn().mockResolvedValue(null),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, BUDGETS, deps);
    expect(r.kind).toBe('no-run-started');
  });

  it('discovery timeout does NOT eat the run-wait budget (independent clocks)', async () => {
    // Discovery uses ~all of its budget, then we should still get the full
    // runBudgetMs to wait for the run.
    const budgets: WaitBudgets = { discoveryMs: 60, runMs: 100, pollMs: 10 };
    let now = 0;
    const tick = () => (now += 10);
    const deps = makeDeps({
      now: () => tick(),
      findWorkspace: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'ws-1', name: 'x', currentRunId: 'run-late' }),
      getRunStatus: vi
        .fn()
        // First several calls report planning to consume some run-time
        .mockResolvedValueOnce({ id: 'run-late', status: 'planning', finished: false, succeeded: false })
        .mockResolvedValueOnce({ id: 'run-late', status: 'planning', finished: false, succeeded: false })
        .mockResolvedValueOnce({ id: 'run-late', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue('v'),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, budgets, deps);
    // Critically: discovery used several ticks but the run phase still finished
    // successfully because its budget was fresh.
    expect(r).toEqual({ kind: 'success', value: 'v' });
  });
});
