import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
import * as inbox from '../src/core/fleet/bus-inbox.js';
import { appendBusInbox, type BusInboxOptions } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }));
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'bus-bodykind-result-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => 100 } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 60_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only envelopes whose body carries the exact kind discriminator', async () => {
  const { options } = setup();
  const rows: Array<[string, unknown, Record<string, unknown>?]> = [
    ['bk-post', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] }],
    ['bk-result-failed', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'r', outcome: 'failed' }],
    ['bk-result-complete', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', receiptId: 'r2', outcome: 'complete' }],
    // A work.release outcome is a different vocabulary and never a result.
    ['bk-release', { kind: 'work.release', jobId: 'RQ-A', outcome: 'released' }],
    ['bk-note', { kind: 'note', text: 'n' }],
    // The v1 protocol.kind fallback discriminates a kindless-v2 body; the
    // protocol topic must equal the envelope to field.
    ['bk-protocol-task', { protocol: { version: 1, kind: 'task', topic: 'fleet.x' }, text: 't' }, { to: 'fleet.x' }],
    // The type/schema fallback discriminates a notice body.
    ['bk-notice', { type: 'ops.notice', text: 'n' }],
    // A body carrying no discriminator never matches.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
  ];
  for (const [id, body, extra] of rows) expect(post(options, id, body, extra).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['bk-result-failed', 'bk-result-complete']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['bk-post']);
  expect(await read(options, ['--body-kind', 'work.release'])).toEqual(['bk-release']);
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-protocol-task']);
  expect(await read(options, ['--body-kind', 'ops.notice'])).toEqual(['bk-notice']);
  // Exact and case-sensitive: a near-miss and an absent discriminator read empty.
  expect(await read(options, ['--body-kind', 'Work.Result'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'unrecognized-but-printable'])).toEqual([]);
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('keeps only work.result bodies reporting the exact outcome', async () => {
  const { options } = setup();
  post(options, 'rk-failed', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'r', outcome: 'failed' });
  post(options, 'rk-complete', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', receiptId: 'r2', outcome: 'complete' });
  post(options, 'rk-reserved', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-cccccccccccccccccccccccccccccccc', receiptId: 'r3', outcome: 'reserved' });
  // work.release's own released/completed vocabulary is out of scope.
  post(options, 'rk-release', { kind: 'work.release', jobId: 'RQ-A', outcome: 'released' });
  post(options, 'rk-no-outcome', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k' });
  post(options, 'rk-note', { kind: 'note', text: 'n' });

  expect(await read(options, ['--result', 'failed'])).toEqual(['rk-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['rk-complete']);
  expect(await read(options, ['--result', 'reserved'])).toEqual(['rk-reserved']);
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('composes --body-kind and --result with the other page filters', async () => {
  const { options } = setup();
  post(options, 'cb-failed-a', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'r', outcome: 'failed' });
  post(options, 'cb-failed-b', { kind: 'work.result', jobId: 'RQ-B', claimKey: 'k', queueId: 'peer-work-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', receiptId: 'r2', outcome: 'failed' }, { priority: 'P0' });
  post(options, 'cb-complete', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-cccccccccccccccccccccccccccccccc', receiptId: 'r3', outcome: 'complete' });
  post(options, 'cb-post', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] });

  expect(await read(options, ['--body-kind', 'work.result', '--result', 'failed'])).toEqual(['cb-failed-a', 'cb-failed-b']);
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-B'])).toEqual(['cb-failed-b']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual(['cb-failed-b']);
  expect(await read(options, ['--result', 'failed', '--id', 'cb-failed-a'])).toEqual(['cb-failed-a']);
  expect(await read(options, ['--body-kind', 'work.post', '--result', 'failed'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'note', '--result', 'failed'])).toEqual([]);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'wb-result', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'r', outcome: 'failed' });
  post(options, 'wb-note', { kind: 'note', text: 'n' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.result', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['wb-result']);
});

it('rejects invalid --body-kind and --result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--result', 'bogus'], ['--result', 'FAILED'], ['--result', ''],
      ['--body-kind', 'has space'], ['--body-kind', ''], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind'], ['--result'], ['--result', 'failed', '--result', 'complete'],
      ['--body-kind=-inline'], ['--result=-inline'], ['--body-kind', '--to'], ['--result', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--result', 'failed'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind and --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'ck-result', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'r', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed', '--body-kind', 'work.result'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.result', result: 'failed' }));

  // A different outcome or a dropped filter is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'complete'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --body-kind and --result in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(await cmdCommsBus(['read', '--help'])).toBe(0);
  expect(await cmdCommsBus(['watch', '--help'])).toBe(0);
  const help = log.mock.calls.map(call => String(call[0])).join('\n');
  expect(help).toContain('--body-kind <kind>');
  expect(help).toContain('--result <reserved|admitted|complete|failed>');
});
