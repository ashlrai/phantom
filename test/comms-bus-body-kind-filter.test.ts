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
    ['bk-post', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] }],
    ['bk-note', { kind: 'note', text: 'hi' }],
    ['bk-wake', { kind: 'wake', target: 'agent:nova', reason: 'r' }],
    ['bk-handoff', { kind: 'worker-handoff', taskId: 'RQ-A', prompt: 'take it' }],
    // A bus-transport v1 body cites its kind through protocol.kind, not a top-level kind.
    ['bk-protocol', { protocol: { version: 1, kind: 'task' }, payload: {} }],
    // A kindless notice keys on its type/schema discriminator.
    ['bk-type', { type: 'fleet-event', data: {} }],
    ['bk-schema', { schema: 'planner-cycle-result.v1', data: {} }],
    // A top-level kind wins over a protocol.kind on the same body.
    ['bk-both', { kind: 'note', text: 'x', protocol: { version: 1, kind: 'task' } }],
    // Bodies carrying no discriminator never match any --body-kind.
    ['bk-plain', { text: 'no kind' }],
    ['bk-string', 'just text'],
  ];
  for (const [id, body] of rows) expect(post(options, id, body).status).toBe('posted');

  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['bk-post']);
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['bk-note', 'bk-both']);
  expect(await read(options, ['--body-kind', 'wake'])).toEqual(['bk-wake']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['bk-handoff']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['bk-protocol']);
  expect(await read(options, ['--body-kind', 'fleet-event'])).toEqual(['bk-type']);
  expect(await read(options, ['--body-kind', 'planner-cycle-result.v1'])).toEqual(['bk-schema']);
  // A discriminator nothing carries reads empty; the unfiltered page sees all.
  expect(await read(options, ['--body-kind', 'absent-kind'])).toEqual([]);
  expect(await read(options, [])).toHaveLength(rows.length);
});

it('composes --body-kind with the address, priority and job filters', async () => {
  const { options } = setup();
  post(options, 'bc-a1', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] });
  post(options, 'bc-a2', { kind: 'work.post', jobId: 'RQ-B', title: 't', repo: 'o/n', claimKeys: [] }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'bc-b1', { kind: 'note', text: 'n' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'bc-a3', { kind: 'work.status', jobId: 'RQ-A', status: 'running' });

  expect(await read(options, ['--body-kind', 'work.post', '--from', 'agent:orion'])).toEqual(['bc-a2']);
  expect(await read(options, ['--body-kind', 'work.post', '--priority', 'P0'])).toEqual(['bc-a2']);
  expect(await read(options, ['--body-kind', 'work.post', '--to', 'leaders'])).toEqual(['bc-a1', 'bc-a2']);
  expect(await read(options, ['--body-kind', 'work.post', '--job', 'RQ-A'])).toEqual(['bc-a1']);
  // --kind stays the v1 protocol discriminator; --body-kind reaches the v2 field.
  expect(await read(options, ['--body-kind', 'work.post', '--kind', 'task'])).toEqual([]);
});

it('applies --body-kind to watch pages', async () => {
  const { options } = setup();
  post(options, 'bw-a', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] });
  post(options, 'bw-b', { kind: 'note', text: 'n' });
  post(options, 'bw-c', { kind: 'work.status', jobId: 'RQ-A', status: 'queued' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.post', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['bw-a']);
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
  post(options, 'bk-a', { kind: 'work.post', jobId: 'RQ-A', title: 't', repo: 'o/n', claimKeys: [] });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'work.post'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'work.post' }));

  // A different discriminator or a dropped --body-kind is a different filter set: fail closed.
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
