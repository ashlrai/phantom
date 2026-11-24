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
  const dir = mkdtempSync(join(tmpdir(), 'bus-since-filter-')); roots.push(dir);
  return { dir, options: { root: join(dir, 'store'), now: () => now } satisfies BusInboxOptions };
}

/** Post one envelope whose receipt carries `at` as its receivedAt. */
function postAt(options: BusInboxOptions, at: number, id: string, body: unknown = { text: 'x' }, extra: Record<string, unknown> = {}) {
  return appendBusInbox({ id, from: 'agent:atlas', to: 'leaders', priority: 'P2', ttl: 3_600_000, body, ...extra },
    { ...options, now: () => at });
}

async function read(options: BusInboxOptions, args: string[]): Promise<string[]> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', ...args], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  return page.messages.map((row: { envelope: { id: string } }) => row.envelope.id);
}

it('keeps only rows received at or after an epoch-ms cutoff, boundary inclusive', async () => {
  const { options } = setup(5000);
  postAt(options, 1000, 's-old');
  postAt(options, 2000, 's-edge');
  postAt(options, 3000, 's-new');

  expect(await read(options, ['--since', '2000'])).toEqual(['s-edge', 's-new']);
  expect(await read(options, ['--since', '2001'])).toEqual(['s-new']);
  expect(await read(options, ['--since', '4000'])).toEqual([]);
  expect(await read(options, [])).toEqual(['s-old', 's-edge', 's-new']);
});

it('resolves relative and ISO --since values against the store clock', async () => {
  // now = 1_000_000; 15m back is exactly 100_000.
  const { options } = setup(1_000_000);
  postAt(options, 50_000, 's-ancient');
  postAt(options, 100_000, 's-edge');
  postAt(options, 200_000, 's-mid');
  postAt(options, 999_000, 's-fresh');

  expect(await read(options, ['--since', '15m'])).toEqual(['s-edge', 's-mid', 's-fresh']);
  expect(await read(options, ['--since', '16m'])).toEqual(['s-ancient', 's-edge', 's-mid', 's-fresh']);
  // 1970-01-01T00:02:30.000Z is epoch 150000: keeps s-mid and s-fresh.
  expect(await read(options, ['--since', '1970-01-01T00:02:30.000Z'])).toEqual(['s-mid', 's-fresh']);
});

it('composes --since with the address, priority and job filters', async () => {
  const { options } = setup(5000);
  postAt(options, 1000, 'sc-old', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' });
  postAt(options, 3000, 'sc-new-a', { kind: 'work.status', jobId: 'RQ-JOB-A', status: 'running' });
  postAt(options, 3000, 'sc-new-b', { kind: 'work.status', jobId: 'RQ-JOB-B', status: 'running' }, { from: 'agent:orion', priority: 'P0' });
  postAt(options, 3000, 'sc-new-c', { kind: 'note', text: 'n', thread: 'job:RQ-JOB-A' });

  expect(await read(options, ['--since', '2000', '--job', 'RQ-JOB-A'])).toEqual(['sc-new-a', 'sc-new-c']);
  expect(await read(options, ['--since', '2000', '--from', 'agent:orion'])).toEqual(['sc-new-b']);
  expect(await read(options, ['--since', '2000', '--priority', 'P0'])).toEqual(['sc-new-b']);
});

it('applies --since to watch pages', async () => {
  const { options } = setup(5000);
  postAt(options, 1000, 'sw-old');
  postAt(options, 3000, 'sw-new');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--since', '2000', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['sw-new']);
});

it('rejects invalid or duplicate --since values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--since'], ['--since', 'bogus'], ['--since', '1.5h'], ['--since', '2026-13-45'],
      ['--since', '-5'], ['--since', '15m', '--since', '2h'], ['--since=-inline'], ['--since', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--since', '15m'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --since into checkpoint filter identity', async () => {
  const { dir, options } = setup(5000);
  postAt(options, 3000, 'sc-a');
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--since', '2000'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ since: '2000' }));

  // A different --since or a dropped --since is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--since', '3000'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --since in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--since <15m|2h|1d|ISO>');
});
