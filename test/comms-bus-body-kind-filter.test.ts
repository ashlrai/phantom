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
  const dir = mkdtempSync(join(tmpdir(), 'bus-body-kind-')); roots.push(dir);
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
    ['bk-note', { kind: 'note', text: 'hi' }],
    ['bk-context', { kind: 'context', text: 'ctx' }],
    ['bk-work-post', { kind: 'work.post', jobId: 'RQ-JOB-A', title: 't', repo: 'o/n', claimKeys: [] }],
    ['bk-work-status', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' }],
    ['bk-wake', { kind: 'wake', target: 'agent:nova', reason: 'r' }],
    ['bk-handoff', { kind: 'worker-handoff', taskId: 'RQ-JOB-A', prompt: 'take it' }],
    // A protocol-v1 transport body discriminates through protocol.kind;
    // its topic must equal the envelope --to, so it posts off the leaders sink.
    ['bk-proto', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, ref: 'r1' }, { to: 'fleet.deploy' }],
    // A kindless notice keys on its type/schema fields.
    ['bk-notice', { type: 'planner-cycle-result.v1', cycle: 3 }],
    ['bk-schema', { schema: 'guardian-drain.v1', drained: 2 }],
    // A bare kindless object and a string body carry no discriminator.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
    ['bk-null', null],
  ];
  for (const [id, body, extra] of rows) expect(post(options, id, body, extra).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['bk-work-post']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['bk-handoff']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-proto']);
  expect(await read(options, ['--body-kind', 'planner-cycle-result.v1'])).toEqual(['bk-notice']);
  expect(await read(options, ['--body-kind', 'guardian-drain.v1'])).toEqual(['bk-schema']);
  // The match is exact and case-sensitive: a case variant and an
  // unrecognized-but-printable value are honest empty pages, never errors.
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'never-seen'])).toEqual([]);
  // The unfiltered page still sees every row.
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('composes --body-kind with the other read filters', async () => {
  const { options } = setup();
  post(options, 'bc-a1', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' });
  post(options, 'bc-a2', { kind: 'note', text: 'n', thread: 'job:RQ-JOB-A' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'bc-b1', { kind: 'work.status', jobId: 'RQ-JOB-B', status: 'running' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'bc-a3', { kind: 'note', text: 'other thread', thread: 'other' });

  expect(await read(options, ['--body-kind', 'work.status', '--job', 'RQ-JOB-A'])).toEqual(['bc-a1']);
  expect(await read(options, ['--body-kind', 'note', '--from', 'agent:orion'])).toEqual(['bc-a2']);
  expect(await read(options, ['--body-kind', 'note', '--priority', 'P0'])).toEqual(['bc-a2']);
  expect(await read(options, ['--body-kind', 'note', '--to', 'leaders'])).toEqual(['bc-a2', 'bc-a3']);
  expect(await read(options, ['--body-kind', 'note', '--thread', 'job:RQ-JOB-A'])).toEqual(['bc-a2']);
  expect(await read(options, ['--body-kind', 'note', '--kind', 'task'])).toEqual([]);
});

it('applies --body-kind to watch pages', async () => {
  const { options } = setup();
  post(options, 'bw-a', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'queued' });
  post(options, 'bw-b', { kind: 'note', text: 'n' });
  post(options, 'bw-c', { kind: 'work.status', jobId: 'RQ-JOB-B', status: 'queued' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.status', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['bw-a', 'bw-c']);
});

it('rejects invalid or duplicate --body-kind values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)],
      ['--body-kind', 'note', '--body-kind', 'context'], ['--body-kind=-inline'], ['--body-kind', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'bc-a', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'queued' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.status'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.status' }));

  // A different kind or a dropped --body-kind is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'note'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --body-kind in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--body-kind <kind>');
});
