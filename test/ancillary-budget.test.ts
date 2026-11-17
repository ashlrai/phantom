import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ancillaryStopReason, createAncillaryObservationBudget } from '../src/core/fleet/ancillary-budget.js';
import { runCounterfactualReplay } from '../src/core/fleet/counterfactual.js';
import { sweepRejectionLearning } from '../src/core/fleet/self-improve.js';
import type { CounterfactualOpts } from '../src/core/fleet/counterfactual.js';
import type { AshlrConfig, DecisionEntry, Proposal } from '../src/core/types.js';
import type { JudgeTrace } from '../src/core/fleet/judge-trace.js';
import type { ManagerVerdict } from '../src/core/fleet/manager.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('shares one budget and records skipped stages without launching them', async () => {
  let clock = 0;
  const skipped = vi.fn(); const later = vi.fn();
  const budget = createAncillaryObservationBudget({ now: () => clock, budgetMs: 60, onSkip: skipped });
  try {
    await budget.run('first', controls => { expect(controls.deadlineAtMs).toBe(60); clock = 60; });
    await budget.run('later', later);
    expect(later).not.toHaveBeenCalled();
    expect(skipped.mock.calls).toEqual([['first', 'ancillary-budget'], ['later', 'ancillary-budget']]);
  } finally { budget.dispose(); }
});

it('aborts active asynchronous work at the deadline, then drains it', async () => {
  vi.useFakeTimers();
  const skipped = vi.fn(); const drained = vi.fn();
  const budget = createAncillaryObservationBudget({ budgetMs: 60, onSkip: skipped });
  try {
    const work = budget.run('judge', controls => new Promise<void>(resolve => {
      controls.signal!.addEventListener('abort', () => { drained(); resolve(); }, { once: true });
    }));
    await vi.advanceTimersByTimeAsync(60); await work;
    expect(drained).toHaveBeenCalledTimes(1);
    expect(skipped).toHaveBeenCalledWith('judge', 'ancillary-budget');
  } finally { budget.dispose(); }
});

it('distinguishes phase cancellation and does not leak cancellation to later work', async () => {
  const parent = new AbortController(); const skipped = vi.fn(); const work = vi.fn();
  const budget = createAncillaryObservationBudget({ signal: parent.signal, onSkip: skipped });
  parent.abort();
  try {
    await budget.run('cancelled', work);
    expect(work).not.toHaveBeenCalled();
    expect(skipped).toHaveBeenCalledWith('cancelled', 'phase-cancelled');
    expect(ancillaryStopReason({})).toBeUndefined();
  } finally { budget.dispose(); }
});

it('does not mark successful or failed work skipped while time remains', async () => {
  const onSkip = vi.fn(); const budget = createAncillaryObservationBudget({ onSkip });
  try {
    await budget.run('empty', async () => undefined);
    await expect(budget.run('error', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(onSkip).not.toHaveBeenCalled();
  } finally { budget.dispose(); }
});

function replayOptions(): CounterfactualOpts {
  return {
    _readProposalsFn: () => ({ proposals: [{ id: 'p1', diff: '+const x = 1;', status: 'rejected' } as Proposal], sourceState: 'healthy', complete: true }),
    _readTracesFn: () => [{ proposalId: 'p1', outcome: 'rejected', verdict: 'noise', judgeEngine: 'old' } as JudgeTrace],
    _readDecisionsFn: () => [],
    _resolveJudgeFn: () => ({ model: 'fake', complete: async () => '' }),
    _judgeProposalFn: async () => ({ verdict: 'noise' } as ManagerVerdict),
    _persistFn: vi.fn(),
  };
}

it('cancels replay without publishing partial calibration and retries on a later call', async () => {
  const parent = new AbortController(); const opts = replayOptions();
  const judge = vi.fn(async (_proposal, _cfg, _client, options) => {
    expect(options.recordTrace).toBe(false);
    expect(options.signal).toBe(parent.signal);
    parent.abort();
    return { verdict: 'noise' } as ManagerVerdict;
  });
  const result = await runCounterfactualReplay({ foundry: {} } as AshlrConfig, { ...opts, signal: parent.signal, _judgeProposalFn: judge });
  expect(judge).toHaveBeenCalledTimes(1);
  expect(result.replayed).toBe(0);
  expect(result.notes).toContain('replay skipped: phase-cancelled');
  expect(opts._persistFn).not.toHaveBeenCalled();
  const retry = await runCounterfactualReplay({ foundry: {} } as AshlrConfig, opts);
  expect(retry.replayed).toBe(1);
  expect(opts._persistFn).toHaveBeenCalledTimes(1);
});

it('does not read replay sources after its budget is exhausted', async () => {
  const read = vi.fn(); const persist = vi.fn();
  const result = await runCounterfactualReplay({ foundry: {} } as AshlrConfig, { deadlineAtMs: 0, now: () => 0, _readProposalsFn: read, _persistFn: persist });
  expect(result.notes).toContain('replay skipped: ancillary-budget');
  expect(read).not.toHaveBeenCalled(); expect(persist).not.toHaveBeenCalled();
});

it('stops rejection learning before writes, then retries with existing dedup', () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ancillary-learning-')));
  const home = process.env.HOME; const ashlr = process.env.ASHLR_HOME;
  process.env.HOME = root; process.env.ASHLR_HOME = join(root, '.ashlr');
  const cfg = { foundry: { selfImprove: true } } as AshlrConfig;
  const listDecisions = () => ['p-one', 'p-two'].map(proposalId => ({ ts: new Date().toISOString(), proposalId, action: 'judged', verdict: 'noise', judgeReasonCode: 'judge-noise' } as DecisionEntry));
  try {
    const stopped = sweepRejectionLearning(cfg, { listDecisions, deadlineAtMs: 0, now: () => 0 });
    expect(stopped).toMatchObject({ scanned: 0, written: 0, sourceComplete: false, skippedReason: 'ancillary-budget' });
    let checks = 0;
    const partial = sweepRejectionLearning(cfg, { listDecisions, deadlineAtMs: 60, now: () => checks++ < 7 ? 0 : 60 });
    expect(partial).toMatchObject({ scanned: 1, written: 1, sourceComplete: false, skippedReason: 'ancillary-budget' });
    expect(sweepRejectionLearning(cfg, { listDecisions }).written).toBe(1);
    expect(sweepRejectionLearning(cfg, { listDecisions }).written).toBe(0);
  } finally {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (ashlr === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = ashlr;
    rmSync(root, { recursive: true, force: true });
  }
});
