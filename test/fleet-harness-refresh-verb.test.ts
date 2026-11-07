import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetHarnessRefresh } from '../src/cli/fleet-harness-refresh.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const dirs: string[] = [];
const now = () => new Date('2026-11-03T12:00:00Z');
function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-refresh-'));
  dirs.push(dir);
  const file = join(dir, 'digest.md');
  writeFileSync(file, [
    '## S2 — Stale harness', '- Checked: 2026-10-24.', '- Source: [source](https://example.invalid/stale)',
    '## S1 — Repair harness', '- Source: [source](https://example.invalid/repair)',
    '## S3 — Fresh harness', '- Checked: 2026-11-02.', '- Source: [source](https://example.invalid/fresh)',
  ].join('\n'));
  return file;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

it('lists repair before stale and omits fresh sources', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetHarnessRefresh([], { now, digestFile: fixture() })).toBe(0);
  expect(log.mock.calls.map(call => call[0])).toEqual([
    'Harness refresh: 2 of 3 sources due',
    'repair S1 — Repair harness (checked never) https://example.invalid/repair',
    'stale S2 — Stale harness (checked 2026-10-24) https://example.invalid/stale',
  ]);
});
it('limits JSON to the first repair with the exact public shape and file override', async () => {
  const file = fixture();
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetHarnessRefresh(['--file', file, '--limit', '1', '--json'], { now, digestFile: '/unused' })).toBe(0);
  expect(JSON.parse(log.mock.lastCall![0] as string)).toEqual({
    state: 'ok', file,
    queue: [{ id: 'S1', title: 'Repair harness', urls: ['https://example.invalid/repair'], checkedAt: null, reason: 'repair' }],
  });
});
it('handles missing and unreadable digests in both modes', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const file = join(fixture(), 'missing');
  expect(await cmdFleetHarnessRefresh(['--file', file], { now })).toBe(0);
  expect(log).toHaveBeenLastCalledWith(`No harness digest at ${file}.`);
  expect(await cmdFleetHarnessRefresh(['--file', file, '--json'], { now })).toBe(0);
  expect(JSON.parse(log.mock.lastCall![0] as string)).toEqual({ state: 'missing', queue: [] });
});
it('reports an empty queue', async () => {
  const file = fixture();
  writeFileSync(file, '## S1 — Fresh\n- Checked: 2026-11-03.\n- Source: [source](https://example.invalid/harness)');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetHarnessRefresh([], { now, digestFile: file })).toBe(0);
  expect(log).toHaveBeenLastCalledWith('Harness refresh: nothing due');
});
it('rejects invalid arguments and supports help', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  for (const args of [['--limit', '0'], ['--limit', 'x'], ['--limit', '51'], ['--limit', '1.5'], ['--limit'], ['--file'], ['--json', '--json'], ['--unknown'], ['--limit', '1', '--limit', '2']]) {
    expect(await cmdFleetHarnessRefresh(args)).toBe(2);
    expect(error.mock.lastCall![0]).toContain('Usage:');
  }
  expect(await cmdFleetHarnessRefresh(['--help'])).toBe(0);
  expect(log.mock.lastCall![0]).toContain('Usage:');
});
it('registers the harness-refresh loader', async () => {
  expect((await FLEET_SUBCOMMAND_LOADERS['harness-refresh']!()).cmdFleetHarnessRefresh).toBe(cmdFleetHarnessRefresh);
});
