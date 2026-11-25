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
  const dir = mkdtempSync(join(tmpdir(), 'bus-kind-result-')); roots.push(dir);
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

it('keeps only envelopes whose body carries the --body-kind discriminator', async () => {
  const { options } = setup();
  const rows: Array<[string, unknown, Record<string, unknown>?]> = [
    ['bk-note', { kind: 'note', text: 'hi' }],
    ['bk-context', { kind: 'context', text: 'ctx' }],
    ['bk-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    ['bk-result', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'complete' }],
    ['bk-release', { kind: 'work.release', jobId: 'RQ-JOB-A', claimKey: 'k', outcome: 'released' }],
    ['bk-handoff', { kind: 'worker-handoff', taskId: 'RQ-JOB-A', prompt: 'take it' }],
    // A bus-transport v1 protocol.kind is a discriminator too; its topic must
    // be a namespaced name equal to the envelope to.
    ['bk-protocol', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, text: 'deploy' }, { to: 'fleet.deploy' }],
    // A kindless notice keys on its type/schema discriminator.
    ['bk-type', { type: 'planner-cycle-result.v1', cycle: 3 }],
    // Bodies carrying no discriminator never match.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
  ];
  for (const [id, body, extra] of rows) expect(post(options, id, body, extra).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note']);
  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['bk-result']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-protocol']);
  expect(await read(options, ['--body-kind', 'planner-cycle-result.v1'])).toEqual(['bk-type']);
  // An unrecognized but printable value is an honest empty page, never an error.
  expect(await read(options, ['--body-kind', 'no-such-kind'])).toEqual([]);
  // Matching is exact and case-sensitive.
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('keeps only work.result bodies reporting the --result outcome', async () => {
  const { options } = setup();
  const rows: Array<[string, unknown]> = [
    ['rs-complete', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r1', outcome: 'complete' }],
    ['rs-failed', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r2', outcome: 'failed' }],
    ['rs-admitted', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r3', outcome: 'admitted' }],
    // A work.result carrying no outcome names no provable outcome.
    ['rs-no-outcome', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r4' }],
    // A work.release body's own released/completed outcome is a different vocabulary.
    ['rs-release', { kind: 'work.release', jobId: 'RQ-JOB-A', claimKey: 'k', outcome: 'released' }],
    ['rs-release-done', { kind: 'work.release', jobId: 'RQ-JOB-A', claimKey: 'k', outcome: 'completed' }],
    ['rs-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    ['rs-note', { kind: 'note', text: 'failed is a word, not an outcome', outcome: 'failed' }],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--result', 'complete'])).toEqual(['rs-complete']);
  expect(await read(options, ['--result', 'failed'])).toEqual(['rs-failed']);
  expect(await read(options, ['--result', 'admitted'])).toEqual(['rs-admitted']);
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  // The note body's own outcome field is not a work.result receipt: --result
  // never matches it, with or without a body-kind filter narrowing the page.
  expect(await read(options, ['--result', 'failed', '--body-kind', 'note'])).toEqual([]);
  expect(await read(options, ['--result', 'failed', '--body-kind', 'work.result'])).toEqual(['rs-failed']);
});

it('composes --body-kind and --result with the other bus filters', async () => {
  const { options } = setup();
  post(options, 'cr-failed-a', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r1', outcome: 'failed' });
  post(options, 'cr-complete-a', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r2', outcome: 'complete' });
  post(options, 'cr-failed-b', { kind: 'work.result', jobId: 'RQ-JOB-B', claimKey: 'k', queueId: 'q', receiptId: 'r3', outcome: 'failed' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'cr-note', { kind: 'note', text: 'n' }, { from: 'agent:orion', priority: 'P0' });

  expect(await read(options, ['--result', 'failed', '--job', 'RQ-JOB-A'])).toEqual(['cr-failed-a']);
  expect(await read(options, ['--result', 'failed', '--from', 'agent:orion'])).toEqual(['cr-failed-b']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual(['cr-failed-b']);
  expect(await read(options, ['--body-kind', 'note', '--from', 'agent:orion'])).toEqual(['cr-note']);
  // A result filter and a body-kind filter compose conjunctively.
  expect(await read(options, ['--result', 'failed', '--body-kind', 'work.status'])).toEqual([]);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'wr-note', { kind: 'note', text: 'n' });
  post(options, 'wr-failed', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r1', outcome: 'failed' });
  post(options, 'wr-complete', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r2', outcome: 'complete' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.result', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['wr-failed']);
});

it('rejects invalid or duplicate --body-kind and --result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind', 'note', '--body-kind', 'task'], ['--body-kind=-inline'], ['--body-kind', '--to'],
      ['--result'], ['--result', 'bogus'], ['--result', 'COMPLETE'], ['--result', 'released'],
      ['--result', 'failed', '--result', 'complete'], ['--result=-inline'], ['--result', '--to']]) {
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
  post(options, 'ck-failed', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r1', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'failed'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.result', result: 'failed' }));

  // A different filter set is a different identity: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.result', '--result', 'complete'], options)).toBe(1);
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
