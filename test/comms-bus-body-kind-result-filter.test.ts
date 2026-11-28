import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdCommsBus } from '../src/cli/comms-bus.js';
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
  return appendBusInbox({ id, from: 'agent:atlas', to: 'worker-a', priority: 'P2', ttl: 3_600_000, body, ...extra }, options);
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only bodies carrying the exact kind discriminator', async () => {
  const { options } = setup();
  post(options, 'v2-note', { kind: 'note', text: 'hi' });
  post(options, 'v2-result', { kind: 'work.result', jobId: 'job-1', outcome: 'failed' });
  post(options, 'handoff', { kind: 'worker-handoff', taskId: 'job-2', prompt: 'do it' });
  post(options, 'proto-task', { protocol: { version: 1, kind: 'task' } });
  post(options, 'notice', { type: 'channel-health' });
  post(options, 'plain', { text: 'no discriminator' });
  post(options, 'nil', null);

  expect(await read(options, ['--body-kind', 'work.result'])).toEqual(['v2-result']);
  expect(await read(options, ['--body-kind', 'worker-handoff'])).toEqual(['handoff']);
  expect(await read(options, ['--body-kind', 'task'])).toEqual(['proto-task']);
  expect(await read(options, ['--body-kind', 'channel-health'])).toEqual(['notice']);
  expect(await read(options, ['--body-kind', 'note'])).toEqual(['v2-note']);
  // Case-sensitive and honest-empty: no widening on case or unknown kinds.
  expect(await read(options, ['--body-kind', 'NOTE'])).toEqual([]);
  expect(await read(options, ['--body-kind', 'unrecognized-kind'])).toEqual([]);
});

it('keeps only work.result bodies reporting the outcome, kind-scoped', async () => {
  const { options } = setup();
  post(options, 'failed-1', { kind: 'work.result', jobId: 'job-1', outcome: 'failed' });
  post(options, 'failed-2', { kind: 'work.result', jobId: 'job-2', outcome: 'failed' });
  post(options, 'complete-1', { kind: 'work.result', jobId: 'job-1', outcome: 'complete' });
  post(options, 'bare-result', { kind: 'work.result', jobId: 'job-3' });
  post(options, 'release', { kind: 'work.release', claimKey: 'repo:o/r', token: 't', outcome: 'released' });
  post(options, 'note-outcome', { kind: 'note', outcome: 'failed' });

  expect(await read(options, ['--result', 'failed'])).toEqual(['failed-1', 'failed-2']);
  expect(await read(options, ['--result', 'complete'])).toEqual(['complete-1']);
  expect(await read(options, ['--result', 'reserved'])).toEqual([]);
  // A work.release outcome is a different vocabulary; a note's outcome field is not a result.
  expect(await read(options, ['--result', 'admitted'])).toEqual([]);
});

it('composes --body-kind and --result with the other read filters', async () => {
  const { options } = setup();
  post(options, 'room-failed', { kind: 'work.result', jobId: 'job-1', outcome: 'failed' }, { to: 'group:eng:alerts' });
  post(options, 'room-complete', { kind: 'work.result', jobId: 'job-1', outcome: 'complete' }, { to: 'group:eng:alerts' });
  post(options, 'direct-failed', { kind: 'work.result', jobId: 'job-1', outcome: 'failed' });
  post(options, 'room-note', { kind: 'note', text: 'x' }, { to: 'group:eng:alerts' });

  expect(await read(options, ['--channel', 'eng', '--body-kind', 'work.result', '--result', 'failed']))
    .toEqual(['room-failed']);
  expect(await read(options, ['--body-kind', 'work.result', '--result', 'failed', '--to', 'worker-a']))
    .toEqual(['direct-failed']);
  expect(await read(options, ['--result', 'failed', '--priority', 'P0'])).toEqual([]);
});

it('watch applies the same body-kind and result filters', async () => {
  const { options } = setup();
  post(options, 'failed-1', { kind: 'work.result', jobId: 'job-1', outcome: 'failed' });
  post(options, 'note-1', { kind: 'note', text: 'x' });
  const emitted: string[] = [];
  const deps = { emit: (json: string) => { emitted.push(json); } };

  expect(await cmdCommsBus(['watch', '--max-pages', '1', '--body-kind', 'work.result', '--result', 'failed'], options, deps)).toBe(0);
  const page = JSON.parse(emitted.at(-1)!);
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['failed-1']);
});

it('rejects invalid --body-kind and --result before reading the store', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const args of [
    ['--body-kind', 'has space'], ['--body-kind', 'x'.repeat(129)], ['--body-kind', ''],
    ['--result', 'bogus'], ['--result', 'FAILED'], ['--result', ''],
  ]) {
    expect(await cmdCommsBus(['read', ...args], options)).toBe(2);
    expect(await cmdCommsBus(['watch', ...args, '--max-pages', '1'], options)).toBe(2);
  }
  expect(log.mock.calls.at(-1)?.[0]).toBe(JSON.stringify({ status: 'invalid' }));
});

it('binds --body-kind and --result into the checkpoint filter identity', async () => {
  const { dir, options } = setup();
  const checkpoint = join(dir, 'checkpoint.json');
  post(options, 'failed-1', { kind: 'work.result', jobId: 'job-1', outcome: 'failed' });
  post(options, 'note-1', { kind: 'note', text: 'x' });
  const emitted: string[] = [];
  const deps = { emit: (json: string) => { emitted.push(json); } };
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});

  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options, deps)).toBe(0);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8')).scanCursor).toBe(2);
  expect(emitted.at(-1)).toContain('failed-1');
  expect(emitted.at(-1)).not.toContain('note-1');

  // A checkpoint saved under one outcome refuses to resume under another or none.
  for (const args of [[], ['--result', 'complete'], ['--body-kind', 'note']]) {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, ...args], options, deps)).toBe(1);
    expect(String(error.mock.calls.at(-1))).toContain('filter mismatch');
  }
  // The same filters resume cleanly.
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--result', 'failed'], options, deps)).toBe(0);
});
