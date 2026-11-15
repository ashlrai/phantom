import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetWorkState } from '../src/cli/fleet-work-state.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(r => rm(r, { recursive: true, force: true })));
});

async function fixture(body: unknown) {
  const root = await mkdtemp(join(tmpdir(), 'work-state-'));
  roots.push(root);
  const file = join(root, 'evidence.json');
  await writeFile(file, typeof body === 'string' ? body : JSON.stringify(body));
  return { root, file };
}

const ITEMS = [
  { id: 'RQ-FAKE-1', receivedAt: '2026-11-12T22:29:00Z', owner: 'owner-a' },
  { id: 'RQ-FAKE-2', owner: 'owner-a', claimReceipt: 'claim-1', receivedAt: '2026-11-12T22:30:00Z' },
  { id: 'RQ-FAKE-3', verified: { tests: '2 passed', source: 'vitest', at: '2026-11-12T23:00:00Z' } },
];

it('is registered and prints one line per item', async () => {
  expect(resolveFleetSubcommand('work-state')).toEqual({ module: './fleet-work-state.js', exportName: 'cmdFleetWorkState' });
  const { root, file } = await fixture(ITEMS);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--evidence', file])).toBe(0);
  expect(log.mock.calls.map(c => c[0])).toEqual([
    'RQ-FAKE-1 RECEIVED as-of=2026-11-12T22:29:00Z source=receivedAt missing=durable claim receipt',
    'RQ-FAKE-2 ASSIGNED as-of=2026-11-12T22:30:00Z source=claim:claim-1 missing=none',
    'RQ-FAKE-3 VERIFIED as-of=2026-11-12T23:00:00Z source=vitest missing=none',
  ]);
  expect(await readdir(root)).toEqual(['evidence.json']); // read-only
});

it('--json prints structured results and accepts a single object', async () => {
  const { file } = await fixture(ITEMS[2]);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkState(['--evidence', file, '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual([{ id: 'RQ-FAKE-3', state: 'VERIFIED', asOf: '2026-11-12T23:00:00Z', source: 'vitest', missing: [] }]);
});

it('exits 2 on bad input', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetWorkState([])).toBe(2);
  expect(await cmdFleetWorkState(['--evidence', join(tmpdir(), 'no-such-work-state.json')])).toBe(2);
  expect(await cmdFleetWorkState(['--evidence', (await fixture('{nope')).file])).toBe(2);
  expect(await cmdFleetWorkState(['--evidence', (await fixture([{ id: 'RQ-FAKE-1', owner: 7 }])).file])).toBe(2);
  expect(await cmdFleetWorkState(['--evidence', (await fixture([{ owner: 'owner-a' }])).file])).toBe(2);
  expect(err.mock.calls.some(c => String(c[0]).includes('item 0: owner must be a string'))).toBe(true);
  expect(log).not.toHaveBeenCalled();
});
