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
  const dir = mkdtempSync(join(tmpdir(), 'bus-before-filter-')); roots.push(dir);
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

it('keeps only rows received strictly before an epoch-ms cutoff, boundary exclusive', async () => {
  const { options } = setup(5000);
  postAt(options, 1000, 'b-old');
  postAt(options, 2000, 'b-edge');
  postAt(options, 3000, 'b-new');

  expect(await read(options, ['--before', '2000'])).toEqual(['b-old']);
  expect(await read(options, ['--before', '2001'])).toEqual(['b-old', 'b-edge']);
  expect(await read(options, ['--before', '1000'])).toEqual([]);
  expect(await read(options, [])).toEqual(['b-old', 'b-edge', 'b-new']);
});

it('resolves relative and ISO --before values against the store clock', async () => {
  // now = 1_000_000; 15m back is exactly 100_000, 14m back is 160_000.
  const { options } = setup(1_000_000);
  postAt(options, 50_000, 'b-ancient');
  postAt(options, 100_000, 'b-edge');
  postAt(options, 200_000, 'b-mid');
  postAt(options, 999_000, 'b-fresh');

  // before 15m = 100_000 exclusive: b-edge sits exactly on the bound and drops.
  expect(await read(options, ['--before', '15m'])).toEqual(['b-ancient']);
  expect(await read(options, ['--before', '14m'])).toEqual(['b-ancient', 'b-edge']);
  // 1970-01-01T00:02:30.000Z is epoch 150000: keeps b-ancient and b-edge.
  expect(await read(options, ['--before', '1970-01-01T00:02:30.000Z'])).toEqual(['b-ancient', 'b-edge']);
});

it('composes --since and --before into one [since, before) window', async () => {
  const { options } = setup(5000);
  postAt(options, 1000, 'w-old');
  postAt(options, 2000, 'w-lo');
  postAt(options, 3000, 'w-hi');
  postAt(options, 4000, 'w-new');

  // Both bounds are exclusive of the other side's edge: since is inclusive,
  // before is exclusive, so [2000, 3000) keeps only w-lo.
  expect(await read(options, ['--since', '2000', '--before', '3000'])).toEqual(['w-lo']);
  expect(await read(options, ['--since', '1000', '--before', '4000'])).toEqual(['w-old', 'w-lo', 'w-hi']);
  // An inverted or empty window is an honest empty page, never invalid.
  expect(await read(options, ['--since', '3000', '--before', '2000'])).toEqual([]);
  expect(await read(options, ['--since', '2000', '--before', '2000'])).toEqual([]);
});

it('applies --before to watch pages', async () => {
  const { options } = setup(5000);
  postAt(options, 1000, 'bw-old');
  postAt(options, 3000, 'bw-new');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['watch', '--before', '2000', '--max-pages', '1'], options)).toBe(0);
  const page = JSON.parse(String(log.mock.calls.at(-1)?.[0]));
  expect(page.messages.map((row: { envelope: { id: string } }) => row.envelope.id)).toEqual(['bw-old']);
});

it('rejects invalid or duplicate --before values before reading', async () => {
  const { options } = setup();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const list = vi.spyOn(inbox, 'listBusInboxAfter');
  for (const verb of ['read', 'watch']) {
    for (const args of [['--before'], ['--before', 'bogus'], ['--before', '1.5h'], ['--before', '2026-13-45'],
      ['--before', '-5'], ['--before', '9999999999999999'], ['--before', '15m', '--before', '2h'],
      ['--before=-inline'], ['--before', '--to']]) {
      expect(await cmdCommsBus([verb, ...args], options, { list })).toBe(2);
      expect(log.mock.calls.at(-1)?.[0]).toBe('{"status":"invalid"}');
    }
  }
  expect(await cmdCommsBus(['post', '--file', 'unused', '--before', '15m'])).toBe(2);
  expect(list).not.toHaveBeenCalled();
});

it('binds --before into checkpoint filter identity', async () => {
  const { dir, options } = setup(5000);
  postAt(options, 1000, 'bc-a');
  postAt(options, 3000, 'bc-b');
  const checkpoint = join(dir, 'checkpoint.json');
  const state = () => JSON.parse(readFileSync(checkpoint, 'utf8')) as { filters: string };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--before', '2000'], options)).toBe(0);
  expect(state().filters).toBe(JSON.stringify({ before: '2000' }));

  // A different --before or a dropped --before is a different filter set: fail closed.
  const errors: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { errors.push(parts.join(' ')); });
  try {
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint, '--before', '3000'], options)).toBe(1);
    expect(await cmdCommsBus(['read', '--checkpoint', checkpoint], options)).toBe(1);
  } finally { spy.mockRestore(); }
  expect(errors.join('\n')).toContain('checkpoint filter mismatch');
});

it('advertises --before in bus help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdCommsBus(['--help'])).toBe(0);
  expect(String(log.mock.calls.at(-1)?.[0])).toContain('--before <15m|2h|1d|ISO>');
});
