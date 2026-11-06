import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusScatter } from '../src/cli/fleet-bus-scatter.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { BUS_SCATTER_MAX_BYTES } from '../src/core/fleet/bus-scatter-request.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const roots: string[] = [];
const envelope = (id: string) => ({ id, from: 'planner', to: `agent-${id}`, priority: 'P2' as const, ttl: 60000, body: { text: 'café' } });
const batch = JSON.stringify({ version: 1, requests: [envelope('a'), envelope('b')] });
const stream = (data: Buffer | string) => Readable.from([Buffer.from(data)]);
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'scatter-stdin-'))); roots.push(root);
  const options = { root: join(root, 'bus') }, output = vi.fn(), append = vi.fn(appendBusInbox);
  const run = async (input: Readable, args: string[] = [], deps: Parameters<typeof cmdFleetBusScatter>[2] = {}) => {
    output.mockClear();
    const code = await cmdFleetBusScatter(['--stdin', '--json', ...args], options, { input, output, append, ...deps });
    expect(output).toHaveBeenCalledTimes(1);
    return { code, report: JSON.parse(String(output.mock.calls[0]![0])) };
  };
  return { root, options, output, append, run };
}
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('previews fragmented UTF-8 only after EOF, without posting or exposing bodies', async () => {
  const h = setup(), input = new PassThrough(), bytes = Buffer.from(batch), split = bytes.indexOf(Buffer.from('é'));
  const pending = h.run(input);
  input.write(bytes.subarray(0, split + 1)); input.write(bytes.subarray(split + 1));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.output).not.toHaveBeenCalled();
  expect(h.append).not.toHaveBeenCalled();
  input.end();
  const { code, report } = await pending;
  expect(code).toBe(0);
  expect(report).toMatchObject({ mode: 'preview', status: 'preview', counts: { total: 2, attempted: 0 } });
  expect(String(h.output.mock.calls[0]![0])).not.toContain('café');
  expect(existsSync(h.options.root)).toBe(false);
});

it('accepts the byte limit and rejects overflow without creating an output reservation', async () => {
  const h = setup(), dest = join(h.root, 'report.json');
  const exact = batch + ' '.repeat(BUS_SCATTER_MAX_BYTES - Buffer.byteLength(batch));
  expect((await h.run(stream(exact))).report.status).toBe('preview');
  const { code, report } = await h.run(stream(exact + ' '), ['--apply', '--output', dest]);
  expect(code).toBe(2); expect(report.status).toBe('invalid-input');
  expect(existsSync(dest)).toBe(false); expect(h.append).not.toHaveBeenCalled();
});

it.each([
  ['empty', Buffer.alloc(0)],
  ['malformed JSON', Buffer.from('{"private-input-marker":')],
  ['invalid batch', Buffer.from('{"version":1,"requests":[]}')],
  ['invalid UTF-8', Buffer.concat([Buffer.from(batch), Buffer.from([0xff])])],
  ['truncated UTF-8', Buffer.concat([Buffer.from(batch), Buffer.from([0xc3])])],
  ['extra JSON', Buffer.from(batch + '{}')],
])('rejects %s without posting or leaking input', async (_name, input) => {
  const h = setup(), dest = join(h.root, 'report.json');
  const { code, report } = await h.run(stream(input), ['--apply', '--output', dest]);
  expect(code).toBe(2); expect(report.status).toBe('invalid-input');
  expect(String(h.output.mock.calls[0]![0])).not.toContain('private-input-marker');
  expect(h.append).not.toHaveBeenCalled(); expect(existsSync(dest)).toBe(false);
});

it.each([
  [['--stdin']], [['--file', '/tmp/batch.json']], [['--json']], [['--apply', '--apply']],
  [['--timeout-ms', '100', '--timeout-ms', '100']], [['--stdin=true']],
])('rejects duplicate or conflicting flags %j before reading or posting', async args => {
  const h = setup(), input = new PassThrough();
  const { code, report } = await h.run(input, args);
  expect(code).toBe(2); expect(report.status).toBe('invalid-input');
  expect(input.listenerCount('data')).toBe(0); expect(h.append).not.toHaveBeenCalled();
});

it('waits for EOF within the shared deadline and leaves caller streams open', async () => {
  const h = setup(), input = new PassThrough(), dest = join(h.root, 'report.json');
  input.write(batch);
  const { code, report } = await h.run(input, ['--apply', '--timeout-ms', '80', '--output', dest]);
  expect(code).toBe(2); expect(report.status).toBe('invalid-input');
  expect(report.elapsedMs).toBeLessThan(2000);
  expect(input.destroyed).toBe(false); expect(existsSync(dest)).toBe(false); expect(h.append).not.toHaveBeenCalled();
});

it('charges input time to the same execution deadline', async () => {
  const h = setup(), input = new PassThrough();
  let age = 0;
  const request: NonNullable<Parameters<typeof cmdFleetBusScatter>[2]>['request'] = async (_input, _timeout, _interval, _options, deps) => {
    age = performance.now() - deps!.startedAt!;
    return { schema: 'fleet.bus-request.v1', correlation: 'untrusted-routing-only', receipt: { status: 'not-attempted' },
      outcome: 'replied', reply: null, cursor: 0, elapsedMs: 0 };
  };
  const pending = h.run(input, ['--apply', '--timeout-ms', '10000'], { request });
  await new Promise(resolve => setTimeout(resolve, 60));
  input.end(batch);
  expect((await pending).report.status).toBe('all-replied');
  expect(age).toBeGreaterThanOrEqual(50);
});

it('honors an injected abort while reading without destroying the stream', async () => {
  const h = setup(), input = new PassThrough(), controller = new AbortController();
  const pending = h.run(input, ['--apply'], { signal: controller.signal });
  controller.abort();
  expect((await pending).report.status).toBe('cancelled');
  expect(input.destroyed).toBe(false); expect(input.listenerCount('data')).toBe(0);
  expect(h.append).not.toHaveBeenCalled();
});

it.each(['SIGINT', 'SIGTERM'] as const)('handles %s while waiting and removes only its own listeners', async name => {
  const h = setup(), input = new PassThrough(), external = vi.fn();
  process.on(name, external);
  const before = process.listeners(name), on = process.on.bind(process);
  let stop: (() => void) | undefined;
  vi.spyOn(process, 'on').mockImplementation(((event: string, listener: (...args: never[]) => void) => {
    if (event === name) stop = listener;
    return on(event, listener);
  }) as typeof process.on);
  try {
    const pending = h.run(input, ['--apply']);
    stop?.();
    const { code, report } = await pending;
    expect(code).toBe(1); expect(report.status).toBe('cancelled');
    expect(process.listeners(name)).toEqual(before);
    expect(input.listenerCount('data')).toBe(0); expect(input.destroyed).toBe(false);
    expect(h.append).not.toHaveBeenCalled();
  } finally { process.off(name, external); }
});

it('uses the real bus for concurrent requests and correlated replies, saving the report', async () => {
  const h = setup(), answered = new Set<string>(), dest = join(h.root, 'report.json');
  const timer = setInterval(() => {
    const page = listBusInboxAfter(0, 100, h.options);
    if (page.status !== 'ok') return;
    for (const id of ['b', 'a']) {
      if (!answered.has(id) && page.messages.some(row => row.envelope.id === id)) {
        const reply = { ...envelope(`reply-${id}`), from: `agent-${id}`, to: 'planner', body: { inReplyTo: id } };
        if (appendBusInbox(reply, h.options).status === 'posted') answered.add(id);
      }
    }
  }, 20);
  try {
    const { code, report } = await h.run(stream(batch), ['--apply', '--timeout-ms', '30000', '--output', dest]);
    expect(code, JSON.stringify(report)).toBe(0); expect(report.status).toBe('all-replied');
    expect(report.requests.map((row: { result: { reply: { envelope: { body: { inReplyTo: string } } } } }) =>
      row.result.reply.envelope.body.inReplyTo)).toEqual(['a', 'b']);
    expect(JSON.parse(readFileSync(dest, 'utf8'))).toEqual(report);
    expect(h.append).toHaveBeenCalledTimes(2);
  } finally { clearInterval(timer); }
});
