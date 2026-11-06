import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusScatterRetry } from '../src/cli/fleet-bus-scatter-retry.js';
import { type BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPost, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { scatterBusRequests, type BusScatterReport } from '../src/core/fleet/bus-scatter-request.js';
import { type BusScatterRetryEvidenceRow, type BusScatterRetryReport } from '../src/core/fleet/bus-scatter-retry.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const roots: string[] = [];
const envelope = (id: string, extra: Partial<BusEnvelope> = {}): BusEnvelope =>
  ({ id, from: 'planner', to: `agent-${id}`, priority: 'P2', ttl: 60000, body: { text: `work-${id}` }, ...extra });
const replyFor = (request: BusEnvelope, id = `reply-${request.id}`): BusEnvelope =>
  ({ id, from: request.to, to: request.from, priority: 'P2', ttl: 60000, body: { inReplyTo: request.id, note: 'done' } });
const a = envelope('req-a'), b = envelope('req-b'), c = envelope('req-c');

/** One evidence row as a fleet.bus-scatter-retry.v1 report carries it. */
const evRow = (env: BusEnvelope, outcome: string, post?: unknown): Record<string, unknown> =>
  ({ id: env.id, from: env.from, to: env.to, priority: env.priority, ttl: env.ttl, outcome,
    ...(post === undefined ? {} : { post }) });
const retryDoc = (evidence: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({
  schema: 'fleet.bus-scatter-retry.v1', mode: 'apply', status: 'partial', correlation: 'untrusted-routing-only',
  concurrency: 2, timeoutMs: 500, intervalMs: 250, elapsedMs: 500,
  retained: [], retried: [], expired: [],
  counts: { total: evidence.length, retained: 0, retried: 0, replied: 0, expired: 0 },
  requests: [], evidence, ...extra,
});
const evidenceOf = (report: BusScatterRetryReport, id: string): BusScatterRetryEvidenceRow =>
  report.evidence.find(row => row.id === id)!;

function setup(requests: BusEnvelope[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scatter-retry-chain-'))); roots.push(root);
  const file = join(root, 'batch.json'), reportPath = join(root, 'report.json');
  writeFileSync(file, JSON.stringify({ version: 1, requests }), { mode: 0o600 });
  const options = { root: join(root, 'store') };
  const output = vi.fn();
  const writeReport = (report: BusScatterReport | BusScatterRetryReport | string): void =>
    writeFileSync(reportPath, typeof report === 'string' ? report : JSON.stringify(report), { mode: 0o600 });
  const run = async (args: string[] = [], deps: Parameters<typeof cmdFleetBusScatterRetry>[2] = {},
    opts: Parameters<typeof cmdFleetBusScatterRetry>[1] = options) => {
    const code = await cmdFleetBusScatterRetry(['--file', file, '--report', reportPath, '--json', ...args],
      opts, { ...deps, output });
    return { code, report: JSON.parse(String(output.mock.lastCall![0])) as BusScatterRetryReport };
  };
  const inbox = join(options.root, 'bus-inbox');
  const rows = (): BusInboxReceipt[] => (existsSync(join(inbox, 'messages.json'))
    ? (JSON.parse(readFileSync(join(inbox, 'messages.json'), 'utf8')) as { rows: BusInboxReceipt[] }).rows : []);
  /** Test responder: posts each reply once its request appears, retrying transient refusals. */
  const respondFor = (requests: BusEnvelope[]): (() => void) => {
    const pending = new Map(requests.map(request => [request.id, request]));
    const timer = setInterval(() => {
      const page = listBusInboxAfter(0, 100, options);
      if (page.status !== 'ok') return;
      for (const [id, request] of pending) {
        if (page.messages.some(row => row.envelope.id === id)) {
          const post = appendBusInbox(replyFor(request), options);
          if (post.status === 'posted' || post.status === 'duplicate') pending.delete(id);
        }
      }
      if (pending.size === 0) clearInterval(timer);
    }, 15);
    return () => clearInterval(timer);
  };
  return { file, reportPath, options, output, writeReport, run, inbox, rows, respondFor };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Three-request batch: the scatter answers one, the first retry answers a
// second, the second retry answers the last, and the final report feeds one
// more retry as a pure no-op — proving finished work is never reposted.
it('chains retries from scatter report through two retry reports to all-replied, then a no-op', async () => {
  const h = setup([a, b, c]);
  const stop0 = h.respondFor([a]);
  const first = await scatterBusRequests([a, b, c], 12000, 3, h.options);
  stop0();
  expect(first.requests.map(row => row.outcome)).toEqual(['replied', 'timeout', 'timeout']);
  const cCursor = (first.requests[2]!.result!.receipt as { cursor: number }).cursor;
  h.writeReport(first);

  // Generation 1 consumes the scatter report: b replies, c stays pending.
  const append1 = vi.fn(appendBusInbox), stop1 = h.respondFor([b]);
  const gen1 = await h.run(['--apply', '--timeout-ms', '12000'], { append: append1 });
  stop1();
  expect(gen1.code).toBe(1);
  expect(gen1.report).toMatchObject({ schema: 'fleet.bus-scatter-retry.v1', mode: 'apply',
    status: 'partial', retained: ['req-a'], retried: ['req-b', 'req-c'], expired: [] });
  // Exactly the unfinished pair was reposted — never the replied row — and both
  // reposts deduped onto their original posts rather than adding copies.
  expect(new Set(append1.mock.calls.map(call => (call[0] as BusEnvelope).id)))
    .toEqual(new Set(['req-b', 'req-c']));
  expect(append1.mock.results.map(r => (r.value as BusInboxPost).status)).toEqual(['duplicate', 'duplicate']);
  // Cumulative evidence covers the original batch exactly, in batch order.
  expect(gen1.report.evidence.map(row => row.id)).toEqual(['req-a', 'req-b', 'req-c']);
  expect(gen1.report.evidence.map(row => row.outcome)).toEqual(['replied', 'replied', 'timeout']);
  expect(evidenceOf(gen1.report, 'req-c').post).toMatchObject({ status: 'posted', cursor: cCursor });

  // Generation 2 consumes gen1's own retry report: only c is reposted.
  h.writeReport(gen1.report);
  const append2 = vi.fn(appendBusInbox), stop2 = h.respondFor([c]);
  const gen2 = await h.run(['--apply', '--timeout-ms', '12000'], { append: append2 });
  stop2();
  expect(gen2.code).toBe(0);
  expect(gen2.report).toMatchObject({ status: 'all-replied', retained: ['req-a', 'req-b'],
    retried: ['req-c'], expired: [] });
  expect(append2.mock.calls.map(call => (call[0] as BusEnvelope).id)).toEqual(['req-c']);
  expect(append2.mock.results[0]!.value).toMatchObject({ status: 'duplicate', id: 'req-c', cursor: cCursor });
  expect(gen2.report.evidence.map(row => row.outcome)).toEqual(['replied', 'replied', 'replied']);

  // Generation 3 consumes the final report: a fully retained no-op, zero posts.
  h.writeReport(gen2.report);
  const append3 = vi.fn(appendBusInbox);
  const gen3 = await h.run(['--apply'], { append: append3 });
  expect(gen3.code).toBe(0);
  expect(gen3.report).toMatchObject({ status: 'all-replied', retried: [], expired: [] });
  expect(gen3.report.retained).toEqual(['req-a', 'req-b', 'req-c']);
  expect(append3).not.toHaveBeenCalled();
  // One inbox row per request id — no retry ever created a second copy.
  for (const id of ['req-a', 'req-b', 'req-c']) {
    expect(h.rows().filter(row => row.envelope.id === id)).toHaveLength(1);
  }
});

// Pending work keeps the lifetime of its original post — the retry wait is
// bound to the live inbox row at the recorded cursor, and the evidence's
// earliest-post bound travels verbatim — while a row proven expired stays
// refused forever: a later report's fresh file mtime must never recompute, let
// alone refresh, its remaining life. Exercised end to end on the real inbox
// under an injected clock.
it('carries post cursors, age bounds and refusals across generations without mtime refresh', async () => {
  const shortB = envelope('req-b', { ttl: 4000 }), deadC = envelope('req-c', { ttl: 2000 });
  const h = setup([a, shortB, deadC]);
  const clock = { t: 1_000_000_000 };
  const options = { root: h.options.root, now: () => clock.t };
  const postB = appendBusInbox(shortB, options), postC = appendBusInbox(deadC, options);
  if (postB.status !== 'posted' || postC.status !== 'posted') throw new Error('seed posts failed');
  // As a previous generation would emit: a replied, b timed out on a real post
  // bounded at t0, c timed out on a real post bounded at t0.
  h.writeReport(retryDoc([
    evRow(a, 'replied'),
    evRow(shortB, 'timeout', { status: 'posted', cursor: postB.cursor, at: clock.t }),
    evRow(deadC, 'timeout', { status: 'posted', cursor: postC.cursor, at: clock.t }),
  ]));
  clock.t += 2500; // b keeps 1.5s of its 4s TTL; c's 2s TTL is gone.
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply', '--timeout-ms', '60000'], { append }, options);
  expect(code).toBe(1);
  // The report file was written just now, yet c's remaining life came only
  // from its carried evidence: a reader keying on file mtime would repost it.
  expect(report).toMatchObject({ retained: ['req-a'], retried: ['req-b'], expired: ['req-c'] });
  expect(report.timeoutMs).toBeGreaterThanOrEqual(1);
  expect(report.timeoutMs).toBeLessThanOrEqual(1500);
  // b's repost deduped onto the original post; its evidence kept the bound.
  expect(append).toHaveBeenCalledTimes(1);
  expect(append.mock.results[0]!.value).toMatchObject({ status: 'duplicate', id: 'req-b', cursor: postB.cursor });
  expect(evidenceOf(report, 'req-b').post).toMatchObject({ status: 'posted', cursor: postB.cursor, at: 1_000_000_000 });
  expect(evidenceOf(report, 'req-c').outcome).toBe('expired');

  // Consume that fresh report again: c stays expired and b keeps its bound.
  h.writeReport(report);
  const append2 = vi.fn(appendBusInbox);
  const again = await h.run([], { append: append2 }, options);
  expect(again.code).toBe(0);
  expect(again.report).toMatchObject({ mode: 'preview', retained: ['req-a'], retried: ['req-b'], expired: ['req-c'] });
  expect(append2).not.toHaveBeenCalled();
  expect(h.rows().filter(row => row.envelope.id === 'req-c')).toHaveLength(1);
});

it.each<[string, string]>([
  ['retry output lacking evidence', retryDoc([], { evidence: undefined })],
  ['incomplete evidence', retryDoc([evRow(a, 'replied')])],
  ['mismatched evidence id', retryDoc([evRow(a, 'replied'), evRow(envelope('req-z'), 'timeout', { status: 'none' })])],
  ['duplicate evidence id', retryDoc([evRow(a, 'replied'), evRow(a, 'replied')])],
  ['mismatched routing', retryDoc([evRow(a, 'replied'), evRow({ ...b, to: 'agent-x' }, 'timeout', { status: 'none' })])],
  ['pending row without post', retryDoc([evRow(a, 'replied'), evRow(b, 'timeout')])],
  ['unbound unknown post', retryDoc([evRow(a, 'replied'), evRow(b, 'timeout', { status: 'unknown' })])],
])('refuses %s with zero writes', async (_label, doc) => {
  const h = setup([a, b]);
  h.writeReport(doc);
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply'], { append });
  expect(code).toBe(2);
  expect(report.status).toBe('invalid-input');
  expect(append).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
});

it('documents chained reports and evidence in help', async () => {
  const h = setup([a, b]);
  expect(await cmdFleetBusScatterRetry(['--help'], h.options, { output: h.output })).toBe(0);
  const text = String(h.output.mock.lastCall![0]);
  expect(text).toContain('fleet.bus-scatter-retry.v1');
  expect(text).toContain('evidence');
  expect(text).toContain('remaining life');
  expect(text).toContain('mtime');
});
