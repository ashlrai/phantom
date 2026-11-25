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
  const dir = mkdtempSync(join(tmpdir(), 'bus-result-filter-')); roots.push(dir);
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

it('keeps only work.result bodies reporting the requested outcome', async () => {
  const { options } = setup();
  post(options, 'r-failed', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed', reason: 'tests-red' });
  post(options, 'r-complete', { kind: 'work.result', jobId: 'RQ-1', outcome: 'complete' });
  post(options, 'r-admitted', { kind: 'work.result', jobId: 'RQ-2', outcome: 'admitted' });
  post(options, 'r-reserved', { kind: 'work.result', jobId: 'RQ-2', outcome: 'reserved' });
  // A work.result carrying no outcome reports null and never matches.
  post(options, 'r-bare', { kind: 'work.result', jobId: 'RQ-3' });
  // A work.release body's own released/completed vocabulary is a different
  // outcome space and never matches, even spelling 'completed' close to 'complete'.
  post(options, 'rel-released', { kind: 'work.release', outcome: 'released' });
  post(options, 'rel-completed', { kind: 'work.release', outcome: 'completed' });
  // Every other body kind never matches, even one carrying an outcome field.
  post(options, 'note', { kind: 'note', text: 'the deploy failed again', outcome: 'failed' });
  post(options, 'status', { kind: 'work.status', jobId: 'RQ-1', status: 'done', outcome: 'failed' });
  post(options, 'proto', { protocol: { version: 1, kind: 'result' }, outcome: 'failed' });
  post(options, 'plain', { fake: 'body' });

  expect(await read(options, ['--result', 'failed'])).toEqual(['r-failed']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['r-complete']);
  expect(await read(options, ['--result', 'admitted'])).toEqual(['r-admitted']);
  expect(await read(options, ['--result', 'reserved'])).toEqual(['r-reserved']);
});

it('rejects outcome values outside WORK_RESULT_OUTCOMES before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--result'], ['--result', ''], ['--result', 'bogus'],
      ['--result', 'released'], ['--result', 'completed'], ['--result', 'FAILED'],
      ['--result', 'failed', '--result', 'complete'], ['--result', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(list).not.toHaveBeenCalled();
});

it('applies --result to watch pages', async () => {
  const { options } = setup();
  post(options, 'w-failed', { kind: 'work.result', jobId: 'RQ-9', outcome: 'failed' });
  post(options, 'w-complete', { kind: 'work.result', jobId: 'RQ-9', outcome: 'complete' });
  post(options, 'w-note', { kind: 'note', text: 'unrelated' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--result', 'failed', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['w-failed']);
});

it('composes --result with the other read filters', async () => {
  const { options } = setup(5000);
  post(options, 'c-fail-p0', { kind: 'work.result', jobId: 'RQ-J-1', outcome: 'failed' }, { priority: 'P0' });
  post(options, 'c-fail-p2', { kind: 'work.result', jobId: 'RQ-J-1', outcome: 'failed' }, { priority: 'P2' });
  post(options, 'c-done-p0', { kind: 'work.result', jobId: 'RQ-J-1', outcome: 'complete' }, { priority: 'P0' });

  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual(['c-fail-p0']);
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-J-1'])).toEqual(['c-fail-p0', 'c-fail-p2']);
  expect(await read(options, ['--result', 'failed', '--job', 'RQ-OTHER'])).toEqual([]);
  expect(await read(options, ['--result', 'complete', '--id', 'c-done-p0'])).toEqual(['c-done-p0']);
});

it('binds --result into checkpoint filter identity', async () => {
  const { dir, options } = setup();
  post(options, 'k-fail', { kind: 'work.result', jobId: 'RQ-1', outcome: 'failed' });
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ result: 'failed' }));

  // A different --result or a dropped --result is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'complete'], options)).toBe(1);
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  expect(errors.some(line => line.includes('checkpoint filter mismatch'))).toBe(true);
  spy.mockRestore();
});
