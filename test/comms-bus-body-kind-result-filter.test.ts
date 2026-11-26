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
  const dir = mkdtempSync(join(tmpdir(), 'bus-kind-result-filter-')); roots.push(dir);
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
  const rows: Array<[string, unknown]> = [
    ['bk-note', { kind: 'note', text: 'hi' }],
    ['bk-context', { kind: 'context', text: 'ctx' }],
    ['bk-post', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] }],
    ['bk-status', { kind: 'work.status', jobId: 'RQ-A', status: 'running' }],
    ['bk-claim', { kind: 'work.claim', op: 'acquire', claimKey: 'repo:o/n', owner: 'a', leaseMs: 1000 }],
    ['bk-result', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'complete' }],
    ['bk-release', { kind: 'work.release', claimKey: 'k', token: 't', outcome: 'released' }],
    ['bk-wake', { kind: 'wake', target: 'agent:nova', reason: 'r' }],
    ['bk-handoff', { kind: 'worker-handoff', taskId: 'RQ-A', prompt: 'take it' }],
    // A bus-transport v1 protocol kind is a discriminator too.
    ['bk-protocol', { protocol: { version: 1, kind: 'task' }, payload: {} }],
    // A kindless notice keyed on type/schema is a discriminator.
    ['bk-notice', { type: 'fleet-event', schema: 'fleet-event.v1' }],
    // No discriminator anywhere: never matches.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['bk-result']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['bk-post']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['bk-handoff']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-protocol']);
  expect(await read(options, ['--body-kind', 'fleet-event'])).toEqual(['bk-notice']);
  // An unrecognized but printable value is an honest empty page.
  expect(await read(options, ['--body-kind', 'no-such-kind'])).toEqual([]);
  // The unfiltered page still sees every retained envelope.
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('keeps only work.result receipts reporting that outcome', async () => {
  const { options } = setup();
  const rows: Array<[string, unknown]> = [
    ['br-failed', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'q', receiptId: 'r1', outcome: 'failed' }],
    ['br-complete', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'q', receiptId: 'r2', outcome: 'complete' }],
    // A work.result carrying no outcome names no provable outcome.
    ['br-no-outcome', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'q', receiptId: 'r3' }],
    // A work.release body's own released/completed outcome never matches.
    ['br-release', { kind: 'work.release', claimKey: 'k', token: 't', outcome: 'released' }],
    ['br-status', { kind: 'work.status', jobId: 'RQ-A', status: 'done' }],
    ['br-note', { kind: 'note', text: 'mentions outcome complete', outcome: 'complete' }],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--result', 'failed'])).toEqual(['br-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['br-complete']);
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  // --body-kind and --result compose conjunctively. A work.release body's
  // own released/completed outcome is outside the result vocabulary, so it
  // can never match — the invalid-values test below proves the flag refuses it.
  expect(await read(options, ['--body-kind', 'work.result', '--result', 'failed'])).toEqual(['br-failed']);
  expect(await read(options, ['--body-kind', 'work.release', '--result', 'complete'])).toEqual([]);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'bw-note', { kind: 'note', text: 'n' });
  post(options, 'bw-result', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'complete' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.result', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['bw-result']);
});

it('rejects invalid or duplicate filter values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [
      ['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind', 'note', '--body-kind', 'context'], ['--body-kind=-inline'], ['--body-kind', '--to'],
      ['--result'], ['--result', 'bogus'], ['--result', 'COMPLETE'], ['--result', 'released'],
      ['--result', 'complete', '--result', 'failed'], ['--result=-inline'], ['--result', '--to'],
    ]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'unused', '--result', 'complete'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind and --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'bc-a', { kind: 'work.result', jobId: 'RQ-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'complete' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'complete'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.result', result: 'complete' }));

  // A different filter value or a dropped filter is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'failed'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result'], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --body-kind and --result in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  const help = String(log.mock.calls.at(-1)?.[0]);
  expect(help).toContain('--body-kind <kind>');
  expect(help).toContain('--result <reserved|admitted|complete|failed>');
});
