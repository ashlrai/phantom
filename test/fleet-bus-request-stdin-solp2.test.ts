import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { getEventListeners } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBusRequest } from '../src/cli/fleet-bus-request.js';
import { MAX_BUS_ENVELOPE_BYTES } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const request = { id: 'request-stdin', from: 'agent-a', to: 'agent-b', priority: 'P2', ttl: 60000, body: { text: 'private-body-marker' } };
const args = ['--file', '-', '--timeout-ms', '30000', '--interval-ms', '100'];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'bus-request-stdin-'));
  roots.push(root);
  const options = { root: join(root, 'store') }, output = vi.fn();
  const run = async (input: Readable, extra: Parameters<typeof cmdFleetBusRequest>[2] = {}, argv = args) => {
    output.mockClear();
    const code = await cmdFleetBusRequest(argv, options, { ...extra, input, output });
    expect(output).toHaveBeenCalledTimes(1);
    return { code, result: JSON.parse(output.mock.calls[0]![0] as string), printed: output.mock.calls[0]![0] as string };
  };
  return { root, options, output, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('reads split UTF-8 bytes and receives a reply through real temporary bus storage', async () => {
  const h = setup();
  const envelope = { ...request, body: { text: 'hello 🌍' } };
  const bytes = Buffer.from(JSON.stringify(envelope));
  const split = bytes.indexOf(Buffer.from('🌍')) + 1;
  const append: typeof appendBusInbox = (input, options) => {
    const result = appendBusInbox(input, options);
    expect(appendBusInbox({ id: 'reply-stdin', from: request.to, to: request.from, priority: 'P2', ttl: 60000,
      body: { inReplyTo: request.id, password: 'fake-secret-value' } }, options).status).toBe('posted');
    return result;
  };
  const response = await h.run(Readable.from([bytes.subarray(0, split), bytes.subarray(split)]), { append });
  expect(response.code).toBe(0);
  expect(response.result).toMatchObject({ schema: 'fleet.bus-request.v1', outcome: 'replied', receipt: { status: 'posted', cursor: 1 },
    reply: { cursor: 2, envelope: { id: 'reply-stdin', body: { password: '[REDACTED]' } } } });
  expect(response.printed).not.toContain('fake-secret-value');
  const page = listBusInboxAfter(0, 100, h.options);
  expect(page.status).toBe('ok');
  if (page.status === 'ok') expect(page.messages.map(row => row.envelope.id)).toEqual([request.id, 'reply-stdin']);
}, 30000);

it('rejects empty, malformed, invalid and oversized input before any bus access', async () => {
  const h = setup(), list = vi.fn(listBusInboxAfter), append = vi.fn(appendBusInbox);
  const payloads = [Buffer.alloc(0), Buffer.from('{bad private-body-marker'), Buffer.from([0xff]),
    Buffer.from(JSON.stringify({ ...request, ttl: 0 })), Buffer.alloc(MAX_BUS_ENVELOPE_BYTES + 1, 32),
    Buffer.concat([Buffer.from(JSON.stringify(request)), Buffer.alloc(MAX_BUS_ENVELOPE_BYTES, 32)])];
  for (const payload of payloads) {
    const response = await h.run(Readable.from([payload]), { list, append });
    expect(response.code).toBe(2);
    expect(response.result).toMatchObject({ outcome: 'invalid-input', receipt: { status: 'not-attempted' }, reply: null });
    expect(response.printed).not.toContain('private-body-marker');
  }
  expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  expect(listBusInboxAfter(0, 100, h.options)).toMatchObject({ status: 'ok', messages: [] });
});

it('times out before EOF without posting or destroying the stream', async () => {
  const h = setup(), input = new Readable({ read() {} }), append = vi.fn(appendBusInbox);
  const before = performance.now();
  const response = await h.run(input, { append }, ['--file', '-', '--timeout-ms', '100']);
  expect(response.result).toMatchObject({ outcome: 'timeout', receipt: { status: 'not-attempted' } });
  expect(performance.now() - before).toBeLessThan(1500);
  expect(append).not.toHaveBeenCalled(); expect(input.destroyed).toBe(false);
});

it('cancels promptly and removes input, abort, and process listeners', async () => {
  const h = setup(), input = new Readable({ read() {} }), controller = new AbortController(), append = vi.fn(appendBusInbox);
  const events = ['data', 'end', 'error', 'close'] as const;
  const before = events.map(event => input.listenerCount(event));
  const signalListeners = getEventListeners(controller.signal, 'abort').length;
  const sigint = process.listenerCount('SIGINT'), sigterm = process.listenerCount('SIGTERM');
  const pending = h.run(input, { signal: controller.signal, append });
  controller.abort();
  const response = await pending;
  expect(response.result).toMatchObject({ outcome: 'cancelled', receipt: { status: 'not-attempted' } });
  expect(events.map(event => input.listenerCount(event))).toEqual(before);
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(signalListeners);
  expect(process.listenerCount('SIGINT')).toBe(sigint); expect(process.listenerCount('SIGTERM')).toBe(sigterm);
  expect(input.destroyed).toBe(false); expect(append).not.toHaveBeenCalled();
});

it('counts time spent awaiting EOF against both timeout and envelope TTL', async () => {
  const h = setup(), input = new Readable({ read() {} }), append = vi.fn(appendBusInbox);
  const pending = h.run(input, { append }, ['--file', '-', '--timeout-ms', '1000']);
  input.push(JSON.stringify({ ...request, ttl: 30 }));
  await new Promise(resolve => setTimeout(resolve, 80));
  input.push(null);
  const response = await pending;
  expect(response.result).toMatchObject({ outcome: 'timeout', receipt: { status: 'not-attempted' } });
  expect(append).not.toHaveBeenCalled();
});

it('keeps file input and exposes stdin usage through help', async () => {
  const h = setup(), file = join(h.root, 'request.json');
  writeFileSync(file, JSON.stringify(request));
  const append: typeof appendBusInbox = (input, options) => {
    const result = appendBusInbox(input, options);
    appendBusInbox({ ...request, id: 'file-reply', from: request.to, to: request.from, body: { inReplyTo: request.id } }, options);
    return result;
  };
  const response = await h.run(Readable.from([]), { append }, ['--file', file, '--timeout-ms', '30000']);
  expect(response.result).toMatchObject({ outcome: 'replied', receipt: { status: 'posted' } });
  h.output.mockClear();
  expect(await cmdFleetBusRequest(['--help'], h.options, { output: h.output })).toBe(0);
  expect(h.output).toHaveBeenCalledOnce(); expect(h.output.mock.calls[0]![0]).toContain('--file -');
}, 30000);
