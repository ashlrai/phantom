import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetLaneStall, readFleetLaneStall, type LaneStallReader } from '../src/cli/fleet-lane-stall.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = 1_800_000_000_000;
const row = (job: string, lane: string, age: number) => ({ text: `${job}\tphantom\t${lane}\twork\n`, mtimeMs: now - age * 60_000 });
function reader(): LaneStallReader {
  return {
    runLines: vi.fn(async () => [row('OLD', 'idle', 80), row('DONE', 'idle', 90), row('NEW', 'idle', 44),
      row('BUSY', 'busy', 80), row('OTHER', 'alpha', 60), row('UNKNOWN', 'unknown', 70), row('INVALID', 'invalid', 80)]),
    finishedJobs: async () => new Set(['DONE']),
    queueStatus: async () => JSON.stringify({ lanes: { idle: { running: 0 }, alpha: { running: 0 }, busy: { running: 1 }, invalid: { running: '0' } } }),
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('groups old unfinished jobs by explicit idle lane and orders oldest first', async () => {
  const r = reader();
  const rows = await r.runLines();
  r.runLines = async () => [...rows, row('OLDER', 'idle', 100), row('BOUNDARY', 'idle', 45), row('FUTURE', 'idle', -1), { text: 'bad', mtimeMs: 0 }];
  expect((await readFleetLaneStall(r, now)).lanes).toEqual([
    { lane: 'alpha', jobs: [{ job: 'OTHER', ageMinutes: 60 }] },
    { lane: 'idle', jobs: [{ job: 'OLDER', ageMinutes: 100 }, { job: 'OLD', ageMinutes: 80 }] },
  ]);
});

it.each([[], ['--min-minutes', '79.5'], ['--min-minutes', '0']].map(args => ({ args })))('prints JSON with exit 1 for stalls ($args)', async ({ args }) => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetLaneStall([...args, '--json'], { reader: reader(), now: () => now })).toBe(1);
  expect(JSON.parse(log.mock.calls[0]![0]).lanes.some((g: { lane: string }) => g.lane === 'idle')).toBe(true);
});

it('compares the exact age before rounding the displayed minutes', async () => {
  const r = reader();
  r.runLines = async () => [row('JUST-OVER', 'idle', 45.01)];
  expect((await readFleetLaneStall(r, now)).lanes[0]?.jobs).toEqual([{ job: 'JUST-OVER', ageMinutes: 45 }]);
});

it('prints grouped ages, and exits 0 for an empty result', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetLaneStall([], { reader: reader(), now: () => now })).toBe(1);
  expect(log).toHaveBeenCalledWith('idle (running 0):');
  expect(log).toHaveBeenCalledWith('  OLD: 80 min old');
  expect(await cmdFleetLaneStall(['--min-minutes', '100', '--json'], { reader: reader(), now: () => now })).toBe(0);
  expect(JSON.parse(log.mock.calls.at(-1)![0]).lanes).toEqual([]);
});

it.each([['--min-minutes'], ...['-1', 'NaN', 'Infinity', '', ' ', '1x', '0x10', '1e309'].map(v => ['--min-minutes', v]),
  ['--json', '--json'], ['--min-minutes', '1', '--min-minutes', '2'], ['--wat'], ['job']].map(args => ({ args })))('rejects bad usage $args before reading', async ({ args }) => {
  const r = reader();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetLaneStall(args, { reader: r })).toBe(2);
  expect(r.runLines).not.toHaveBeenCalled();
});

it('loads through the fleet registry and documents defaults without reading', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS['lane-stall']!()).cmdFleetLaneStall).toBe(cmdFleetLaneStall);
  expect(await cmdFleetLaneStall(['--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('default 45'));
});

it.each(['null', '{}', '{"lanes":[]}', 'invalid'])('fails safely for unreadable status %s', async status => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetLaneStall([], { reader: { ...reader(), queueStatus: async () => status } })).toBe(1);
});

it('reads real TSV fields, mtime and job-id completion markers under the configured runs directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lane-stall-'));
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const run = join(root, 'queue', 'run');
    await mkdir(run, { recursive: true });
    await writeFile(join(root, 'queue', 'status.json'), '{"lanes":{"idle":{"running":0}}}');
    for (const [file, job] of [['alias', 'OLD'], ['finished-alias', 'DONE']]) {
      const path = join(run, `${file}.line`);
      await writeFile(path, row(job!, 'idle', 80).text);
      await utimes(path, new Date(now - 80 * 60_000), new Date(now - 80 * 60_000));
    }
    await writeFile(join(run, 'DONE.fin'), 'done');
    await writeFile(join(run, 'ignored.txt'), 'ignored');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetLaneStall(['--json'], { now: () => now })).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0]).lanes).toEqual([{ lane: 'idle', jobs: [{ job: 'OLD', ageMinutes: 80 }] }]);
    await rm(run, { recursive: true });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetLaneStall([], { runsDir: root })).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
