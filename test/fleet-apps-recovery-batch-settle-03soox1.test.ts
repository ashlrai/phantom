import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryBatch } from '../src/cli/fleet-apps-recovery-batch.js';
import type { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';

type Projection = ReturnType<typeof readAppsRecoveryInvocations>;
type Rec = Record<string, any>;
const A = '12345678-1234-4123-8123-123456789abc';
const B = '22345678-1234-4123-8123-123456789abc';
const row = (invocationId: string, latestTime: number, extra: Record<string, unknown> = {}) => ({
  invocationId, latestCursor: 1, latestTime, observedApps: ['FakeApp'],
  retainedObservedState: [{ app: 'FakeApp', observedRunning: true }], retainedDiagnostics: null,
  retainedHealthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, terminalOutcome: null, ...extra,
});
const term = (id: string, t: number) => row(id, t, { terminalOutcome: 'failed' });
const proj = (invocations: unknown[]) => ({ availability: 'available', truncated: false, invocations }) as unknown as Projection;
const base = (ms: number, extra: string[] = []) =>
  ['--invocation', A, '--invocation', B, '--max-age-ms', '1000', '--duration-ms', String(ms), '--interval-ms', '1000', ...extra];

afterEach(() => vi.restoreAllMocks());
// Projection i is served on read i; rows may use wall-clock-relative times via a function.
async function run(args: string[], projections: Array<Projection | ((wall: number) => Projection)>,
  opts: { stat?: (p: string) => unknown; signal?: AbortSignal; onSleep?: (n: number) => void } = {}) {
  let t = 0, reads = 0, sleeps = 0;
  const lines: string[] = [];
  const code = await cmdFleetAppsRecoveryBatch(args, {
    now: () => t, wallNow: () => 10_000 + t,
    reader: () => { const p = projections[Math.min(reads++, projections.length - 1)]!; return typeof p === 'function' ? p(10_000 + t) : p; },
    sleep: async ms => { t += ms; opts.onSleep?.(++sleeps); },
    stat: opts.stat, signal: opts.signal, emit: l => lines.push(l),
  });
  const recs: Rec[] = lines.map(l => JSON.parse(l));
  return { code, reads, recs, summaries: recs.filter(r => r.type === 'summary'), progress: recs.filter(r => r.type === 'progress') };
}

it('terminal plus pending continues, then finishes terminal once the pending one is healthy', async () => {
  const r = await run(base(10_000, ['--wait-all', '--json']),
    [proj([term(A, 10_000)]), proj([term(A, 10_000)]), proj([term(A, 10_000), row(B, 12_000)])]);
  expect(r.reads).toBe(3);
  expect(r.code).toBe(1);
  expect(r.recs).toHaveLength(1);
  expect(r.recs[0]).toMatchObject({ outcome: 'terminal', waitAll: true });
  expect(r.recs[0]!.verdicts.map((v: Rec) => v.verdict)).toEqual(['terminal', 'healthy']);
});
it('two healthy finish 0', async () => {
  const r = await run(base(5000, ['--wait-all']), [proj([row(A, 10_000), row(B, 10_000)])]);
  expect(r.code).toBe(0);
  expect(r.recs[0]).toMatchObject({ outcome: 'healthy', waitAll: true });
});
it('terminal plus forever-pending reaches timeout', async () => {
  const r = await run(base(3000, ['--wait-all']), [proj([term(A, 10_000)])]);
  expect(r.code).toBe(1);
  expect(r.recs[0]!.outcome).toBe('timeout');
  expect(r.recs[0]!.verdicts.map((v: Rec) => v.verdict)).toEqual(['terminal', 'unknown']);
});
it('previously healthy evidence becoming stale does not settle the batch', async () => {
  // Cycle 1 (t=0): A healthy, B unknown. Later cycles: A has no new evidence (stale), B terminal.
  const r = await run(base(4000, ['--wait-all', '--stream']),
    [proj([row(A, 10_000)]), proj([row(A, 10_000)]), proj([row(A, 10_000), term(B, 12_000)])]);
  expect(r.summaries).toHaveLength(1);
  expect(r.summaries[0]!.outcome).toBe('timeout');
  expect(r.code).toBe(1);
  const last = r.progress.at(-1)!.verdicts.map((v: Rec) => v.verdict);
  expect(last).toEqual(['stale', 'terminal']);
});
it('default terminal still exits immediately without a waitAll field', async () => {
  const r = await run(base(5000, ['--json']), [proj([term(A, 10_000)])]);
  expect(r.code).toBe(1);
  expect(r.reads).toBe(1);
  expect(r.recs[0]!.outcome).toBe('terminal');
  expect(r.recs[0]).not.toHaveProperty('waitAll');
});
it('--wait-all with --stream emits later progress and exactly one summary', async () => {
  const r = await run(base(10_000, ['--wait-all', '--stream']),
    [proj([term(A, 10_000)]), proj([term(A, 10_000), row(B, 11_000)])]);
  expect(r.progress).toHaveLength(2);
  expect(r.progress.every(p => p.waitAll === true)).toBe(true);
  expect(r.progress.map(p => p.seq)).toEqual([1, 2]);
  expect(r.summaries).toHaveLength(1);
  expect(r.summaries[0]).toMatchObject({ outcome: 'terminal', waitAll: true });
  expect(r.recs.at(-1)!.type).toBe('summary');
  expect(r.code).toBe(1);
});
it('stop file during mixed terminal/pending evidence yields stopped', async () => {
  let stop = false;
  const r = await run(base(10_000, ['--wait-all', '--stop-file', '/tmp/fake-stop']), [proj([term(A, 10_000)])],
    { onSleep: n => { if (n >= 2) stop = true; }, stat: () => { if (stop) return {}; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  expect(r.recs).toHaveLength(1);
  expect(r.recs[0]).toMatchObject({ outcome: 'stopped', waitAll: true });
  expect(r.code).toBe(1);
});
it('abort during mixed terminal/pending evidence yields cancelled', async () => {
  const ac = new AbortController();
  const r = await run(base(10_000, ['--wait-all']), [proj([term(A, 10_000)])], { signal: ac.signal, onSleep: () => ac.abort() });
  expect(r.recs).toHaveLength(1);
  expect(r.recs[0]!.outcome).toBe('cancelled');
  expect(r.code).toBe(1);
});
it('rejects duplicate --wait-all before any read and documents the flag', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await run(base(3000, ['--wait-all', '--wait-all']), [proj([row(A, 10_000)])]);
  expect(r).toMatchObject({ code: 2, reads: 0, recs: [] });
  const lines: string[] = [];
  await cmdFleetAppsRecoveryBatch(['--help'], { emit: l => lines.push(l) });
  expect(lines[0]).toContain('[--wait-all]');
});
