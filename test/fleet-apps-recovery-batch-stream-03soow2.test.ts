import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryBatch } from '../src/cli/fleet-apps-recovery-batch.js';
import type { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';

type Projection = ReturnType<typeof readAppsRecoveryInvocations>;
const A = '12345678-1234-4123-8123-123456789abc';
const B = '22345678-1234-4123-8123-123456789abc';
const row = (invocationId: string, latestTime: number, extra: Record<string, unknown> = {}) => ({
  invocationId, latestCursor: 1, latestTime, observedApps: ['FakeApp'],
  retainedObservedState: [{ app: 'FakeApp', observedRunning: true }], retainedDiagnostics: null,
  retainedHealthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, terminalOutcome: null, ...extra,
});
const proj = (invocations: unknown[], extra: Record<string, unknown> = {}) =>
  ({ availability: 'available', truncated: false, invocations, ...extra }) as unknown as Projection;
const flags = (ms: number, extra: string[] = ['--stream']) =>
  ['--max-age-ms', '1000', '--duration-ms', String(ms), '--interval-ms', '1000', ...extra];

afterEach(() => vi.restoreAllMocks());
type Rec = Record<string, any>;
async function run(args: string[], projections: Projection[], opts: { stat?: (p: string) => unknown; signal?: AbortSignal; onSleep?: (n: number) => void } = {}) {
  let t = 0, reads = 0, sleepCount = 0;
  const lines: string[] = [];
  const listeners = process.listenerCount('SIGINT');
  const code = await cmdFleetAppsRecoveryBatch(args, {
    now: () => t, wallNow: () => 10_000 + t,
    reader: () => projections[Math.min(reads++, projections.length - 1)]!,
    sleep: async ms => { t += ms; opts.onSleep?.(++sleepCount); },
    stat: opts.stat, signal: opts.signal, emit: l => lines.push(l),
  });
  const recs: Rec[] = lines.map(l => JSON.parse(l));
  return { code, reads, lines, recs, summaries: recs.filter(r => r.type === 'summary'), progress: recs.filter(r => r.type === 'progress'),
    leaked: process.listenerCount('SIGINT') - listeners };
}

it('emits first progress before completion and coalesces unchanged snapshots', async () => {
  // Same verdict and cursor, wall clock advances: only one progress.
  const r = await run(['--invocation', A, '--invocation', B, ...flags(3000)],
    [proj([row(A, 10_000)]), proj([row(A, 11_000)]), proj([row(A, 12_000)])]);
  expect(r.progress).toHaveLength(1);
  expect(r.recs[0]).toMatchObject({ type: 'progress', v: 1, evidence: 'retained', liveProbe: false, invocationIds: [A, B], seq: 1 });
  expect(r.recs.at(-1)!.type).toBe('summary');
  expect(r.summaries).toHaveLength(1);
  expect(r.summaries[0]).toMatchObject({ outcome: 'timeout', evidence: 'retained', liveProbe: false, invocationIds: [A, B] });
  expect(r.code).toBe(1);
  expect(r.leaked).toBe(0);
});
it('mixed states do not end early; cursor change emits while healthy', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...flags(5000)],
    [proj([row(A, 10_000)]), proj([row(A, 11_000)]), proj([row(A, 12_000, { latestCursor: 2 }), row(B, 12_000)])]);
  expect(r.code).toBe(0);
  expect(r.progress).toHaveLength(2);
  expect(r.progress[0].verdicts.map((v: Rec) => v.verdict)).toEqual(['healthy', 'unknown']);
  expect(r.progress[1].verdicts.map((v: Rec) => v.verdict)).toEqual(['healthy', 'healthy']);
  expect(r.summaries[0].outcome).toBe('healthy');
});
it('cursor change with unchanged healthy verdict is emitted', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...flags(4000)],
    [proj([row(A, 10_000)]), proj([row(A, 11_000, { latestCursor: 2 })]), proj([row(A, 12_000, { latestCursor: 2 })])]);
  expect(r.progress.map(p => p.verdicts[0].latestCursor)).toEqual([1, 2]);
  expect(r.progress.every(p => p.verdicts[0].verdict === 'healthy')).toBe(true);
});
it('emits healthy to stale transition', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...flags(3000)],
    [proj([row(A, 10_000)]), proj([row(A, 10_000)]), proj([row(A, 10_000)])]);
  const verdicts = r.progress.map(p => p.verdicts[0].verdict);
  expect(verdicts).toEqual(['healthy', 'stale']);
  expect(r.summaries).toHaveLength(1);
});
it('terminal yields progress then exactly one summary', async () => {
  const r = await run(['--invocation', A, ...flags(3000)], [proj([row(A, 10_000, { terminalOutcome: 'failed' })])]);
  expect(r.code).toBe(1);
  expect(r.progress[0].verdicts[0].verdict).toBe('terminal');
  expect(r.summaries).toHaveLength(1);
  expect(r.summaries[0].outcome).toBe('terminal');
});
it('stop file and cancellation yield exactly one summary and remove listeners', async () => {
  let stopAfter = false;
  const s = await run(['--invocation', A, '--invocation', B, ...flags(5000), '--stop-file', '/tmp/fake-stop'],
    [proj([row(A, 10_000)])], { onSleep: () => { stopAfter = true; }, stat: () => { if (stopAfter) return {}; throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  expect(s.summaries).toHaveLength(1);
  expect(s.summaries[0].outcome).toBe('stopped');
  expect(s.leaked).toBe(0);
  const ac = new AbortController();
  const c = await run(['--invocation', A, '--invocation', B, ...flags(5000)], [proj([row(A, 10_000)])], { signal: ac.signal, onSleep: () => ac.abort() });
  expect(c.summaries).toHaveLength(1);
  expect(c.summaries[0].outcome).toBe('cancelled');
  expect(c.leaked).toBe(0);
});
it('unavailable evidence emits no progress and one summary', async () => {
  const r = await run(['--invocation', A, ...flags(3000)], [proj([], { availability: 'unavailable' })]);
  expect(r.progress).toHaveLength(0);
  expect(r.summaries).toHaveLength(1);
  expect(r.summaries[0]).toMatchObject({ outcome: 'unavailable', liveProbe: false });
});
it('default output is unchanged: a single record without a type field', async () => {
  const r = await run(['--invocation', A, ...flags(3000, ['--json'])], [proj([row(A, 10_000)])]);
  expect(r.recs).toHaveLength(1);
  expect(Object.keys(r.recs[0]!)).toEqual(['v', 'evidence', 'liveProbe', 'invocationIds', 'outcome', 'elapsedMs', 'verdicts']);
});
it('rejects duplicate --stream before any read', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const r = await run(['--invocation', A, ...flags(3000, ['--stream', '--stream'])], [proj([row(A, 10_000)])]);
  expect(r).toMatchObject({ code: 2, reads: 0, recs: [] });
});
it('usage mentions --stream', async () => {
  const lines: string[] = [];
  await cmdFleetAppsRecoveryBatch(['--help'], { emit: l => lines.push(l) });
  expect(lines[0]).toContain('[--stream]');
});
