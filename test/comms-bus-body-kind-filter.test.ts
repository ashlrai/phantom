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

function setup(now = 100) {
  const dir = mkdtempSync(join(tmpdir(), 'bus-body-kind-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

function post(options: BusInboxOptions, id: string, body: unknown, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only envelopes whose body carries the exact kind discriminator', async () => {
  const { options } = setup();
  post(options, 'k-note', { kind: 'note', text: 'plain note' });
  post(options, 'k-context', { kind: 'context', text: 'shared context' });
  post(options, 'k-post', { kind: 'work.post', jobId: 'RQ-1', title: 'ship it', repo: 'o/r', claimKeys: ['queue:RQ-1'] });
  post(options, 'k-status', { kind: 'work.status', jobId: 'RQ-1', status: 'running' });
  post(options, 'k-handoff', { kind: 'worker-handoff', taskId: 'RQ-1', prompt: 'do it' });
  post(options, 'k-task', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' } }, { to: 'fleet.deploy' });
  post(options, 'k-type', { type: 'fleet-event', detail: 'x' });
  post(options, 'k-kindless', { inReplyTo: 'k-note', text: 'ack' });
  post(options, 'k-plain', { text: 'no discriminator at all' });

  // Every discriminator source matches its own exact kind, case-sensitively.
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['k-note']);
  expect(await read(options, ['--body-kind', 'context'])).toEqual(['k-context']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['k-post']);
  expect(await read(options, ['--body-kind', 'work.status'])).toEqual(['k-status']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['k-handoff']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['k-task']);
  expect(await read(options, ['--body-kind', 'fleet-event'])).toEqual(['k-type']);
  // Bodies carrying no discriminator never match; case is exact.
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'work.claim'])).toEqual([]);
  // An unrecognized but printable value is an honest empty match, never invalid.
  expect(await read(options, ['--body-kind', 'no-such-kind'])).toEqual([]);
});

it('composes --body-kind with the other read filters', async () => {
  const { options } = setup();
  post(options, 'x-hit', { kind: 'work.status', jobId: 'RQ-9', status: 'running' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-kind', { kind: 'note', text: 'alpha' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-from', { kind: 'work.status', jobId: 'RQ-9', status: 'running' }, { from: 'agent:atlas', priority: 'P0' });
  post(options, 'x-miss-priority', { kind: 'work.status', jobId: 'RQ-9', status: 'running' }, { from: 'agent:orion', priority: 'P3' });

  expect(await read(options, ['--body-kind', 'work.status', '--from', 'agent:orion'])).toEqual(['x-hit', 'x-miss-priority']);
  expect(await read(options, ['--body-kind', 'work.status', '--priority', 'P0'])).toEqual(['x-hit', 'x-miss-from']);
  expect(await read(options, ['--body-kind', 'note', '--contains', 'alpha'])).toEqual(['x-miss-kind']);
});

it('applies --body-kind to watch pages', async () => {
  const { options } = setup();
  post(options, 'w-hit', { kind: 'work.status', jobId: 'RQ-2', status: 'running' });
  post(options, 'w-miss', { kind: 'note', text: 'chatter' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--body-kind', 'work.status', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-hit']);
});

it('rejects invalid or duplicate --body-kind values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', ''], ['--body-kind', 'has space'],
      ['--body-kind', 'x'.repeat(129)], ['--body-kind', 'work.post', '--body-kind', 'note'],
      ['--body-kind', '--to'], ['--body-kind=-inline']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--body-kind', 'note'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --body-kind into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'bk-a', { kind: 'note', text: 'one' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'note'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ bodyKind: 'note' }));

  // A different --body-kind or a dropped --body-kind is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--body-kind', 'context'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --body-kind in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--body-kind <kind>');
});
