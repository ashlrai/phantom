import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetLaunchable } from '../src/cli/fleet-launchable.js';
import { cmdFleetLaneStarve } from '../src/cli/fleet-lane-starve.js';

let root: string;
const saved = process.env.ASHLR_RUNS_DIR;
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'held-headroom-'));
  mkdirSync(join(root, 'queue'));
  process.env.ASHLR_RUNS_DIR = root;
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
});
afterEach(() => {
  if (saved === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = saved;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
const status = (lanes: unknown) => writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ lanes }));
const report = () => JSON.parse(String(log.mock.calls.at(-1)?.[0]));

it('excludes held and shed-full lanes while retaining effective targets and parked parsing', async () => {
  const prompt = join(root, 'prompt');
  writeFileSync(prompt, 'task');
  status({
    held: { running: 0, target: 4, queued: 2, held: true },
    full: { running: 1, target: 4, queued: 2, effective_target: 1 },
    room: { running: 0, target: 4, queued: 2, held: false, effective_target: 2 },
    missing: { running: 0, target: 1, queued: 1 },
    nulls: { running: 0, target: 1, queued: 1, held: null, effective_target: null },
  });
  writeFileSync(join(root, 'queue', 'ready.tsv'), [
    `job\trepo\troom\twork\t${prompt}`,
    `PARKED-DEP.room\tjob2\troom\twork\t${prompt}`,
    `job3\trepo\tPARKED-DEP.room\twork\t${prompt}`,
  ].join('\n'));
  expect(await cmdFleetLaunchable(['--json'])).toBe(1);
  expect(report().lanes).toEqual([
    { lane: 'full', running: 1, target: 1, free: 0, launchable: 0 },
    { lane: 'held', running: 0, target: 4, free: 0, launchable: 0 },
    { lane: 'missing', running: 0, target: 1, free: 1, launchable: 0 },
    { lane: 'nulls', running: 0, target: 1, free: 1, launchable: 0 },
    { lane: 'room', running: 0, target: 2, free: 2, launchable: 1 },
  ]);
  expect(await cmdFleetLaneStarve(['--json'])).toBe(1);
  expect(report().lanes).toEqual([
    { lane: 'missing', running: 0, target: 1, queued: 1, ready: 0, filler: 0, real: 0 },
    { lane: 'nulls', running: 0, target: 1, queued: 1, ready: 0, filler: 0, real: 0 },
    { lane: 'room', running: 0, target: 2, queued: 2, ready: 1, filler: 0, real: 1 },
  ]);
  status({ held: { running: 0, target: 4, queued: 2, held: true } });
  expect(await cmdFleetLaunchable(['--json'])).toBe(0);
  expect(report().lanes[0].free).toBe(0);
  expect(await cmdFleetLaneStarve(['--json'])).toBe(0);
  expect(report().lanes).toEqual([]);
});

it.each([{ held: 'true' }, { held: 0 }, { effective_target: '1' }, { effective_target: -1 }, { effective_target: 1.5 }])
('rejects malformed optional fields: %o', async fields => {
  status({ bad: { running: 0, target: 3, queued: 1, ...fields } });
  expect(await cmdFleetLaunchable(['--json'])).toBe(2);
  expect(report().error).toBeTruthy();
  expect(await cmdFleetLaneStarve(['--json'])).toBe(2);
  expect(report().error).toBeTruthy();
});
