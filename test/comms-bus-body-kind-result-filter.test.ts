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
  const dir = mkdtempSync(join(tmpdir(), 'bus-kind-result-filter-')); roots.push(dir);
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

it('keeps only bodies carrying the exact kind discriminator across every kind source', async () => {
  const { options } = setup();
  post(options, 'k-note', { kind: 'note', text: 'hi' });
  post(options, 'k-work', { kind: 'work.post', jobId: 'RQ-1', title: 'claim' });
  post(options, 'k-v1', { protocol: { version: 1, kind: 'task', topic: 'fleet.deploy' }, ref: 'r1' }, { to: 'fleet.deploy' });
  post(options, 'k-typed', { type: 'fleet.status', detail: 'ok' });
  post(options, 'k-kindless', { fake: 'nothing here' });

  expect(await read(options, ['--body-kind', 'note'])).toEqual(['k-note']);
  expect(await read(options, ['--body-kind', 'work.post'])).toEqual(['k-work']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['k-v1']);
  expect(await read(options, ['--body-kind', 'fleet.status'])).toEqual(['k-typed']);
  // Exact and case-sensitive: a near-miss and a discriminator-less body are honest empty pages.
  expect(await read(options, ['--body-kind', 'Note'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'nonexistent'])).toEqual([]);
});

it('keeps only work.result bodies reporting that outcome; every other kind never matches', async () => {
  const { options } = setup();
  post(options, 'r-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed', reason: 'tests red' });
  post(options, 'r-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete', reason: 'merged' });
  post(options, 'r-nooutcome', { kind: 'work.result', jobId: 'RQ-2' });
  // The work.release body deliberately carries a work.result-vocabulary
  // outcome: the kind-scoped match must still refuse it.
  post(options, 'r-release', { kind: 'work.release', jobId: 'RQ-1', outcome: 'failed' });
  post(options, 'r-status', { kind: 'work.status', jobId: 'RQ-1', status: 'running' });
  post(options, 'r-note', { kind: 'note', text: 'failed anyway' });

  expect(await read(options, ['--result', 'failed'])).toEqual(['r-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['r-complete']);
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('composes --body-kind and --result with the other read filters', async () => {
  const { options } = setup(5000);
  post(options, 'x-hit', { kind: 'work.result', jobId: 'RQ-9', outcome: 'failed' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-from', { kind: 'work.result', jobId: 'RQ-9', outcome: 'failed' }, { from: 'agent:atlas' });
  post(options, 'x-miss-kind', { kind: 'note', text: 'failed', thread: 'job:RQ-9' }, { from: 'agent:orion', priority: 'P0' });
  post(options, 'x-miss-outcome', { kind: 'work.result', jobId: 'RQ-9', outcome: 'complete' }, { from: 'agent:orion', priority: 'P0' });

  expect(await read(options, ['--result', 'failed', '--from', 'agent:orion'])).toEqual(['x-hit']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual(['x-hit']);
  expect(await read(options, ['--body-kind', 'work.result', '--job', 'RQ-9'])).toEqual(['x-hit', 'x-miss-from', 'x-miss-outcome']);
  expect(await read(options, ['--body-kind', 'note', '--thread', 'job:RQ-9'])).toEqual(['x-miss-kind']);
  expect(await read(options, ['--result', 'failed', '--body-kind', 'work.result', '--contains', 'failed'])).toEqual(['x-hit', 'x-miss-from']);
});

it('applies --body-kind and --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'w-hit', { kind: 'work.result', jobId: 'RQ-3', outcome: 'complete' });
  post(options, 'w-miss', { kind: 'work.result', jobId: 'RQ-3', outcome: 'failed' });
  post(options, 'w-note', { kind: 'note', text: 'work.result mentioned' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--result', 'complete', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-hit']);
});

it('rejects invalid or duplicate --body-kind/--result values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--body-kind'], ['--body-kind', ''], ['--body-kind', 'has space'],
      ['--body-kind', 'x'.repeat(129)], ['--body-kind', 'note', '--body-kind', 'context'],
      ['--body-kind=note'], ['--body-kind', '--to'], ['--result'], ['--result', ''], ['--result', 'bogus'],
      ['--result', 'FAILED'], ['--result', 'complete', '--result', 'failed'], ['--result=failed'], ['--result', '--to']]) {
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
  post(options, 'k-a', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ result: 'failed' }));

  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'complete'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
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
