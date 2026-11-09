import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetStranded, readFleetStranded } from '../src/cli/fleet-stranded.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = 1_800_000_000_000;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('finds unfinished filename IDs on explicitly idle lanes, strictly over the threshold and oldest first', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stranded-'));
  try {
    vi.stubEnv('ASHLR_RUNS_DIR', root);
    const dir = join(root, 'queue', 'run');
    await mkdir(dir, { recursive: true });
    await writeFile(join(root, 'queue', 'status.json'), JSON.stringify({ lanes: { idle: { running: 0 }, other: { running: 0 }, busy: { running: 1 }, invalid: { running: '0' } } }));
    for (const [id, lane, age] of [['older', 'other', 120], ['old', 'idle', 100], ['done', 'idle', 150], ['boundary', 'idle', 90], ['busy', 'busy', 200], ['unknown', 'missing', 200], ['invalid', 'invalid', 200]] as const) {
      const path = join(dir, `${id}.line`);
      await writeFile(path, `different-id\tphantom\t${lane}\twork\n`);
      await utimes(path, new Date(now - age * 60_000), new Date(now - age * 60_000));
    }
    await writeFile(join(dir, 'done.fin'), '');
    await writeFile(join(dir, 'different-id.fin'), '');
    expect((await readFleetStranded({ now })).runs).toEqual([
      { id: 'older', lane: 'other', ageMinutes: 120 }, { id: 'old', lane: 'idle', ageMinutes: 100 },
    ]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetStranded(['--minutes', '110', '--json'], { now })).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0]).runs.map((r: { id: string }) => r.id)).toEqual(['older']);
    expect(await cmdFleetStranded([], { now })).toBe(0);
    expect(log).toHaveBeenCalledWith('older\tother\t120.0 min old');
    expect(await cmdFleetStranded(['--minutes', '200'], { now })).toBe(0);
    expect(log).toHaveBeenCalledWith('No stranded runs.');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([['--minutes'], ['--minutes', '-1'], ['--minutes', 'NaN'], ['--minutes', '1e3'], ['--json', '--json'], ['--bad']])('rejects invalid arguments %j (row %#)', async (...args) => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetStranded(args)).toBe(2);
});

it('loads through the registry and displays help', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect((await FLEET_SUBCOMMAND_LOADERS.stranded!()).cmdFleetStranded).toBe(cmdFleetStranded);
  expect(await cmdFleetStranded(['--help'])).toBe(0);
  expect(log).toHaveBeenCalledWith(expect.stringContaining('default 90'));
});

it.each(['null', '{}', '{"lanes":[]}', 'bad'])('reports invalid status as an error: %s', async status => {
  const root = await mkdtemp(join(tmpdir(), 'stranded-invalid-'));
  try {
    await mkdir(join(root, 'queue', 'run'), { recursive: true });
    await writeFile(join(root, 'queue', 'status.json'), status);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetStranded([], { runsDir: root })).toBe(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
