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
    fetchOutput: vi.fn().mockResolvedValue({ kind: 'absent' }),
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
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'eyJh-the-token' }),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r).toEqual({ kind: 'success', value: 'eyJh-the-token' });
    expect(deps.fetchOutput).toHaveBeenCalledTimes(1);
  });

  it('returns output-missing when the run succeeded but the output is genuinely absent', async () => {
    const deps = makeDeps({
      getRunStatus: vi.fn().mockResolvedValueOnce({
        id: 'run-1',
        status: 'applied',
        finished: true,
        succeeded: true,
      }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'absent' }),
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
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'v' }),
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
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'v' }),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, budgets, deps);
    // Critically: discovery used several ticks but the run phase still finished
    // successfully because its budget was fresh.
    expect(r).toEqual({ kind: 'success', value: 'v' });
  });
});

describe('waitForApply — transient failure resilience (issue #31)', () => {
  it('retries the run poll when getRunStatus throws once, then completes', async () => {
    const deps = makeDeps({
      getRunStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce({ id: 'run-1', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'the-token' }),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r).toEqual({ kind: 'success', value: 'the-token' });
    expect(deps.getRunStatus).toHaveBeenCalledTimes(2);
  });

  it('retries discovery when findWorkspace throws once, then finds the run', async () => {
    const deps = makeDeps({
      findWorkspace: vi
        .fn()
        .mockRejectedValueOnce(new Error('DNS blip'))
        .mockResolvedValueOnce({ id: 'ws-1', name: 'ca', currentRunId: 'run-9' }),
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ id: 'run-9', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'tok' }),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, BUDGETS, deps);
    expect(r.kind).toBe('success');
    expect(deps.findWorkspace).toHaveBeenCalledTimes(2);
  });

  it('signals onProgress("retry") when a poll throws (not silent)', async () => {
    const onProgress = vi.fn();
    const deps = makeDeps({
      onProgress,
      getRunStatus: vi
        .fn()
        .mockRejectedValueOnce(new Error('blip'))
        .mockResolvedValueOnce({ id: 'run-1', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'tok' }),
    });
    await waitForApply(INPUT, BUDGETS, deps);
    expect(onProgress).toHaveBeenCalledWith('retry');
  });
});

describe('waitForApply — transient output-fetch retry (issue #59)', () => {
  it('retries a transient error on the final output fetch, then succeeds', async () => {
    const onProgress = vi.fn();
    const deps = makeDeps({
      onProgress,
      getRunStatus: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'applied', finished: true, succeeded: true }),
      // First fetch after apply hits a network blip (error), second returns the value.
      fetchOutput: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'error' })
        .mockResolvedValueOnce({ kind: 'value', value: 'recovered-token' }),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    // Not misreported as output-missing — the blip is retried within budget.
    expect(r).toEqual({ kind: 'success', value: 'recovered-token' });
    expect(deps.fetchOutput).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith('retry');
  });

  it('reports timeout (not output-missing) when the output fetch keeps erroring', async () => {
    let now = 0;
    const deps = makeDeps({
      now: () => (now += 50),
      getRunStatus: vi
        .fn()
        .mockResolvedValue({ id: 'run-1', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'error' }),
    });
    const r = await waitForApply(INPUT, BUDGETS, deps);
    expect(r.kind).toBe('timeout');
  });
});

describe('waitForApply — discovery checks before sleeping (issue #35)', () => {
  it('checks the workspace before the first sleep and finds an existing run at t=0', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      sleep: vi.fn(async () => {
        order.push('sleep');
      }),
      findWorkspace: vi.fn(async () => {
        order.push('find');
        return { id: 'ws-1', name: 'x', currentRunId: 'run-0' };
      }),
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ id: 'run-0', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'v' }),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, BUDGETS, deps);
    expect(r.kind).toBe('success');
    expect(order[0]).toBe('find'); // checked before any discovery sleep
    expect(deps.sleep).not.toHaveBeenCalled(); // found at t=0, never slept
  });

  it('calls findWorkspace at least once even when pollMs >= discoveryMs', async () => {
    const budgets: WaitBudgets = { discoveryMs: 10, runMs: 100, pollMs: 1000 };
    const deps = makeDeps({
      findWorkspace: vi
        .fn()
        .mockResolvedValue({ id: 'ws-1', name: 'x', currentRunId: 'run-x' }),
      getRunStatus: vi
        .fn()
        .mockResolvedValueOnce({ id: 'run-x', status: 'applied', finished: true, succeeded: true }),
      fetchOutput: vi.fn().mockResolvedValue({ kind: 'value', value: 'v' }),
    });
    const r = await waitForApply({ ...INPUT, runId: null }, budgets, deps);
    expect(deps.findWorkspace).toHaveBeenCalled();
    expect(r.kind).toBe('success'); // discovered at t=0 despite pollMs > discoveryMs
  });
});
