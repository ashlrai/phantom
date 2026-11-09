import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSkipReasons, summarizeSkipReasons } from '../src/cli/fleet-skip-reasons.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date(2026, 10, 2, 12).getTime();
const row = (time: string, id = 'RQ-A', action = 'defer', reason = 'waiting') => `2026-11-02 ${time}\t${id}\t${action}\t${reason}`;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('fleet skip-reasons', () => {
  it('counts events within the inclusive local-time window and marks exact ready IDs', () => {
    const skips = [row('10:00:00'), row('11:00:00'), row('11:59:00', 'RQ-AB', 'drop', 'empty'),
      row('09:59:59'), row('12:00:01'), '2026-02-30 00:00:00\tRQ-X\tdrop\tbad', 'bad'].join('\r\n');
    expect(summarizeSkipReasons(skips, '# comment\nRQ-A\twork\n', 2, now)).toEqual({
      schema: 'fleet.skip-reasons.v1', hours: 2, total: 3, malformed: 2,
      actions: [{ value: 'defer', count: 2 }, { value: 'drop', count: 1 }],
      reasons: [{ value: 'waiting', count: 2 }, { value: 'empty', count: 1 }],
      ids: [{ id: 'RQ-A', inReady: true }, { id: 'RQ-AB', inReady: false }],
    });
  });
  it('reads the overridden root, supports JSON and plain output, and fails closed on missing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fleet-skips-'));
    try {
      await mkdir(join(root, 'queue'));
      await writeFile(join(root, 'queue', 'skipped-empty.tsv'), row('11:00:00'));
      await writeFile(join(root, 'queue', 'ready.tsv'), 'RQ-A\twork\n');
      vi.stubEnv('ASHLR_RUNS_DIR', root);
      vi.useFakeTimers(); vi.setSystemTime(now);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await cmdFleetSkipReasons(['--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ hours: 24, total: 1, ids: [{ id: 'RQ-A', inReady: true }] });
      expect(await cmdFleetSkipReasons(['--hours', '0.5'])).toBe(0);
      expect(log.mock.calls[1]![0]).toContain('Skip events in the last 0.5 hours: 0');
      await rm(join(root, 'queue', 'ready.tsv'));
      expect(await cmdFleetSkipReasons(['--json'])).toBe(1);
      expect(error.mock.calls[0]![0]).toBe('fleet skip-reasons: queue evidence unavailable');
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('validates options and is registered', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetSkipReasons(['--help'])).toBe(0);
    for (const args of [['--hours'], ['--hours', '0'], ['--hours', '-1'], ['--hours', 'Infinity'], ['--json', '--json'], ['--bad']]) {
      expect(await cmdFleetSkipReasons(args)).toBe(2);
    }
    expect((await FLEET_SUBCOMMAND_LOADERS['skip-reasons']!()).cmdFleetSkipReasons).toBe(cmdFleetSkipReasons);
  });
});
