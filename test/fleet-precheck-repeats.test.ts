import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetPrecheckRepeats, fleetPrecheckRepeats } from '../src/cli/fleet-precheck-repeats.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
const now = new Date(2026, 10, 6, 12, 0, 0).getTime();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'precheck-repeats-'));
  await mkdir(join(root, 'queue'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });
it('counts the full window and finds repeats by latest time, independent of row order', async () => {
  await writeFile(join(root, 'queue/precheck-skips.tsv'), [
    '2026-11-06 11:00:00\tRQ-A\t13\tbusy',
    '2026-11-05 12:00:00\tRQ-A\t14\tblocked',
    '2026-11-06 10:00:00\tRQ-B\t13\tbusy',
    '2026-11-05 11:59:59\tRQ-A\t13\tbusy',
    '2026-11-06 12:00:01\tRQ-A\t13\tbusy',
    'invalid\tRQ-A\t13\tbusy',
    '2026-11-06 09:00:00\tRQ-A\t13\t/path',
  ].join('\n'));
  const report = await fleetPrecheckRepeats(24, now);
  expect(report).toMatchObject({ source: 'healthy', total: 3, malformed: 2,
    byCode: [{ name: '13', count: 2 }, { name: '14', count: 1 }],
    byReason: [{ name: 'busy', count: 2 }, { name: 'blocked', count: 1 }],
    repeats: [{ id: 'RQ-A', count: 2, lastTime: '2026-11-06 11:00:00' }] });
  expect((await fleetPrecheckRepeats(1, now)).total).toBe(1);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['precheck-repeats']!()).cmdFleetPrecheckRepeats).toBe('function');
});
it('exposes text and JSON, scrubs secrets, and rejects invalid options', async () => {
  vi.setSystemTime(now);
  await writeFile(join(root, 'queue/precheck-skips.tsv'), '2026-11-06 11:00:00\tRQ-A\t13\tpassword=fake-secret-value\n2026-11-06 11:30:00\tRQ-A\t13\tbusy\n');
  expect(await cmdFleetPrecheckRepeats(['--json'])).toBe(0);
  const output = vi.mocked(console.log).mock.lastCall![0] as string;
  expect(output).not.toContain('fake-secret-value');
  expect(JSON.parse(output).repeats[0].count).toBe(2);
  expect(await cmdFleetPrecheckRepeats([])).toBe(0);
  expect(console.log).toHaveBeenLastCalledWith(expect.stringContaining('RQ-A: 2, last'));
  for (const args of [['--hours'], ['--hours', '0'], ['--hours', 'Infinity'], ['--json', '--json'], ['--bad']]) expect(await cmdFleetPrecheckRepeats(args)).toBe(2);
  expect(await cmdFleetPrecheckRepeats(['--help'])).toBe(0);
  vi.useRealTimers();
});
it('reports missing and unsafe sources as unknown, not zero', async () => {
  expect(await cmdFleetPrecheckRepeats(['--json'])).toBe(1);
  expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0] as string)).toMatchObject({ source: 'missing', total: null });
  await symlink(join(root, 'other'), join(root, 'queue/precheck-skips.tsv'));
  expect((await fleetPrecheckRepeats()).source).toBe('degraded');
});
