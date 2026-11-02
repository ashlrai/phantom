import { expect, it, vi } from 'vitest';
import { runBusGather } from '../examples/agents/bus-gather.js';
import { BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxReceipt } from '../src/core/fleet/bus-inbox.js';

const manifest = { coordinator: 'fake-coordinator', requests: [
  { requestId: 'fake-request-1', worker: 'fake-worker-1' },
  { requestId: 'fake-request-2', worker: 'fake-worker-2' },
] };
const args = ['--file', 'fake.json', '--after', '7', '--timeout-ms', '500'];
function row(cursor: number, requestId: string, from = 'fake-worker-1', to = 'fake-coordinator'): BusInboxReceipt {
  return { cursor, receivedAt: 1, envelope: { id: `fake-reply-${cursor}`, from, to, priority: 'P2', ttl: 1000, body: { inReplyTo: requestId } } };
}
function setup(pages: ReturnType<typeof listBusInboxAfter>[]) {
  let clock = 0;
  const lines: string[] = [];
  const read = vi.fn<typeof listBusInboxAfter>();
  for (const page of pages) read.mockReturnValueOnce(page);
  read.mockImplementation(after => ({ status: 'ok', messages: [], nextCursor: after ?? 0 }));
  const deps = { readFile: () => JSON.stringify(manifest), read, now: () => clock,
    wait: vi.fn(async (ms: number) => { clock += ms; }), write: (text: string) => lines.push(text) };
  return { deps, lines, result: () => JSON.parse(lines[0]!) as Record<string, unknown> };
}

it('drains pages, matches exact peers, keeps first replies and orders by manifest', async () => {
  const second = row(8, 'fake-request-2', 'fake-worker-2');
  const first = row(14, 'fake-request-1');
  const f = setup([
    { status: 'ok', nextCursor: 12, messages: [second, row(9, 'fake-request-2', 'fake-worker-2'),
      row(10, 'fake-request-1', 'fake-impostor'), row(11, 'fake-request-1', 'fake-worker-1', 'fake-other'),
      row(12, 'fake-unknown')] },
    { status: 'ok', nextCursor: 14, messages: [first] },
  ]);
  expect(await runBusGather(args, f.deps)).toBe(0);
  expect(f.lines).toHaveLength(1);
  expect(f.result()).toEqual({ status: 'complete', replies: [
    { requestId: 'fake-request-1', reply: first }, { requestId: 'fake-request-2', reply: second },
  ], pending: [], nextCursor: 14 });
  expect(f.deps.read.mock.calls.map(call => [call[0], call[1]])).toEqual([[7, BUS_INBOX_MAX_READ], [12, BUS_INBOX_MAX_READ]]);
  expect(f.deps.wait).not.toHaveBeenCalled();
});

it('advances across expired and unrelated pages, then times out with partial results', async () => {
  const first = row(9, 'fake-request-1');
  const f = setup([{ status: 'ok', nextCursor: 8, messages: [] },
    { status: 'ok', nextCursor: 10, messages: [first, row(10, 'fake-unrelated')] }]);
  expect(await runBusGather(args, f.deps)).toBe(5);
  expect(f.result()).toEqual({ status: 'timeout', replies: [{ requestId: 'fake-request-1', reply: first }],
    pending: ['fake-request-2'], nextCursor: 10 });
  expect(f.deps.read.mock.calls.slice(0, 3).map(call => call[0])).toEqual([7, 8, 10]);
  expect(f.deps.wait.mock.calls.map(call => call[0])).toEqual([250, 250]);
});

it('returns partial results and cursor on cancellation during a wait', async () => {
  const controller = new AbortController(), first = row(8, 'fake-request-1');
  const f = setup([{ status: 'ok', nextCursor: 8, messages: [first] }]);
  const wait = async () => { controller.abort(); throw new Error('fake private detail'); };
  expect(await runBusGather(args, { ...f.deps, wait, signal: controller.signal })).toBe(130);
  expect(f.result()).toEqual({ status: 'interrupted', replies: [{ requestId: 'fake-request-1', reply: first }],
    pending: ['fake-request-2'], nextCursor: 8 });
});

it('bounds continuously advancing pages before waiting and observes cancellation before reading', async () => {
  const f = setup([]);
  const read = vi.fn<typeof listBusInboxAfter>((after = 0) => ({ status: 'ok', nextCursor: after + 1, messages: [] }));
  expect(await runBusGather(['--file', 'fake', '--timeout-ms', '1'], { ...f.deps, read })).toBe(5);
  expect(read).toHaveBeenCalledTimes(12);
  expect(f.deps.wait).toHaveBeenCalledTimes(1);
  expect(f.result()).toMatchObject({ status: 'timeout', nextCursor: 12 });
  f.lines.length = 0;
  const controller = new AbortController(); controller.abort();
  read.mockClear();
  expect(await runBusGather(args, { ...f.deps, read, signal: controller.signal })).toBe(130);
  expect(read).not.toHaveBeenCalled();
  expect(f.result()).toMatchObject({ status: 'interrupted', nextCursor: 7 });
});

it('validates arguments and manifests before reading the inbox', async () => {
  const f = setup([]);
  for (const input of [[], ['--file', 'fake', '--timeout-ms', '0'], ['--file', 'fake', '--timeout-ms', '300001'],
    ['--file', 'fake', '--timeout-ms', '1', '--after', '-1'], ['--file', 'fake', '--timeout-ms', '1', '--after', '01'],
    ['--file', 'fake', '--timeout-ms', '1', '--file', 'fake']]) {
    expect(await runBusGather(input, f.deps)).toBe(2);
    expect(f.result()).toEqual({ status: 'invalid-arguments' }); f.lines.length = 0;
  }
  for (const input of [null, {}, { ...manifest, requests: [] }, { ...manifest, requests: Array(21).fill(manifest.requests[0]) },
    { ...manifest, requests: [manifest.requests[0], manifest.requests[0]] },
    { ...manifest, coordinator: 'fake space' }, { ...manifest, requests: [{ requestId: 'fake', worker: '' }] }]) {
    expect(await runBusGather(args, { ...f.deps, readFile: () => JSON.stringify(input) })).toBe(2);
    expect(f.result()).toEqual({ status: 'invalid-manifest' }); f.lines.length = 0;
  }
  expect(f.deps.read).not.toHaveBeenCalled();
});

it('reports stable errors without exposing exception text and preserves progress', async () => {
  const f = setup([{ status: 'ok', nextCursor: 8, messages: [row(8, 'fake-request-1')] }, { status: 'unavailable' }]);
  expect(await runBusGather(args, f.deps)).toBe(4);
  expect(f.result()).toMatchObject({ status: 'read-failed', reason: 'unavailable', pending: ['fake-request-2'], nextCursor: 8 });
  f.lines.length = 0;
  expect(await runBusGather(args, { ...f.deps, readFile: () => { throw new Error('fake private detail'); } })).toBe(2);
  expect(f.result()).toEqual({ status: 'file-unavailable' });
  f.lines.length = 0;
  expect(await runBusGather(args, { ...f.deps, read: () => ({ status: 'ok', nextCursor: 6, messages: [] }) })).toBe(4);
  expect(f.result()).toMatchObject({ status: 'read-failed', reason: 'cursor-invalid', nextCursor: 7 });
  f.lines.length = 0;
  expect(await runBusGather(args, { ...f.deps, read: () => { throw new Error('fake private detail'); } })).toBe(4);
  expect(f.result()).toMatchObject({ status: 'read-failed', reason: 'unavailable' });
  expect(f.lines[0]).not.toContain('fake private detail');
});
