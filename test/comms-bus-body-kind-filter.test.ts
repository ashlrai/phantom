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
  const dir = mkdtempSync(join(tmpdir(), 'bus-body-kind-filter-')); roots.push(dir);
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
    ['bk-note', { kind: 'note', text: 'n', thread: 't1' }],
    ['bk-context', { kind: 'context', text: 'c' }],
    ['bk-handoff', { kind: 'worker-handoff', taskId: 'RQ-JOB-A', prompt: 'take it' }],
    ['bk-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    // A bus-transport v1 protocol.kind is the same discriminator, read through
    // the protocol object rather than a top-level kind field.
    ['bk-v1', { protocol: { version: 1, kind: 'task' }, text: 'typed' }, { to: 'fleet.deploy' }],
    // A kindless notice keys on its own type/schema discriminator.
    ['bk-notice', { type: 'delivery-receipt', messageId: 'm-1' }],
    // Bodies carrying no discriminator never match any --body-kind value.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
  ];
  for (const [id, body, extra] of rows) expect(post(options, id, body, extra).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['bk-handoff']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['bk-status']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-v1']);
  expect(await read(options, ['--body-kind', 'delivery-receipt'])).toEqual(['bk-notice']);
  // An unrecognized but printable value is an honest empty page, not an error.
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual([]);
  // Case matters: NOTE is not note.
  expect(await read(options, ['--body-kind', 'NOTE'])).toEqual([]);
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('keeps only work.result bodies reporting the requested outcome', async () => {
  const { options } = setup();
  const rows: Array<[string, unknown]> = [
    ['rs-failed', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'failed' }],
    ['rs-complete', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k2', queueId: 'q', receiptId: 'r2', outcome: 'complete' }],
    // A work.result carrying no outcome reports nothing provable.
    ['rs-no-outcome', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k3' }],
    // A work.release body's own released/completed outcome is a different
    // vocabulary and its kind is not work.result.
    ['rs-release', { kind: 'work.release', jobId: 'RQ-JOB-A', outcome: 'released' }],
    ['rs-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    ['rs-note', { kind: 'note', text: 'n' }],
    ['rs-plain', { text: 'no kind' }],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--result', 'failed'])).toEqual(['rs-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['rs-complete']);
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('composes --body-kind and --result with the address and priority filters', async () => {
  const { options } = setup();
  post(options, 'cp-failed-a', { kind: 'work.result', outcome: 'failed' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'cp-failed-b', { kind: 'work.result', outcome: 'failed' }, { from: 'agent:nova', priority: 'P2' });
  post(options, 'cp-done', { kind: 'work.result', outcome: 'complete' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'cp-status', { kind: 'work.status', status: 'running' }, { from: 'agent:orion', priority: 'P0' });

  expect(await read(options, ['--result', 'failed', '--from', 'agent:orion'])).toEqual(['cp-failed-a']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual(['cp-failed-a']);
  expect(await read(options, ['--result', 'failed', '--to', 'leaders'])).toEqual(['cp-failed-a', 'cp-failed-b']);
  expect(await read(options, ['--body-kind', 'work.result', '--result', 'complete'])).toEqual(['cp-done']);
  expect(await read(options, ['--body-kind', 'work.status', '--result', 'failed'])).toEqual([]);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'wk-failed', { kind: 'work.result', outcome: 'failed' });
  post(options, 'wk-done', { kind: 'work.result', outcome: 'complete' });
  post(options, 'wk-note', { kind: 'note', text: 'n' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['wk-failed']);

  expect(await cmdCommsBus(['watch', '--body-kind', 'note', '--max-pages', '1'], options)).toBe(0);
  const page2 = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page2.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['wk-note']);
});

it('rejects invalid or duplicate --body-kind/--result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [
      ['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind', 'a', '--body-kind', 'b'], ['--body-kind=-inline'], ['--body-kind', '--to'],
      ['--result'], ['--result', 'bogus'], ['--result', 'FAILED'], ['--result', 'failed', '--result', 'complete'],
      ['--result=failed'], ['--result', '--to'],
    ]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(await cmdCommsBus(['post', '--file', 'unused', '--result', 'failed'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind and --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'ck-r', { kind: 'work.result', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed', '--body-kind', 'work.result'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.result', result: 'failed' }));

  // A different outcome or a dropped filter is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'complete', '--body-kind', 'work.result'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options)).toBe(1);
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
