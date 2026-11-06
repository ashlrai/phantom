import { expect, it, vi } from 'vitest';
import { runBusNotesContext } from '../examples/agents/bus-notes-context.js';
import {
  BUS_INBOX_MAX_MESSAGES,
  BUS_INBOX_MAX_READ,
  listBusInboxAfter,
  type BusInboxPage,
  type BusInboxReceipt,
} from '../src/core/fleet/bus-inbox.js';
import { type BusJsonValue } from '../src/core/fleet/bus-envelope.js';
import { buildNodeContextPack } from '../src/core/fleet/node-context-pack.js';

const to = 'fake-node';
const ARGS = ['--to', to, '--job', 'fake-current', '--upstream', 'fake-up-a', '--upstream', 'fake-up-b'];
const args = (...extra: string[]) => [...ARGS, '--byte-budget', '4096', ...extra];

function note(jobId: string, text: BusJsonValue = `fake note for ${jobId}`) {
  return { kind: 'worker-notes', jobId, text };
}
function receipt(cursor: number, body: BusJsonValue, address = to): BusInboxReceipt {
  return { cursor, receivedAt: 1, envelope: { id: `fake-msg-${cursor}`, from: 'fake-worker', to: address, priority: 'P2', ttl: 1000, body } };
}
function setup(pages: BusInboxPage[]) {
  const lines: string[] = [];
  const read = vi.fn<typeof listBusInboxAfter>();
  for (const page of pages) read.mockReturnValueOnce(page);
  read.mockImplementation((after = 0) => ({ status: 'ok', messages: [], nextCursor: after }));
  const deps = { read, write: (text: string) => { lines.push(text); } };
  return { deps, lines, read, result: () => JSON.parse(lines[0] ?? 'null') as Record<string, unknown> };
}
function pack(outputs: { jobId: string; text: string }[], upstreamJobIds = ['fake-up-a', 'fake-up-b'], byteBudget = 4096) {
  return buildNodeContextPack({ node: { jobId: 'fake-current', upstreamJobIds }, tasks: [], outputs, byteBudget });
}

it('selects only addressed worker-notes with a declared upstream jobId and string text', () => {
  const f = setup([{ status: 'ok', nextCursor: 10, messages: [
    receipt(1, note('fake-up-a'), 'fake-other-node'),
    receipt(2, { kind: 'chat', jobId: 'fake-up-a', text: 'fake chat' }),
    receipt(3, note('fake-unlisted', 'fake stray')),
    receipt(4, note('fake-up-a', 42)),
    receipt(5, note('fake-up-a', null)),
    receipt(6, { kind: 'worker-notes', jobId: 'fake-up-a' }),
    receipt(7, 'fake-string-body'),
    receipt(8, note('fake-up-a')),
    receipt(9, note('fake-up-b', 'fake retained b')),
    receipt(10, note('fake-up-a', 'fake retained a')),
  ] }]);
  expect(runBusNotesContext(args(), f.deps)).toBe(0);
  const expected = pack([
    { jobId: 'fake-up-a', text: 'fake note for fake-up-a' },
    { jobId: 'fake-up-b', text: 'fake retained b' },
    { jobId: 'fake-up-a', text: 'fake retained a' },
  ]);
  expect(f.result()).toEqual({ v: 1, status: 'ok', jobId: 'fake-current', pack: expected,
    bytes: Buffer.byteLength(expected, 'utf8'), selected: 3,
    citedUpstreamJobIds: ['fake-up-a', 'fake-up-b'], missingUpstreamJobIds: [], nextCursor: 10, complete: true });
  expect(f.read.mock.calls.map(call => [call[0], call[1]])).toEqual([[0, BUS_INBOX_MAX_READ], [10, BUS_INBOX_MAX_READ]]);
});

it('keeps retained inbox order for out-of-order upstream outputs and cites in pack order', () => {
  const f = setup([{ status: 'ok', nextCursor: 3, messages: [
    receipt(2, note('fake-up-b', 'fake note b first')),
    receipt(3, note('fake-up-a', 'fake note a later')),
  ] }]);
  expect(runBusNotesContext(args(), f.deps)).toBe(0);
  const expected = pack([{ jobId: 'fake-up-b', text: 'fake note b first' }, { jobId: 'fake-up-a', text: 'fake note a later' }]);
  expect(expected.indexOf('fake-up-b')).toBeLessThan(expected.indexOf('fake-up-a'));
  expect(f.result()).toEqual({ v: 1, status: 'ok', jobId: 'fake-current', pack: expected,
    bytes: Buffer.byteLength(expected, 'utf8'), selected: 2,
    citedUpstreamJobIds: ['fake-up-b', 'fake-up-a'], missingUpstreamJobIds: [], nextCursor: 3, complete: true });
});

it('applies the byte budget and reports an uncited upstream as missing', () => {
  const full = pack([{ jobId: 'fake-up-a', text: 'fake note a' }, { jobId: 'fake-up-b', text: 'fake note b' }]);
  const firstLine = `${full.split('\n')[0]}\n`;
  const budget = Buffer.byteLength(firstLine, 'utf8');
  const page = (): BusInboxPage => ({ status: 'ok', nextCursor: 3, messages: [
    receipt(2, note('fake-up-a', 'fake note a')), receipt(3, note('fake-up-b', 'fake note b')),
  ] });
  const f = setup([page()]);
  expect(runBusNotesContext([...ARGS, '--byte-budget', String(budget)], f.deps)).toBe(0);
  expect(f.result()).toMatchObject({ v: 1, status: 'ok', pack: firstLine, bytes: budget, selected: 2,
    citedUpstreamJobIds: ['fake-up-a'], missingUpstreamJobIds: ['fake-up-b'], nextCursor: 3, complete: true });

  const g = setup([page()]);
  const truncating = budget - 1;
  expect(runBusNotesContext([...ARGS, '--byte-budget', String(truncating)], g.deps)).toBe(0);
  const truncated = g.result();
  expect(truncated['bytes']).toBeLessThanOrEqual(truncating);
  const line = JSON.parse((truncated['pack'] as string).trim()) as { jobId: string; text: string; truncated: boolean };
  expect(line).toMatchObject({ jobId: 'fake-up-a', truncated: true });
  expect('fake note a'.startsWith(line.text)).toBe(true);
  expect(truncated['citedUpstreamJobIds']).toEqual(['fake-up-a']);
});

it('reports declared upstreams without retained notes as missing in declared order', () => {
  const pages = (): BusInboxPage[] => [
    { status: 'ok', nextCursor: 5, messages: [receipt(4, note('fake-unlisted')), receipt(5, note('fake-up-b', 'fake note b'))] },
    { status: 'ok', nextCursor: 6, messages: [] },
  ];
  const f = setup(pages());
  expect(runBusNotesContext(args(), f.deps)).toBe(0);
  expect(f.result()).toMatchObject({ status: 'ok', selected: 1,
    citedUpstreamJobIds: ['fake-up-b'], missingUpstreamJobIds: ['fake-up-a'], nextCursor: 6, complete: true });
  const g = setup(pages());
  const argv = ['--to', to, '--job', 'fake-current', '--upstream', 'fake-up-c', '--upstream', 'fake-up-a',
    '--upstream', 'fake-up-b', '--byte-budget', '4096'];
  expect(runBusNotesContext(argv, g.deps)).toBe(0);
  expect(g.result()).toMatchObject({ citedUpstreamJobIds: ['fake-up-b'], missingUpstreamJobIds: ['fake-up-c', 'fake-up-a'] });
});

it('rejects invalid arguments before any inbox read', () => {
  const f = setup([]);
  const many = Array.from({ length: 21 }, (_, i) => `--upstream fake-v${i}`).join(' ').split(' ');
  const invalid = [
    [...ARGS],
    args('--after', '-1'), args('--after', '01'), args('--after', '1.5'),
    args('--bogus', 'x'), [...ARGS, '--byte-budget', 'x'],
    [...ARGS, '--byte-budget', '0'], [...ARGS, '--byte-budget', '65537'],
    [...ARGS, '--byte-budget', '4096', '--job', 'fake-other'],
    ['--to', 'fake space', '--job', 'fake-current', '--upstream', 'fake-up-a', '--byte-budget', '100'],
    ['--to', to, '--job', 'bad/job', '--upstream', 'fake-up-a', '--byte-budget', '100'],
    ['--to', to, '--job', 'fake-current', '--upstream', 'bad id', '--byte-budget', '100'],
    ['--to', to, '--job', 'fake-current', '--byte-budget', '100'],
    ['--to', to, '--job', 'fake-current', '--upstream', 'fake-up-a', '--upstream', 'fake-up-a', '--byte-budget', '100'],
    [...many, '--to', to, '--job', 'fake-current', '--byte-budget', '100'],
    [...ARGS, '--byte-budget', '4096', '--upstream', '--after'],
  ];
  for (const argv of invalid) {
    expect(runBusNotesContext(argv, f.deps)).toBe(2);
    expect(f.result()).toEqual({ status: 'invalid-arguments' });
    f.lines.length = 0;
  }
  expect(runBusNotesContext(args('--after'), f.deps)).toBe(2);
  expect(f.read).not.toHaveBeenCalled();
});

it('bounds the scan at the retained inbox maximum and labels the read incomplete', () => {
  const f = setup([]);
  const read = vi.fn<typeof listBusInboxAfter>((after = 0) => ({ status: 'ok', messages: [], nextCursor: after + 1 }));
  expect(runBusNotesContext(args(), { ...f.deps, read })).toBe(0);
  const bound = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
  expect(read).toHaveBeenCalledTimes(bound);
  expect(f.result()).toMatchObject({ status: 'ok', complete: false, nextCursor: bound, selected: 0 });
});

it('reports read failures with partial results, a preserved cursor, and stable reasons', () => {
  const f = setup([
    { status: 'ok', nextCursor: 2, messages: [receipt(2, note('fake-up-a', 'fake note a'))] },
    { status: 'unavailable' },
  ]);
  expect(runBusNotesContext(args(), f.deps)).toBe(4);
  expect(f.result()).toMatchObject({ status: 'read-failed', reason: 'unavailable', selected: 1,
    citedUpstreamJobIds: ['fake-up-a'], missingUpstreamJobIds: ['fake-up-b'], nextCursor: 2, complete: false });
  expect(f.read.mock.calls.map(call => call[0])).toEqual([0, 2]);

  f.lines.length = 0;
  const boom = vi.fn<typeof listBusInboxAfter>(() => { throw new Error('fake private detail'); });
  expect(runBusNotesContext(args(), { ...f.deps, read: boom })).toBe(4);
  expect(f.result()).toMatchObject({ status: 'read-failed', reason: 'unavailable', nextCursor: 0 });
  expect(f.lines[0]).not.toContain('fake private detail');

  f.lines.length = 0;
  const stale = vi.fn<typeof listBusInboxAfter>(() => ({ status: 'invalid' }));
  expect(runBusNotesContext(args('--after', '5'), { ...f.deps, read: stale })).toBe(2);
  expect(stale).toHaveBeenCalledWith(5, BUS_INBOX_MAX_READ, undefined);
  expect(f.result()).toEqual({ status: 'invalid-cursor' });

  f.lines.length = 0;
  const regress = vi.fn<typeof listBusInboxAfter>(() => ({ status: 'ok', messages: [], nextCursor: -1 }));
  expect(runBusNotesContext(args(), { ...f.deps, read: regress })).toBe(4);
  expect(f.result()).toMatchObject({ status: 'read-failed', reason: 'cursor-invalid' });
});
