import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryBatch } from '../src/cli/fleet-apps-recovery-batch.js';
import type { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';

type Projection = ReturnType<typeof readAppsRecoveryInvocations>;
const A = '12345678-1234-4123-8123-123456789abc';
const B = '22345678-1234-4123-8123-123456789abc';
const uid = (n: number) => `${String(n).padStart(8, '0')}-1234-4123-8123-123456789abc`;
const row = (invocationId: string, latestTime: number, extra: Record<string, unknown> = {}) => ({
  invocationId, latestCursor: 1, latestTime, observedApps: ['FakeApp'],
  retainedObservedState: [{ app: 'FakeApp', observedRunning: true }], retainedDiagnostics: null,
  retainedHealthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, terminalOutcome: null, ...extra,
});
const proj = (invocations: unknown[], extra: Record<string, unknown> = {}) =>
  ({ availability: 'available', truncated: false, invocations, ...extra }) as unknown as Projection;
const withDuration = (ms: number) => ['--max-age-ms', '1000', '--duration-ms', String(ms), '--interval-ms', '1000', '--json'];
const base = withDuration(5000);

afterEach(() => vi.restoreAllMocks());
function run(args: string[], projections: Projection[], opts: { wall?: () => number; sleep?: (ms: number) => void; stat?: (p: string) => unknown; signal?: AbortSignal } = {}) {
  let t = 0, reads = 0, out = '';
  const sleeps: number[] = [];
  const deps = {
    now: () => t, wallNow: opts.wall ?? (() => 10_000 + t),
    reader: () => projections[Math.min(reads++, projections.length - 1)]!,
    sleep: async (ms: number) => { sleeps.push(ms); t += ms; opts.sleep?.(ms); },
    stat: opts.stat, signal: opts.signal, emit: (l: string) => { out = l; },
  };
  return cmdFleetAppsRecoveryBatch(args, deps).then(code => ({ code, reads, sleeps, out: out ? JSON.parse(out) : null }));
}

it('succeeds only when all ids are healthy in one cycle, reading once per poll', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...base],
    [proj([row(A, 10_000)]), proj([row(A, 10_900), row(B, 11_000)])]);
  expect(r.code).toBe(0);
  expect(r.reads).toBe(2);
  expect(r.out).toMatchObject({ outcome: 'healthy', evidence: 'retained', liveProbe: false, invocationIds: [A, B], elapsedMs: 1000 });
  expect(r.out.verdicts.map((v: { verdict: string }) => v.verdict)).toEqual(['healthy', 'healthy']);
});
it('does not latch a once-healthy member that goes stale', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...withDuration(3000)],
    [proj([row(A, 9_900)]), proj([row(A, 9_900), row(B, 10_900)]), proj([row(A, 9_900), row(B, 11_900)])]);
  expect(r.code).toBe(1);
  expect(r.out.outcome).toBe('timeout');
  expect(r.out.verdicts.map((v: { verdict: string }) => v.verdict)).toEqual(['stale', 'healthy']);
});
it('ends terminal when any member is terminal', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...base],
    [proj([row(A, 10_000), row(B, 10_000, { terminalOutcome: 'failed' })])]);
  expect(r).toMatchObject({ code: 1, reads: 1 });
  expect(r.out.outcome).toBe('terminal');
});
it('times out on a missing member using one common deadline', async () => {
  const r = await run(['--invocation', A, '--invocation', B, ...withDuration(2500)],
    [proj([row(A, 10_000)])], { wall: () => 10_000 });
  expect(r.code).toBe(1);
  expect(r.out).toMatchObject({ outcome: 'timeout', elapsedMs: 2500 });
  expect(r.sleeps).toEqual([1000, 1000, 500]);
  expect(r.reads).toBe(3);
  expect(r.out.verdicts[1].verdict).toBe('unknown');
});
it('never treats truncated evidence as healthy', async () => {
  const r = await run(['--invocation', A, ...withDuration(1000)], [proj([row(A, 10_000)], { truncated: true })]);
  expect(r.code).toBe(1);
  expect(r.out.outcome).toBe('timeout');
});
it('reports unavailable for unavailable or throwing readers without leaking errors', async () => {
  const a = await run(['--invocation', A, ...base], [proj([], { availability: 'unavailable' })]);
  expect(a.out.outcome).toBe('unavailable');
  let out = '';
  const code = await cmdFleetAppsRecoveryBatch(['--invocation', A, ...base],
    { reader: () => { throw new Error('/secret/path'); }, emit: l => { out = l; } });
  expect(code).toBe(1);
  expect(JSON.parse(out).outcome).toBe('unavailable');
  expect(out).not.toContain('secret');
});
it('does not read after pre-abort or an existing stop file', async () => {
  const ac = new AbortController(); ac.abort();
  const a = await run(['--invocation', A, ...base], [proj([row(A, 10_000)])], { signal: ac.signal });
  expect(a).toMatchObject({ code: 1, reads: 0 });
  expect(a.out.outcome).toBe('cancelled');
  const b = await run(['--invocation', A, ...base, '--stop-file', '/tmp/fake-stop'], [proj([row(A, 10_000)])], { stat: () => ({}) });
  expect(b).toMatchObject({ code: 1, reads: 0 });
  expect(b.out.outcome).toBe('stopped');
});
it('detects a stop file within 250ms during sleep and removes listeners', async () => {
  const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
  let present = false;
  const r = await run(['--invocation', A, ...base, '--stop-file', '/tmp/fake-stop'], [proj([])],
    { sleep: () => { present = true; }, stat: () => { if (!present) throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
  expect(r.sleeps).toEqual([250]);
  expect(r.out.outcome).toBe('stopped');
  expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
});
it('cancels from an injected signal during sleep without emitting healthy', async () => {
  const ac = new AbortController();
  const r = await run(['--invocation', A, ...base], [proj([])], { signal: ac.signal, sleep: () => ac.abort() });
  expect(r.out.outcome).toBe('cancelled');
});
it('does not report healthy when the deadline passes during the read', async () => {
  let t = 0;
  let out = '';
  const code = await cmdFleetAppsRecoveryBatch(['--invocation', A, ...withDuration(100)], {
    now: () => t, wallNow: () => 10_000, reader: () => { t = 100; return proj([row(A, 10_000)]); }, emit: l => { out = l; },
  });
  expect(code).toBe(1);
  expect(JSON.parse(out).outcome).toBe('timeout');
});
it('rejects invalid, duplicate and excess ids with zero reads', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const many = Array.from({ length: 21 }, (_, i) => ['--invocation', uid(i + 1)]).flat();
  const bad: string[][] = [
    ['--invocation', 'nope', ...base],
    ['--invocation', A, '--invocation', A.toUpperCase(), ...base],
    many.concat(base),
    base,
    ['--invocation', A, ...base, '--json'],
    ['--invocation', A, ...base, '--unknown'],
    ['--invocation', A, '--max-age-ms', '1e3', '--duration-ms', '5', '--json'],
    ['--invocation', A, ...withDuration(0)],
    ['--invocation', A, '--max-age-ms', '1', '--duration-ms', '300001'],
  ];
  for (const args of bad) expect((await run(args, [proj([])])).reads).toBe(0);
  for (const args of bad) expect((await run(args, [proj([])])).code).toBe(2);
});
it('reads once per poll regardless of group size', async () => {
  const ids = Array.from({ length: 20 }, (_, i) => uid(i + 1));
  const r = await run(ids.flatMap(id => ['--invocation', id]).concat(base), [proj(ids.map(id => row(id, 10_000)))]);
  expect(r).toMatchObject({ code: 0, reads: 1 });
  expect(r.out.verdicts).toHaveLength(20);
});
