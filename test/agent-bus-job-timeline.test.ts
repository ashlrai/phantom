import { expect, it, vi } from 'vitest';
import { runBusJobTimeline, type TimelineDependencies } from '../examples/agents/bus-job-timeline.js';
import type { BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import type { FleetJobDetailV1 } from '../src/core/fleet/runs-job-detail.js';

const job = 'JOB-FAKE';
const detail: FleetJobDetailV1 = {
  schema: 'fleet.job.v1', generatedAt: '2026-01-01T00:00:00.000Z', job, state: 'published',
  lane: null, tier: null, model: null, pid: null, launchedAt: null, baseSha: null, branch: null, promptBytes: null,
  publish: { prUrl: 'https://example.test/pull/1', autoMerge: false, testLine: null, sensitive: null },
  notes: { hasNotes: false, hasBody: false, notesBytes: null },
  log: { source: 'missing', bytes: null, tail: [], truncated: false },
  sources: { launch: 'missing', base: 'missing', meta: 'missing', publish: 'healthy', log: 'missing' },
};
function row(cursor: number, body: BusInboxReceipt['envelope']['body']): BusInboxReceipt {
  return { cursor, receivedAt: 100, envelope: { id: `fake-${cursor}`, from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 1000, body } };
}
async function run(args: string[], deps: TimelineDependencies = {}) {
  let output = '';
  const code = await runBusJobTimeline(args, { readJob: async () => detail, now: () => 100, ...deps, write: text => { output += text; } });
  return { code, result: JSON.parse(output) };
}

it('advances across nonmatching pages, and matches only an explicit top-level jobId', async () => {
  const first = Array.from({ length: 50 }, (_, i) => row(i + 1, { text: job }));
  const second = [row(51, { nested: { jobId: job } }), row(52, { jobId: 'job-fake' }),
    row(53, [job]), row(54, { jobId: job, text: 'untrusted fake data' })];
  const readBus = vi.fn((after: number) => ({ status: 'ok' as const, messages: after === 0 ? first : second, nextCursor: after === 0 ? 50 : 54 }));
  const result = await run(['--job', job, '--pages', '3'], { readBus });
  expect(result.code).toBe(0);
  expect(readBus.mock.calls.map(call => call[0])).toEqual([0, 50]);
  expect(result.result).toMatchObject({ detail: { state: 'published', publish: { autoMerge: false } },
    bus: { status: 'ok', after: 0, nextCursor: 54, pagesRead: 2, pageLimitReached: false, stopReason: 'caught-up', messages: [{ cursor: 54 }] } });
});

it('returns an empty page cursor and a resumable cap without probing beyond it', async () => {
  const readBus = vi.fn((after: number) => ({ status: 'ok' as const,
    messages: Array.from({ length: 50 }, (_, i) => row(after + i + 1, { jobId: 'OTHER' })), nextCursor: after + 50 }));
  const first = await run(['--job', job, '--pages', '2'], { readBus });
  expect(first.result.bus).toMatchObject({ messages: [], nextCursor: 100, pagesRead: 2, pageLimitReached: true, stopReason: 'page-limit' });
  expect(readBus).toHaveBeenCalledTimes(2);
  const resumed = await run(['--job', job, '--after', String(first.result.bus.nextCursor), '--pages', '1'], { readBus });
  expect(resumed.result.bus).toMatchObject({ after: 100, nextCursor: 150, pageLimitReached: true });
  expect(readBus.mock.calls[2]?.[0]).toBe(100);
});

it('preserves an advancing empty page, including expired-only pages', async () => {
  const result = await run(['--job', job, '--after', '3'], { readBus: () => ({ status: 'ok', messages: [], nextCursor: 17 }) });
  expect(result.result.bus).toMatchObject({ messages: [], after: 3, nextCursor: 17, stopReason: 'caught-up' });
});

it('retains job evidence and already scanned cursor on bus failure', async () => {
  const readBus = vi.fn((after: number) => after === 0
    ? { status: 'ok' as const, messages: Array.from({ length: 50 }, (_, i) => row(i + 1, { jobId: job })), nextCursor: 50 }
    : { status: 'unavailable' as const });
  const result = await run(['--job', job, '--pages', '2'], { readBus });
  expect(result.code).toBe(1);
  expect(result.result).toMatchObject({ detail: { publish: detail.publish, sources: detail.sources }, bus: { status: 'unavailable', nextCursor: 50, pagesRead: 1, stopReason: 'bus-error' } });
  expect(result.result.bus.messages).toHaveLength(50);
});

it('reports reader failures, source health, and invalid arguments without exposing exceptions', async () => {
  const unavailable = await run(['--job', job], { readJob: async () => { throw new Error('fake private detail'); }, readBus: () => ({ status: 'ok', messages: [], nextCursor: 0 }) });
  expect(unavailable).toMatchObject({ code: 1, result: { detail: null, bus: { status: 'ok' } } });
  expect(JSON.stringify(unavailable)).not.toContain('fake private detail');
  const degraded = await run(['--job', job], { readJob: async () => ({ ...detail, sources: { ...detail.sources, publish: 'degraded' } }), readBus: () => ({ status: 'ok', messages: [], nextCursor: 0 }) });
  expect(degraded.code).toBe(4);
  for (const args of [[], ['--job', '../bad'], ['--job', job, '--pages', '11'], ['--job', job, '--pages', '0'], ['--job', job, '--after', '-1'], ['--job', job, '--wait-ms', '60001'], ['--job', job, '--pages', '2', '--pages', '1']]) {
    const result = await run(args, { readBus: () => { throw new Error('must not read'); } });
    expect(result.code).toBe(2);
    expect(result.result.error).toBeDefined();
  }
  expect((await run(['--job', job, '--after', '99'], { readBus: () => ({ status: 'invalid' }) })).code).toBe(2);
});

it('bounds waiting by the page budget and cleans up on interruption', async () => {
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const signal = new AbortController();
  const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => { signal.abort(); });
  const readBus = vi.fn(() => ({ status: 'ok' as const, messages: [], nextCursor: 0 }));
  const result = await run(['--job', job, '--pages', '3', '--wait-ms', '10'], { signal: signal.signal, wait, readBus });
  expect(result).toMatchObject({ code: 130, result: { bus: { stopReason: 'interrupted', pagesRead: 1 } } });
  expect(wait).toHaveBeenCalledTimes(1);
  expect(readBus).toHaveBeenCalledTimes(1);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
  const polls = vi.fn(async () => {});
  const bounded = await run(['--job', job, '--pages', '3', '--wait-ms', '10'], { wait: polls, readBus });
  expect(bounded.result.bus).toMatchObject({ pagesRead: 3, pageLimitReached: true });
  expect(polls).toHaveBeenCalledTimes(2);
});

it('passes the injected clock to both readers and preserves missing job health', async () => {
  const readJob: NonNullable<TimelineDependencies['readJob']> = async (_job, options) => {
    expect(options?.now?.().getTime()).toBe(100);
    return { ...detail, state: 'unknown', publish: null, sources: { launch: 'missing', base: 'missing', meta: 'missing', publish: 'missing', log: 'missing' } };
  };
  const readBus: NonNullable<TimelineDependencies['readBus']> = (_after, _limit, options) => {
    expect(options?.now?.()).toBe(100);
    return { status: 'ok', messages: [], nextCursor: 0 };
  };
  const result = await run(['--job', job], { readJob, readBus });
  expect(result).toMatchObject({ code: 3, result: { detail: { publish: null }, bus: { status: 'ok' } } });
});
