import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusScatterRetry } from '../src/cli/fleet-bus-scatter-retry.js';
import { type BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxPost, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { scatterBusRequests, type BusScatterReport } from '../src/core/fleet/bus-scatter-request.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const roots: string[] = [];
const envelope = (id: string, to = `agent-${id}`): BusEnvelope =>
  ({ id, from: 'planner', to, priority: 'P2', ttl: 60000, body: { text: `work-${id}` } });
const replyFor = (request: BusEnvelope, id = `reply-${request.id}`): BusEnvelope =>
  ({ id, from: request.to, to: request.from, priority: 'P2', ttl: 60000, body: { inReplyTo: request.id, note: 'done' } });
const reportRow = (env: BusEnvelope, outcome: string, result: unknown = null): Record<string, unknown> =>
  ({ id: env.id, from: env.from, to: env.to, priority: env.priority, ttl: env.ttl, outcome, result });
const postedResult = (env: BusEnvelope, cursor: number): Record<string, unknown> =>
  ({ schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only',
    receipt: { status: 'posted', id: env.id, cursor }, outcome: 'timeout', reply: null, cursor: 0, elapsedMs: 400 });
const reportDoc = (rows: unknown[], extra: Record<string, unknown> = {}): string => JSON.stringify({
  schema: 'fleet.bus-scatter.v1', mode: 'apply', status: 'partial', correlation: 'untrusted-routing-only',
  concurrency: 2, timeoutMs: 500, intervalMs: 250, elapsedMs: 500,
  counts: { total: rows.length, attempted: rows.length, replied: 0, failed: rows.length, notAttempted: 0 },
  requests: rows, ...extra,
});
const a = envelope('req-a'), b = envelope('req-b');

function setup(requests: BusEnvelope[] = [a, b]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bus-scatter-retry-'))); roots.push(root);
  const file = join(root, 'batch.json'), reportPath = join(root, 'report.json');
  writeFileSync(file, JSON.stringify({ version: 1, requests }), { mode: 0o600 });
  const options = { root: join(root, 'store') };
  const output = vi.fn();
  const writeReport = (report: BusScatterReport | string): void =>
    writeFileSync(reportPath, typeof report === 'string' ? report : JSON.stringify(report), { mode: 0o600 });
  const run = async (args: string[] = [], deps: Parameters<typeof cmdFleetBusScatterRetry>[2] = {}) => {
    const code = await cmdFleetBusScatterRetry(['--file', file, '--report', reportPath, '--json', ...args],
      options, { ...deps, output });
    return { code, report: JSON.parse(String(output.mock.lastCall![0])) as Record<string, never> };
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
  return { root, file, reportPath, options, output, writeReport, run, inbox, rows, respondFor };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('retries only the timed-out request; the replied row is never reposted', async () => {
  const h = setup();
  const stop = h.respondFor([a]);
  const first = await scatterBusRequests([a, b], 12000, 2, h.options);
  stop();
  expect(first.requests.map(row => row.outcome)).toEqual(['replied', 'timeout']);
  h.writeReport(first);
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply', '--timeout-ms', '3000'], { append });
  expect(code).toBe(1);
  expect(report).toMatchObject({ schema: 'fleet.bus-scatter-retry.v1', mode: 'apply', status: 'partial',
    retained: ['req-a'], retried: ['req-b'], expired: [] });
  expect(report.requests.map((row: { id: string }) => row.id)).toEqual(['req-b']);
  expect(report.requests[0].outcome).toBe('timeout');
  // Exactly one post attempt, carrying the timed-out envelope verbatim.
  expect(append).toHaveBeenCalledTimes(1);
  expect((append.mock.calls[0]![0] as BusEnvelope).id).toBe('req-b');
  // The answered agent kept its single original post; it was never re-asked.
  expect(h.rows().filter(row => row.envelope.id === 'req-a')).toHaveLength(1);
});

it('finds a late correlated reply through existing dedupe, without a second copy', async () => {
  const h = setup();
  const postA = appendBusInbox(a, h.options), postB = appendBusInbox(b, h.options);
  if (postA.status !== 'posted' || postB.status !== 'posted') throw new Error('seed posts failed');
  h.writeReport(reportDoc([
    reportRow(a, 'timeout', postedResult(a, postA.cursor)),
    reportRow(b, 'timeout', postedResult(b, postB.cursor)),
  ]));
  // The reply lands after the first run had already given up.
  expect(appendBusInbox(replyFor(b), h.options).status).toBe('posted');
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply', '--timeout-ms', '4000'], { append });
  expect(code).toBe(1);
  expect(report.requests.map((row: { id: string; outcome: string }) => [row.id, row.outcome]))
    .toEqual([['req-a', 'timeout'], ['req-b', 'replied']]);
  expect(report.requests[1].result.reply.envelope.id).toBe('reply-req-b');
  // Both reposts returned 'duplicate': the originals were still live, and the
  // retry's wait — not a new copy — is what picked the reply up.
  expect(append.mock.results.map(r => (r.value as BusInboxPost).status)).toEqual(['duplicate', 'duplicate']);
  expect(h.rows().filter(row => row.envelope.id === 'req-b')).toHaveLength(1);
});

it.each<[string, string]>([
  ['malformed JSON', '{not json'],
  ['wrong schema', reportDoc([reportRow(a), reportRow(b)], { schema: 'other' })],
  ['missing row', reportDoc([reportRow(a)])],
  ['unknown row', reportDoc([reportRow(a), reportRow(envelope('req-z'))])],
  ['duplicate row', reportDoc([reportRow(a), reportRow(a)])],
  ['mismatched routing', reportDoc([reportRow(a), reportRow({ ...b, to: 'agent-x' })])],
  ['unrecognized outcome', reportDoc([reportRow(a), reportRow(b, 'exploded')])],
])('refuses a %s report with zero writes', async (_label, doc) => {
  const h = setup();
  h.writeReport(doc);
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply'], { append });
  expect(code).toBe(2);
  expect(report.status).toBe('invalid-input');
  expect(append).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
});

it('rejects bad flags and unreadable inputs before any work', async () => {
  const h = setup();
  h.writeReport(reportDoc([reportRow(a), reportRow(b)]));
  for (const args of [
    ['--file', 'relative/batch.json', '--report', h.reportPath],
    ['--file', h.file],
    ['--file', h.file, '--report', join(h.root, 'missing.json')],
    ['--file', h.file, '--report', h.reportPath, '--timeout-ms', '60001'],
  ]) {
    expect(await cmdFleetBusScatterRetry(args, h.options, { output: h.output })).toBe(2);
  }
});

it('previews the retry selection without posting anything', async () => {
  const h = setup();
  h.writeReport(await scatterBusRequests([a, b], 2000, 2, h.options));
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run([], { append });
  expect(code).toBe(0);
  expect(report).toMatchObject({ mode: 'preview', status: 'preview',
    retained: [], retried: ['req-a', 'req-b'], expired: [], requests: [] });
  expect(append).not.toHaveBeenCalled();
});

it('treats a fully replied report as a successful no-op with zero posts', async () => {
  const h = setup();
  h.writeReport(reportDoc([reportRow(a, 'replied'), reportRow(b, 'replied')], { status: 'all-replied' }));
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply'], { append });
  expect(code).toBe(0);
  expect(report).toMatchObject({ status: 'all-replied', retained: ['req-a', 'req-b'], retried: [], expired: [] });
  expect(append).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
});

// Timestamp policy: remaining life = original TTL minus the validated age of
// the prior post. A usable receipt binds to the live inbox row at its recorded
// cursor and takes the store-decremented TTL; without one, the earliest
// possible post is bound by the report file's mtime minus its elapsedMs, and a
// row that cannot prove unexpired life is refused rather than reposted.
it('caps the shared wait at the receipt-bound remaining life', async () => {
  const shortLived = { ...b, ttl: 3000 };
  const h = setup([a, shortLived]);
  const receivedAt = Date.now();
  const post = appendBusInbox(shortLived, { root: h.options.root, now: () => receivedAt });
  if (post.status !== 'posted') throw new Error('seed post failed');
  h.writeReport(reportDoc([
    reportRow(a, 'replied'),
    reportRow(shortLived, 'timeout', { schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only',
      receipt: { status: 'posted', id: 'req-b', cursor: post.cursor }, outcome: 'timeout',
      reply: null, cursor: 0, elapsedMs: 500 }),
  ]));
  const append = vi.fn(appendBusInbox);
  // At this fake clock the validated receipt leaves exactly 1000ms of the 3s TTL.
  const code = await cmdFleetBusScatterRetry(
    ['--file', h.file, '--report', h.reportPath, '--apply', '--timeout-ms', '60000', '--json'],
    { root: h.options.root, now: () => receivedAt + 2000 }, { append, output: h.output });
  const report = JSON.parse(String(h.output.mock.lastCall![0])) as Record<string, never>;
  expect(code).toBe(1);
  expect(report.retained).toEqual(['req-a']);
  expect(report.retried).toEqual(['req-b']);
  expect(report.timeoutMs).toBeGreaterThanOrEqual(1);
  expect(report.timeoutMs).toBeLessThanOrEqual(1000);
  expect(append).toHaveBeenCalledTimes(1);
});

it('refuses an expired receipt rather than granting a new lifetime', async () => {
  const h = setup();
  // The report claims req-b timed out after a real post, but its cursor cannot
  // be validated and the recorded 120s run means any such post outlived the
  // 60s TTL: remaining = ttl - (now - mtime + elapsedMs) < 0 → refused.
  h.writeReport(reportDoc([
    reportRow(a, 'replied'),
    reportRow(b, 'timeout', { schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only',
      receipt: { status: 'posted', id: 'req-b', cursor: 999 }, outcome: 'timeout',
      reply: null, cursor: 0, elapsedMs: 119000 }),
  ], { elapsedMs: 120000 }));
  const append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--apply'], { append });
  expect(code).toBe(1);
  expect(report).toMatchObject({ status: 'partial', retained: ['req-a'], retried: [], expired: ['req-b'] });
  expect(append).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
});

it('keeps the full TTL for rows the report shows as never posted', async () => {
  const h = setup();
  h.writeReport(reportDoc([reportRow(a, 'replied'), reportRow(b, 'not-attempted')]));
  const { code, report } = await h.run([]);
  expect(code).toBe(0);
  expect(report.retried).toEqual(['req-b']);
  expect(report.timeoutMs).toBe(60000);
  expect(existsSync(h.inbox)).toBe(false);
});

it('documents the timestamp policy in help', async () => {
  const h = setup();
  expect(await cmdFleetBusScatterRetry(['--help'], h.options, { output: h.output })).toBe(0);
  const text = String(h.output.mock.lastCall![0]);
  expect(text).toContain('remaining life');
  expect(text).toContain('mtime');
});
