import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetPlanner } from '../src/cli/fleet-planner.js';
import type { PlannerPassDeps } from '../src/core/fleet/planner-pass.js';
afterEach(() => vi.restoreAllMocks());
function fixture() {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  return {
    readCandidates: vi.fn<PlannerPassDeps['readCandidates']>().mockResolvedValue({ source: 'ok', path: '/fake/slate', candidates: [], lastProvider: null }),
    plan: vi.fn<PlannerPassDeps['plan']>().mockResolvedValue({ choice: { ok: true, provider: 'fake-live', argv: ['fake-bin'] }, health: { status: 'unknown', reason: 'missing-events-log', resetAt: null, failingSince: null, lastGoodPassAt: null }, ready: [] }),
    run: vi.fn<PlannerPassDeps['run']>().mockResolvedValue({ v: 1, provider: 'fake-live', outcome: 'ran', exitCode: 0, logPath: null, startedAt: '', finishedAt: '', nextResetAt: null, planError: null }),
  };
}
it.each([{ args: [] }, { args: ['--json'] }])('defaults to selection with reason: $args', async ({ args }) => {
  const deps = fixture();
  expect(await cmdFleetPlanner(args, deps)).toBe(0);
  expect(deps.run).not.toHaveBeenCalled();
  expect(vi.mocked(console.log).mock.calls[0]![0]).toContain('fake-live');
  expect(vi.mocked(console.log).mock.calls[0]![0]).toContain('first candidate');
});
it('runs once with JSON output', async () => {
  const deps = fixture();
  expect(await cmdFleetPlanner(['--run', '--prompt-file', '/fake/prompt', '--runs-root', '/fake/runs', '--json'], deps)).toBe(0);
  expect(deps.run).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ ok: true, result: { outcome: 'ran' } });
});
it.each([['--run'], ['--wat'], ['--json', '--json'], ['--runs-root']].map(args => ({ args })))('rejects invalid arguments $args before reading', async ({ args }) => {
  const deps = fixture();
  expect(await cmdFleetPlanner(args, deps)).toBe(1);
  expect(deps.readCandidates).not.toHaveBeenCalled();
});
it('fails safely when a dependency throws', async () => {
  const deps = fixture();
  deps.readCandidates.mockRejectedValue(new Error('fake private diagnostic'));
  expect(await cmdFleetPlanner(['--json'], deps)).toBe(1);
  expect(vi.mocked(console.log).mock.calls[0]![0]).not.toContain('private');
});
it('help performs no reads', async () => {
  const deps = fixture();
  expect(await cmdFleetPlanner(['--help'], deps)).toBe(0);
  expect(deps.readCandidates).not.toHaveBeenCalled();
});
it('returns 1 when selection finds no live runner', async () => {
  const deps = fixture();
  const plan = await deps.plan({ candidates: [], lastProvider: '' });
  deps.plan.mockResolvedValue({ ...plan, choice: { ok: false, reason: 'no candidates', nextResetAt: null } });
  expect(await cmdFleetPlanner(['--json'], deps)).toBe(1);
  expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({ ok: false, reason: 'no candidates' });
  expect(deps.run).not.toHaveBeenCalled();
});
it('returns 1 for a failed pass', async () => {
  const deps = fixture();
  const result = await deps.run({ candidates: [], lastProvider: '', promptPath: '/fake/prompt' });
  deps.run.mockClear().mockResolvedValue({ ...result, exitCode: 7 });
  expect(await cmdFleetPlanner(['--run', '--prompt-file', '/fake/prompt', '--json'], deps)).toBe(1);
  expect(deps.run).toHaveBeenCalledTimes(1);
});
