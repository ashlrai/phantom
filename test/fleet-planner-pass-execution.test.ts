import { expect, it, vi } from 'vitest';
import { executePlannerPass, type PlannerPassDeps } from '../src/core/fleet/planner-pass.js';

function fixture() {
  const deps = {
    readCandidates: vi.fn<PlannerPassDeps['readCandidates']>().mockResolvedValue({ source: 'ok', path: '/fake/slate', candidates: [{ provider: 'fake-live', argv: ['fake-runner'] }], lastProvider: 'fake-limited' }),
    plan: vi.fn<PlannerPassDeps['plan']>().mockResolvedValue({ choice: { ok: true, provider: 'fake-live', argv: ['fake-runner'] }, health: { status: 'failing', reason: 'usage-limit', resetAt: null, failingSince: null, lastGoodPassAt: null }, ready: [] }),
    run: vi.fn<PlannerPassDeps['run']>().mockResolvedValue({ v: 1, provider: 'fake-live', outcome: 'ran', exitCode: 0, logPath: '/fake/log', startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T00:00:00Z', nextResetAt: null, planError: null }),
  };
  return deps;
}
it('selects without executing and explains health', async () => {
  const deps = fixture();
  expect(await executePlannerPass({ runsRoot: '/fake/runs' }, deps)).toMatchObject({ ok: true, provider: 'fake-live', reason: expect.stringContaining('usage-limit') });
  expect(deps.run).not.toHaveBeenCalled();
  expect(deps.plan).toHaveBeenCalledWith({ runsRoot: '/fake/runs', candidates: [{ provider: 'fake-live', argv: ['fake-runner'] }], lastProvider: 'fake-limited' });
});
it('delegates exactly one pass and propagates child failure without retry', async () => {
  const deps = fixture();
  const result = await deps.run({ candidates: [], lastProvider: '', promptPath: '/fake/prompt' });
  deps.run.mockClear().mockResolvedValue({ ...result, exitCode: 7 });
  expect(await executePlannerPass({ runsRoot: '/fake/runs', promptPath: '/fake/prompt', run: true }, deps)).toMatchObject({ ok: false, result: { exitCode: 7 } });
  expect(deps.run).toHaveBeenCalledExactlyOnceWith({ runsRoot: '/fake/runs', promptPath: '/fake/prompt', candidates: [{ provider: 'fake-live', argv: ['fake-runner'] }], lastProvider: 'fake-limited' });
});
it.each(['missing', 'invalid'] as const)('refuses %s slate before planning', async source => {
  const deps = fixture();
  deps.readCandidates.mockResolvedValue({ source, path: '/fake/slate', candidates: [], lastProvider: null });
  expect(await executePlannerPass({ run: true }, deps)).toMatchObject({ ok: false });
  expect(deps.plan).not.toHaveBeenCalled();
  expect(deps.run).not.toHaveBeenCalled();
});
it('reports no runner and reset without launching', async () => {
  const deps = fixture();
  const plan = await deps.plan({ candidates: [], lastProvider: '' });
  deps.plan.mockResolvedValue({ ...plan, choice: { ok: false, reason: 'all candidates are usage-limited', nextResetAt: '2099-01-01T00:00:00Z' } });
  expect(await executePlannerPass({ run: true, promptPath: '/fake/prompt' }, deps)).toMatchObject({ ok: false, nextResetAt: '2099-01-01T00:00:00Z' });
  expect(deps.run).not.toHaveBeenCalled();
});
it.each(['spawn-failed', 'plan-failed', 'no-runner', 'skipped-orch-off'] as const)('handles runtime outcome %s', async outcome => {
  const deps = fixture();
  const result = await deps.run({ candidates: [], lastProvider: '', promptPath: '/fake/prompt' });
  deps.run.mockClear().mockResolvedValue({ ...result, outcome, exitCode: null });
  expect(await executePlannerPass({ run: true, promptPath: '/fake/prompt' }, deps)).toMatchObject({ ok: outcome === 'skipped-orch-off', result: { outcome } });
});
