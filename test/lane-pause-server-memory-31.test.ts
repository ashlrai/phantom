import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { readLaneTargets, setLaneTarget } from '../src/core/fleet/runs-lane-targets.js';

// Server-side pause memory: pausing (target -> 0) records paused_from in
// slots.json so a resume on another device can restore the pre-pause target.
let runsDir: string;
let path: string;
const now = () => new Date('2026-10-31T12:00:00Z');
const fixture = () => ({ lanes: {
  sol: { target: 6, floor: 0, ceiling: 8, held: false },
  claude: { target: 3, floor: 2, ceiling: 5, held: false },
} });
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'lane-pause-memory-'));
  await mkdir(join(runsDir, 'queue'));
  path = join(runsDir, 'queue/slots.json');
  await writeFile(path, JSON.stringify(fixture(), null, 1));
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
it('remembers the pre-pause target and clears it on resume', async () => {
  const paused = await setLaneTarget('sol', 0, { runsDir, now, changedBy: 'Fake phone' });
  expect(paused.lanes[0]).toMatchObject({ lane: 'sol', target: 0, pausedFrom: 6 });
  expect(JSON.parse(await readFile(path, 'utf8')).lanes.sol.paused_from).toBe(6);
  // A device that never saw the pause reads the same memory.
  expect((await readLaneTargets({ runsDir, now })).lanes[0]).toMatchObject({ target: 0, pausedFrom: 6 });
  const resumed = await setLaneTarget('sol', 3, { runsDir, now, changedBy: 'Fake desktop' });
  expect(resumed.lanes[0]).toMatchObject({ target: 3, pausedFrom: null });
  expect(JSON.parse(await readFile(path, 'utf8')).lanes.sol).not.toHaveProperty('paused_from');
});
it('keeps the stored memory when a paused lane is re-paused and never invents one', async () => {
  await setLaneTarget('sol', 0, { runsDir, now });
  await setLaneTarget('sol', 0, { runsDir, now });
  expect((await readLaneTargets({ runsDir })).lanes[0].pausedFrom).toBe(6);
  expect(JSON.parse(await readFile(path, 'utf8')).lanes.sol.paused_from).toBe(6);
  expect(JSON.parse(await readFile(path, 'utf8')).lanes.claude).not.toHaveProperty('paused_from');
});
it('treats stored non-integer or out-of-range values as nothing remembered', async () => {
  const lanes = fixture().lanes;
  for (const paused_from of ['x', 1.5, -2, 0, 99]) {
    await writeFile(path, JSON.stringify({ lanes: { sol: { ...lanes.sol, target: 0, paused_from }, claude: lanes.claude } }));
    expect((await readLaneTargets({ runsDir })).lanes[0].pausedFrom).toBeNull();
  }
  // Below the lane's floor is out-of-range too.
  await writeFile(path, JSON.stringify({ lanes: { sol: lanes.sol, claude: { ...lanes.claude, target: 0, paused_from: 1 } } }));
  expect((await readLaneTargets({ runsDir })).lanes[1].pausedFrom).toBeNull();
});
it('appends one audit line per change', async () => {
  await setLaneTarget('sol', 0, { runsDir, now, changedBy: 'Fake phone' });
  await setLaneTarget('sol', 6, { runsDir, now, changedBy: 'Fake desktop' });
  expect(await readFile(join(runsDir, 'queue/lane-target-changes.log'), 'utf8'))
    .toBe(`${now().toISOString()}\tsol\t6->0\tFake phone\n${now().toISOString()}\tsol\t0->6\tFake desktop\n`);
});
