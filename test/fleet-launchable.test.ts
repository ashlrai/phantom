import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetLaunchable } from '../src/cli/fleet-launchable.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let root: string;
let queue: string;
const original = process.env.ASHLR_RUNS_DIR;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'launchable-'));
  queue = join(root, 'queue');
  mkdirSync(queue);
  process.env.ASHLR_RUNS_DIR = root;
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (original === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = original;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const status = (lanes: unknown) => writeFileSync(join(queue, 'status.json'), JSON.stringify({ lanes }));
const row = (id: string, lane: string, prompt: string) => [id, 'work', lane, 'repo', prompt].join('\t');
const report = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));

describe('fleet launchable', () => {
  it('counts eligible rows and compares each lane with its free slots', async () => {
    const prompt = join(root, 'prompt.md');
    writeFileSync(prompt, 'task');
    status({ alpha: { target: 4, running: 1 }, beta: { target: 1, running: 1 }, PARKEDx: { target: 0, running: 0 } });
    writeFileSync(join(queue, 'ready.tsv'), [
      row('good', 'alpha', prompt), row('A123456Q8', 'alpha', prompt),
      row('A12345Q8', 'alpha', prompt), row('missing', 'alpha', join(root, 'missing')),
      row('drop', 'alpha', prompt), row('defer', 'alpha', prompt), row('other', 'alpha', prompt),
      row('parked', 'PARKEDx', prompt), row('beta', 'beta', prompt), '# comment',
    ].join('\n'));
    writeFileSync(join(queue, 'skipped-empty.tsv'), 'time\tdrop\tdrop\treason\ntime\tdefer\tdefer\treason\ntime\tother\tobserve\treason\n');
    writeFileSync(join(queue, 'FILLER_HOLD'), '');
    expect(await cmdFleetLaunchable(['--json'])).toBe(0);
    expect(report()).toMatchObject({ fillerHold: true, lanes: [
      { lane: 'alpha', free: 3, launchable: 3 }, { lane: 'beta', free: 0, launchable: 1 },
      { lane: 'PARKEDx', free: 0, launchable: 0 },
    ] });
    status({ alpha: { target: 5, running: 1 } });
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    rmSync(join(queue, 'FILLER_HOLD'));
    expect(await cmdFleetLaunchable(['--json'])).toBe(0);
    expect(report().lanes[0].launchable).toBe(4);
  });
  it('handles absent optional files and clamps negative free slots', async () => {
    status({ idle: { target: 2, running: 0 }, full: { target: 1, running: 2 } });
    expect(await cmdFleetLaunchable([])).toBe(1);
    expect(log.mock.calls.map(call => String(call[0])).join('\n')).toContain('idle: 0 launchable, 2 free slots');
    expect(await cmdFleetLaunchable(['--json'])).toBe(1);
    expect(report().lanes.find((lane: { lane: string }) => lane.lane === 'full').free).toBe(0);
  });
  it('fails closed on missing or malformed status and rejects invalid arguments', async () => {
    expect(await cmdFleetLaunchable(['--json'])).toBe(2);
    expect(report().error).toMatch(/Cannot read/);
    status({ bad: { target: '2', running: 0 } });
    expect(await cmdFleetLaunchable(['--json'])).toBe(2);
    expect(await cmdFleetLaunchable(['--bad'])).toBe(2);
    expect(await cmdFleetLaunchable(['--help'])).toBe(0);
    expect(FLEET_SUBCOMMAND_LOADERS.launchable).toBeTypeOf('function');
  });
});
