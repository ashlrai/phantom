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
  const rows: Array<[string, unknown]> = [
    ['bk-note', { kind: 'note', text: 'hi' }],
    ['bk-context', { kind: 'context', text: 'ctx' }],
    ['bk-post', { kind: 'work.post', jobId: 'RQ-JOB-A', title: 't', repo: 'o/n', claimKeys: [] }],
    ['bk-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    ['bk-result', { kind: 'work.result', jobId: 'RQ-JOB-A', claimKey: 'k', queueId: 'q', receiptId: 'r', outcome: 'complete' }],
    ['bk-claim', { kind: 'work.claim', op: 'acquire', claimKey: 'repo:o/n', owner: 'a', leaseMs: 1000 }],
    ['bk-release', { kind: 'work.release', claimKey: 'repo:o/n', token: 'a'.repeat(64), outcome: 'released' }],
    ['bk-wake', { kind: 'wake', target: 'agent:nova', reason: 'r' }],
    ['bk-handoff', { kind: 'worker-handoff', taskId: 'RQ-JOB-A', prompt: 'take it' }],
    // A protocol-v1 body reports its protocol.kind as the discriminator.
    ['bk-v1', { protocol: { version: 1, kind: 'task', payload_ref: 'payload-1' } }],
    // A notice body reports its type/schema discriminator.
    ['bk-notice', { type: 'group.presence', member: 'a' }],
    // A body carrying no discriminator never matches.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['bk-post']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['bk-status']);
  expect(await read(options, ['--body-kind', 'work.claim'])).toEqual(['bk-claim']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['bk-handoff']);
  expect(await read(options, ['--body-kind', 'wake'])).toEqual(['bk-wake']);
  // The v1 protocol kind and notice discriminators are reachable too.
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-v1']);
  expect(await read(options, ['--body-kind', 'group.presence'])).toEqual(['bk-notice']);
  // Exact and case-sensitive: a case variant and an unknown kind match nothing.
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'nonexistent'])).toEqual([]);
  // The unfiltered page still sees every row.
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('composes --body-kind with the other filters', async () => {
  const { options } = setup();
  post(options, 'bc-note-a', { kind: 'note', text: 'n' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'bc-note-b', { kind: 'note', text: 'n' }, { from: 'agent:nova' });
  post(options, 'bc-post-a', { kind: 'work.post', jobId: 'RQ-JOB-A', title: 't', repo: 'o/n', claimKeys: [] }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'bc-status-a', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }, { from: 'agent:orion', priority: 'P0' });

  expect(await read(options, ['--body-kind', 'note', '--from', 'agent:orion'])).toEqual(['bc-note-a']);
  expect(await read(options, ['--body-kind', 'note', '--priority', 'P0'])).toEqual(['bc-note-a']);
  expect(await read(options, ['--body-kind', 'work.post', '--job', 'RQ-JOB-A'])).toEqual(['bc-post-a']);
  expect(await read(options, ['--body-kind', 'work.status', '--job', 'RQ-JOB-A'])).toEqual(['bc-status-a']);
  // --kind keeps its protocol-v1 meaning beside --body-kind.
  expect(await read(options, ['--body-kind', 'note', '--kind', 'task'])).toEqual([]);
});

it('applies --body-kind to watch pages', async () => {
  const { options } = setup();
  post(options, 'bw-note', { kind: 'note', text: 'n' });
  post(options, 'bw-post', { kind: 'work.post', jobId: 'RQ-JOB-A', title: 't', repo: 'o/n', claimKeys: [] });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.post', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['bw-post']);
});

it('rejects invalid or duplicate --body-kind values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind', 'note', '--body-kind', 'wake'], ['--body-kind=-inline'], ['--body-kind', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'bc-a', { kind: 'note', text: 'n' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'note'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'note' }));

  // A different kind or a dropped --body-kind is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'wake'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --body-kind in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--body-kind <kind>');
});
