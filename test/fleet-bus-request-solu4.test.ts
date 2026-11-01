import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusRequest } from '../src/cli/fleet-bus-request.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { appendBusInbox, listBusInboxAfter, type BusInboxOptions, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';
import { requestBusRoundtrip } from '../src/core/fleet/bus-request-roundtrip.js';

const roots: string[] = [];
const request = { id: 'fake-request', from: 'fake-a', to: 'fake-b', priority: 'P2', ttl: 60000, body: { text: 'hello' } };
const reply = (id: string, body: unknown = { inReplyTo: request.id }, fields: object = {}) =>
  ({ id, from: 'fake-b', to: 'fake-a', priority: 'P2', ttl: 60000, body, ...fields });
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-request-')); roots.push(root);
  const file = join(root, 'request.json'); writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  const options = { root: join(root, 'store') };
  const output = vi.fn();
  const run = async (args = ['--file', file, '--timeout-ms', '15000', '--interval-ms', '100'], deps: Parameters<typeof cmdFleetBusRequest>[2] = {}) => {
    const code = await cmdFleetBusRequest(args, options, { ...deps, output });
    return { code, result: JSON.parse(output.mock.lastCall![0]) };
  };
  const rows = () => JSON.parse(readFileSync(join(options.root, 'bus-inbox', 'messages.json'), 'utf8')) as unknown[];
  return { root, file, options, output, run, rows };
}
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('posts once and receives a concurrently produced durable reply', async () => {
  const h = setup();
  const responder = setTimeout(() => {
    const page = listBusInboxAfter(0, 100, h.options);
    expect(page.status).toBe('ok');
    expect(appendBusInbox(reply('fake-reply'), h.options).status).toBe('posted');
  }, 30);
  const { code, result } = await h.run(); clearTimeout(responder);
  expect(code).toBe(0);
  expect(result).toMatchObject({ schema: 'fleet.bus-request.v1', outcome: 'replied', receipt: { status: 'posted', id: request.id, cursor: 1 }, reply: { cursor: 2, envelope: { id: 'fake-reply' } }, cursor: 2 });
  expect(h.rows()).toHaveLength(2);
}, 30000);

it('captures replies written during append and resumes duplicates from retained history', async () => {
  const h = setup();
  const append: typeof appendBusInbox = (input, options) => {
    const posted = appendBusInbox(input, options);
    expect(appendBusInbox(reply('fast'), options).status).toBe('posted');
    return posted;
  };
  const first = await h.run(undefined, { append });
  expect(first.result).toMatchObject({ outcome: 'replied', reply: { envelope: { id: 'fast' } } });
  const second = await h.run();
  expect(second.result).toMatchObject({ outcome: 'replied', receipt: { status: 'duplicate', cursor: 1 }, reply: { cursor: 2 } });
  expect(h.rows()).toHaveLength(2);
  const changed = { ...request, body: { text: 'different' } };
  writeFileSync(h.file, JSON.stringify(changed));
  const conflict = await h.run();
  expect(conflict.code).toBe(1);
  expect(conflict.result).toMatchObject({ outcome: 'post-refused', receipt: { status: 'conflict' } });
  expect(h.rows()).toHaveLength(2);
}, 30000);

it('ignores unrelated, wrong-routing and expired replies, without refreshing a duplicate TTL', async () => {
  const h = setup(); let now = 100;
  const options: BusInboxOptions = { ...h.options, now: () => now };
  expect(appendBusInbox(request, options).status).toBe('posted');
  for (const item of [reply('unrelated', { inReplyTo: 'other' }), reply('wrong-from', undefined, { from: 'other' }),
    reply('wrong-to', undefined, { to: 'other' }), reply('nested', { nested: { inReplyTo: request.id } }),
    reply('expired', undefined, { ttl: 10 })]) expect(appendBusInbox(item, options).status).toBe('posted');
  now = 120;
  const before = readFileSync(join(h.options.root, 'bus-inbox', 'messages.json'), 'utf8');
  const result = await requestBusRoundtrip(request, 4000, 100, options);
  expect(result).toMatchObject({ outcome: 'timeout', receipt: { status: 'duplicate' }, reply: null });
  expect(readFileSync(join(h.options.root, 'bus-inbox', 'messages.json'), 'utf8')).toBe(before);
}, 30000);

it('leaves exactly one request after timeout and cancels promptly without lingering listeners', async () => {
  const h = setup();
  const timed = await h.run(['--file', h.file, '--timeout-ms', '4000', '--interval-ms', '100']);
  expect(timed.code).toBe(1);
  expect(timed.result).toMatchObject({ outcome: 'timeout', receipt: { status: 'posted' } });
  expect(h.rows()).toHaveLength(1);
  const controller = new AbortController();
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  let abortedAt = 0;
  const pending = h.run(['--file', h.file, '--timeout-ms', '30000', '--interval-ms', '60000'], { signal: controller.signal });
  setTimeout(() => { abortedAt = performance.now(); controller.abort(); }, 20);
  const cancelled = await pending;
  expect(cancelled.result).toMatchObject({ outcome: 'cancelled', receipt: { status: 'duplicate' } });
  expect(performance.now() - abortedAt).toBeLessThan(1000);
  expect(process.listenerCount('SIGINT')).toBe(sigint);
  expect(process.listenerCount('SIGTERM')).toBe(sigterm);
}, 30000);

it('rejects invalid input before any bus access and uses convention dispatch', async () => {
  const h = setup(); const list = vi.fn(listBusInboxAfter), append = vi.fn(appendBusInbox);
  for (const args of [[], ['--file', 'relative', '--timeout-ms', '1'], ['--file', h.file],
    ['--file', h.file, '--timeout-ms', '0'], ['--file', h.file, '--timeout-ms', '3600001'],
    ['--file', h.file, '--timeout-ms', '1.5'], ['--file', h.file, '--timeout-ms', '10', '--interval-ms', '99'],
    ['--file', h.file, '--timeout-ms', '10', '--interval-ms', '60001'], ['--file', join(h.root, 'missing'), '--timeout-ms', '1']]) {
    const response = await h.run(args, { list, append });
    expect(response.code).toBe(2); expect(response.result.receipt.status).toBe('not-attempted');
  }
  writeFileSync(h.file, '{bad json');
  expect((await h.run(undefined, { list, append })).code).toBe(2);
  expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  expect(resolveFleetSubcommand('bus-request')).toEqual({ module: './fleet-bus-request.js', exportName: 'cmdFleetBusRequest' });
});

it('retries read contention within the deadline, but refuses post contention and stops on hard read failure', async () => {
  const h = setup();
  const list = vi.fn<typeof listBusInboxAfter>().mockReturnValueOnce({ status: 'retryable' }).mockImplementation(listBusInboxAfter);
  const append = vi.fn<typeof appendBusInbox>().mockReturnValue({ status: 'retryable' });
  const refused = await h.run(undefined, { list, append });
  expect(refused.result).toMatchObject({ outcome: 'post-refused', receipt: { status: 'retryable' } });
  expect(append).toHaveBeenCalledTimes(1); expect(list).toHaveBeenCalledTimes(2);
  const failed = await h.run(undefined, { list: () => ({ status: 'unavailable' }), append });
  expect(failed.result).toMatchObject({ outcome: 'source-unavailable', receipt: { status: 'not-attempted' } });
  expect(append).toHaveBeenCalledTimes(1);
});

it('scrubs returned reply content and reports source failure after an accepted post', async () => {
  const h = setup();
  const append: typeof appendBusInbox = (input, options) => {
    const posted = appendBusInbox(input, options);
    appendBusInbox(reply('sensitive', { inReplyTo: request.id, password: 'fake-secret-value' }), options);
    return posted;
  };
  const response = await h.run(undefined, { append });
  expect(response.code).toBe(0);
  expect(h.output.mock.lastCall![0]).not.toContain('fake-secret-value');
  const h2 = setup(); let reads = 0;
  const failure = await h2.run(undefined, { list: (...args) => ++reads === 1 ? listBusInboxAfter(...args) : { status: 'unavailable' } });
  expect(failure.result).toMatchObject({ outcome: 'source-unavailable', receipt: { status: 'posted' } });
}, 30000);

it('starts a new request after the initial cursor, but resumes a duplicate from retained pages', async () => {
  const old = { cursor: 1, receivedAt: 0, envelope: reply('old') };
  const list: typeof listBusInboxAfter = (after = 0) => ({
    status: 'ok', messages: after === 0 ? [old as BusInboxReceipt] : [], nextCursor: 1,
  });
  const posted = await requestBusRoundtrip(request, 150, 100, {}, { list, append: () => ({ status: 'posted', id: request.id, cursor: 2 }) });
  expect(posted).toMatchObject({ outcome: 'timeout', receipt: { status: 'posted' }, reply: null });
  const duplicate = await requestBusRoundtrip(request, 1000, 100, {}, { list, append: () => ({ status: 'duplicate', id: request.id, cursor: 2 }) });
  expect(duplicate).toMatchObject({ outcome: 'replied', reply: { cursor: 1 } });
});
