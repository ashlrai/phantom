import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusScatter } from '../src/cli/fleet-bus-scatter.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { requestBusRoundtrip, type RequestResult } from '../src/core/fleet/bus-request-roundtrip.js';
import { BUS_SCATTER_MAX_REQUESTS, parseBusScatterFile, scatterBusRequests } from '../src/core/fleet/bus-scatter-request.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const roots: string[] = [];
const envelope = (id: string, to = `agent-${id}`) =>
  ({ id, from: 'planner', to, priority: 'P2' as const, ttl: 60000, body: { text: `work-${id}` } });
const replyFor = (request: { id: string; from: string; to: string }, id = `reply-${request.id}`) =>
  ({ id, from: request.to, to: request.from, priority: 'P2' as const, ttl: 60000, body: { inReplyTo: request.id, note: 'done' } });
const replied = (id: string): RequestResult => ({ schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only',
  receipt: { status: 'posted', id, cursor: 1 }, outcome: 'replied', reply: null, cursor: 0, elapsedMs: 0 });

function setup(requests: unknown[] = [envelope('req-a', 'agent-a'), envelope('req-b', 'agent-b')]) {
  const root = mkdtempSync(join(tmpdir(), 'bus-scatter-')); roots.push(root);
  const file = join(root, 'batch.json');
  writeFileSync(file, JSON.stringify({ version: 1, requests }), { mode: 0o600 });
  const options = { root: join(root, 'store') };
  const output = vi.fn();
  const run = async (args = ['--file', file, '--apply', '--timeout-ms', '15000', '--json'],
    deps: Parameters<typeof cmdFleetBusScatter>[2] = {}) => {
    const code = await cmdFleetBusScatter(args, options, { ...deps, output });
    return { code, report: JSON.parse(String(output.mock.lastCall![0])) };
  };
  const inbox = join(options.root, 'bus-inbox');
  const rows = () => (existsSync(join(inbox, 'messages.json'))
    ? (JSON.parse(readFileSync(join(inbox, 'messages.json'), 'utf8')) as { rows: BusInboxReceipt[] }).rows : []);
  /** Test responder: runs act() once the inbox contains every expected id. */
  const respondWhen = (expected: string[], act: () => void): (() => void) => {
    const timer = setInterval(() => {
      const page = listBusInboxAfter(0, 100, options);
      if (page.status === 'ok' && expected.every(id => page.messages.some(row => row.envelope.id === id))) {
        clearInterval(timer);
        act();
      }
    }, 15);
    return () => clearInterval(timer);
  };
  return { root, file, options, output, run, inbox, rows, respondWhen };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('answers two requests in reverse order and keeps input order with correct correlation', async () => {
  const a = envelope('req-a', 'agent-a'), b = envelope('req-b', 'agent-b');
  const h = setup([a, b]);
  const stop = h.respondWhen(['req-a', 'req-b'], () => {
    expect(appendBusInbox(replyFor(b, 'reply-b'), h.options).status).toBe('posted');
    expect(appendBusInbox(replyFor(a, 'reply-a'), h.options).status).toBe('posted');
  });
  const { code, report } = await h.run();
  stop();
  expect(code).toBe(0);
  expect(report).toMatchObject({ schema: 'fleet.bus-scatter.v1', mode: 'apply', status: 'all-replied',
    correlation: 'untrusted-routing-only', counts: { total: 2, attempted: 2, replied: 2, failed: 0, notAttempted: 0 } });
  expect(report.requests.map((row: { id: string }) => row.id)).toEqual(['req-a', 'req-b']);
  expect(report.requests.map((row: { outcome: string }) => row.outcome)).toEqual(['replied', 'replied']);
  expect(report.requests[0].result.reply.envelope.id).toBe('reply-a');
  expect(report.requests[0].result.reply.envelope.body.inReplyTo).toBe('req-a');
  expect(report.requests[1].result.reply.envelope.id).toBe('reply-b');
  expect(report.requests[1].result.reply.envelope.body.inReplyTo).toBe('req-b');
  // Original request IDs pass through for transport dedupe; nothing is renamed.
  expect(h.rows().map(row => row.envelope.id).sort()).toEqual(['reply-a', 'reply-b', 'req-a', 'req-b']);
});

it('never exceeds the concurrency bound and gives every request one shared deadline', async () => {
  const requests = Array.from({ length: 6 }, (_, i) => envelope(`req-${i}`));
  const h = setup(requests);
  let active = 0, maxActive = 0;
  const starts = new Set<number>(), timeouts = new Set<number>();
  const request: typeof requestBusRoundtrip = async (_input, timeoutMs, _interval, _options, deps) => {
    starts.add(deps?.startedAt ?? NaN); timeouts.add(timeoutMs);
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 40));
    active--;
    return replied(`req-${starts.size}`);
  };
  const { code, report } = await h.run(
    ['--file', h.file, '--apply', '--timeout-ms', '15000', '--concurrency', '3', '--json'], { request });
  expect(code).toBe(0);
  expect(report.status).toBe('all-replied');
  expect(maxActive).toBe(3);
  expect(report.counts).toMatchObject({ total: 6, attempted: 6, replied: 6 });
  // Identical startedAt + timeoutMs means every wait shares one monotonic deadline.
  expect(starts.size).toBe(1);
  expect(timeouts.size).toBe(1);
});

it('validates the whole batch before side effects: invalid last envelope posts nothing', async () => {
  const bad = { ...envelope('req-b', 'agent-b'), priority: 'P9' };
  const h = setup([envelope('req-a', 'agent-a'), bad]);
  const request = vi.fn(requestBusRoundtrip), append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--file', h.file, '--apply', '--json'], { request, append });
  expect(code).toBe(2);
  expect(report.status).toBe('invalid-input');
  expect(request).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
});

it('shares one deadline instead of multiplying timeout by request count', async () => {
  const h = setup([envelope('r1'), envelope('r2'), envelope('r3'), envelope('r4')]);
  const began = performance.now();
  const { code, report } = await h.run(['--file', h.file, '--apply', '--timeout-ms', '9000', '--concurrency', '2', '--json']);
  const elapsed = performance.now() - began;
  expect(code).toBe(1);
  expect(report.status).toBe('partial');
  expect(report.requests.map((row: { outcome: string }) => row.outcome))
    .toEqual(['timeout', 'timeout', 'not-attempted', 'not-attempted']);
  expect(report.counts).toMatchObject({ attempted: 2, notAttempted: 2 });
  // Serial fan-out would spend 4x9000ms; the shared deadline lands near 9000ms.
  expect(elapsed).toBeLessThan(20000);
});

it('keeps a real reply when another request times out', async () => {
  const a = envelope('req-a', 'agent-a'), b = envelope('req-b', 'agent-b');
  const h = setup([a, b]);
  const stop = h.respondWhen(['req-a'], () => {
    expect(appendBusInbox(replyFor(a, 'reply-a'), h.options).status).toBe('posted');
  });
  const { code, report } = await h.run(['--file', h.file, '--apply', '--timeout-ms', '12000', '--concurrency', '2', '--json']);
  stop();
  expect(code).toBe(1);
  expect(report.status).toBe('partial');
  expect(report.requests[0]).toMatchObject({ id: 'req-a', outcome: 'replied' });
  expect(report.requests[0].result.reply.envelope.id).toBe('reply-a');
  expect(report.requests[1]).toMatchObject({ id: 'req-b', outcome: 'timeout' });
  expect(report.requests[1].result.reply).toBeNull();
});

it('propagates abort to active waits, stops queued launches and removes signal handlers', async () => {
  const h = setup([envelope('req-a'), envelope('req-b'), envelope('req-c')]);
  const controller = new AbortController();
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  let acknowledge = (): void => {};
  const launched = new Promise<void>(resolve => { acknowledge = resolve; });
  const request: typeof requestBusRoundtrip = (input, timeoutMs, intervalMs, options, deps) => {
    acknowledge();
    return requestBusRoundtrip(input, timeoutMs, intervalMs, options, deps);
  };
  const pending = h.run(['--file', h.file, '--apply', '--timeout-ms', '30000', '--concurrency', '1', '--json'],
    { signal: controller.signal, request });
  await launched;
  controller.abort();
  const { code, report } = await pending;
  expect(code).toBe(1);
  expect(report.status).toBe('cancelled');
  expect(report.requests.map((row: { outcome: string }) => row.outcome))
    .toEqual(['cancelled', 'not-attempted', 'not-attempted']);
  // Only the in-flight request could have posted; queued posts never happened.
  expect(h.rows().length).toBeLessThanOrEqual(1);
  expect(process.listenerCount('SIGINT')).toBe(sigint);
  expect(process.listenerCount('SIGTERM')).toBe(sigterm);
});

it('preview validates and shows bounded routing metadata with no writes', async () => {
  const h = setup([envelope('req-a', 'agent-a'), envelope('req-b', 'agent-b')]);
  const request = vi.fn(requestBusRoundtrip), append = vi.fn(appendBusInbox);
  const { code, report } = await h.run(['--file', h.file, '--json'], { request, append });
  expect(code).toBe(0);
  expect(report).toMatchObject({ mode: 'preview', status: 'preview', concurrency: 4, timeoutMs: 60000 });
  expect(report.requests).toEqual([
    { id: 'req-a', from: 'planner', to: 'agent-a', priority: 'P2', ttl: 60000, outcome: 'not-attempted', result: null },
    { id: 'req-b', from: 'planner', to: 'agent-b', priority: 'P2', ttl: 60000, outcome: 'not-attempted', result: null },
  ]);
  expect(request).not.toHaveBeenCalled();
  expect(append).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
  // Bodies never appear in the preview: routing metadata only.
  expect(String(h.output.mock.lastCall![0])).not.toContain('work-req-a');
});

it('rejects duplicate request IDs before any write', async () => {
  const h = setup([envelope('dup', 'agent-a'), envelope('dup', 'agent-b')]);
  const request = vi.fn(requestBusRoundtrip);
  const { code, report } = await h.run(['--file', h.file, '--apply', '--json'], { request });
  expect(code).toBe(2);
  expect(report.status).toBe('invalid-input');
  expect(request).not.toHaveBeenCalled();
  expect(existsSync(h.inbox)).toBe(false);
});

it.each([
  ['empty batch', { version: 1, requests: [] }],
  ['oversized batch', { version: 1, requests: Array.from({ length: BUS_SCATTER_MAX_REQUESTS + 1 }, (_, i) => envelope(`req-${i}`)) }],
  ['unknown root key', { version: 1, requests: [envelope('req-a')], extra: true }],
  ['wrong version', { version: 2, requests: [envelope('req-a')] }],
  ['non-array requests', { version: 1, requests: { id: 'req-a' } }],
  ['envelope with unknown key', { version: 1, requests: [{ ...envelope('req-a'), kind: 'work' }] }],
])('rejects %s as invalid input', async (_label, payload) => {
  const root = mkdtempSync(join(tmpdir(), 'bus-scatter-')); roots.push(root);
  const file = join(root, 'batch.json');
  writeFileSync(file, JSON.stringify(payload), { mode: 0o600 });
  const output = vi.fn();
  const code = await cmdFleetBusScatter(['--file', file, '--apply', '--json'], { root: join(root, 'store') }, { output });
  expect(code).toBe(2);
  expect(JSON.parse(String(output.mock.lastCall![0])).status).toBe('invalid-input');
  expect(existsSync(join(root, 'store', 'bus-inbox'))).toBe(false);
});

it('rejects oversized files, bad flags and out-of-range numbers', async () => {
  const h = setup();
  const output = vi.fn();
  for (const args of [
    ['--file', 'relative/path.json', '--apply', '--json'],
    ['--file', h.file, '--timeout-ms', '0', '--json'],
    ['--file', h.file, '--timeout-ms', '60001', '--json'],
    ['--file', h.file, '--concurrency', '0', '--json'],
    ['--file', h.file, '--concurrency', '9', '--json'],
    ['--file', h.file, '--concurrency', '2.5', '--json'],
    ['--file', h.file, '--unknown', '--json'],
    ['--file', h.file, '--file', h.file, '--json'],
    ['--file', join(h.root, 'missing.json'), '--apply', '--json'],
    ['--apply', '--json'],
  ]) {
    expect(await cmdFleetBusScatter(args, h.options, { output })).toBe(2);
    expect(JSON.parse(String(output.mock.lastCall![0])).status).toBe('invalid-input');
  }
  const big = join(h.root, 'big.json');
  writeFileSync(big, `{"version":1,"requests":[${' '.repeat(256 * 1024)}]}`, { mode: 0o600 });
  expect(await cmdFleetBusScatter(['--file', big, '--apply', '--json'], h.options, { output })).toBe(2);
  expect(existsSync(h.inbox)).toBe(false);
});

it('exposes the orchestrator for API callers and marks thrown boundary errors', async () => {
  const requests = [envelope('x'), envelope('y')];
  const report = await scatterBusRequests(requests, 5000, 2, {}, {
    request: async input => replied((input as { id: string }).id),
  });
  expect(report.status).toBe('all-replied');
  expect(report.requests.map(row => row.id)).toEqual(['x', 'y']);
  const thrown = await scatterBusRequests(requests, 5000, 1, {}, {
    request: async () => { throw new Error('boundary failure'); },
  });
  expect(thrown.status).toBe('partial');
  expect(thrown.requests.map(row => row.outcome)).toEqual(['source-unavailable', 'source-unavailable']);
});

it('parses batches strictly and reports usage in text mode', async () => {
  expect(parseBusScatterFile('{bad json')).toEqual({ ok: false });
  expect(parseBusScatterFile(JSON.stringify({ version: 1, requests: [envelope('req-a')] })))
    .toMatchObject({ ok: true });
  const h = setup();
  const output = vi.fn();
  expect(await cmdFleetBusScatter(['--file', h.file, '--apply', '--timeout-ms', '800', '--concurrency', '1'],
    h.options, { output })).toBe(1);
  expect(String(output.mock.lastCall![0])).toContain('bus-scatter partial: 0/2 replied, 1 not-attempted');
  expect(await cmdFleetBusScatter(['--help'], h.options, { output })).toBe(0);
  expect(String(output.mock.lastCall![0])).toContain('Usage: ashlr fleet bus-scatter');
});
