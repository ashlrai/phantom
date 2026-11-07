import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetIdleSlots, readFleetIdleSlots } from '../src/cli/fleet-idle-slots.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = new Date(2026, 10, 3, 12).getTime();
const tick = (time: string, run: object) => `2026-11-03 ${time} tick run=${JSON.stringify(run)} q=1 launched=0 reap=0 pause=False`;
const dirs: string[] = [];
async function fixture(log: string[], slots: unknown = { work: { target: 4, floor: 0, ceiling: 6 }, fast: { target: 2 }, last_change_by: 'x' }) {
  const dir = await mkdtemp(join(tmpdir(), 'idle-slots-'));
  dirs.push(dir);
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'dispatchd.log'), log.join('\n'));
  if (slots !== null) await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify(slots));
  return dir;
}
afterEach(async () => { vi.restoreAllMocks(); delete process.env.ASHLR_RUNS_DIR; await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

describe('fleet idle-slots', () => {
  it('weights running and idle slot-hours by tick gap', async () => {
    const runsDir = await fixture([tick('11:00:00', { work: 1, fast: 2 }), tick('11:05:00', { work: 3, fast: 2 }), tick('11:15:00', { work: 4 })]);
    const r = (await readFleetIdleSlots({ runsDir, now }))!;
    expect(r.ticks).toBe(3);
    // work: 1 for 300s, 3 for 600s -> avg 7/3; idle 3*300 + 1*600 = 1500 slot-s
    expect(r.lanes.find(l => l.lane === 'work')).toEqual({ lane: 'work', target: 4, averageRunning: 2.33, idleSlotHours: 0.42 });
    expect(r.lanes.find(l => l.lane === 'fast')).toEqual({ lane: 'fast', target: 2, averageRunning: 2, idleSlotHours: 0 });
    expect(r.totalIdleSlotHours).toBe(0.42);
  });
  it('honors --hours, skips downtime gaps and ignores malformed lines', async () => {
    const runsDir = await fixture([tick('08:00:00', { work: 0 }), tick('10:30:00', { work: 0 }), 'junk', '2026-11-03 10:31:00 tick run={bad} q=1 launched=0',
      tick('11:00:00', { work: 2 }), tick('11:06:00', { work: 2 })]);
    const r = (await readFleetIdleSlots({ runsDir, now, hours: 2 }))!;
    expect(r.ticks).toBe(3);
    expect(r.skippedGaps).toBe(1);
    expect(r.lanes.find(l => l.lane === 'work')).toMatchObject({ averageRunning: 2, idleSlotHours: 0.2 });
  });
  it('keeps targets unknown without slots.json and fails when the log is unreadable', async () => {
    const runsDir = await fixture([tick('11:00:00', { work: 1 }), tick('11:05:00', { work: 1 })], null);
    expect((await readFleetIdleSlots({ runsDir, now }))!.lanes).toEqual([{ lane: 'work', target: null, averageRunning: 1, idleSlotHours: null }]);
    expect(await readFleetIdleSlots({ runsDir: join(runsDir, 'missing'), now })).toBeNull();
  });
  it('prints plain words and JSON, honoring ASHLR_RUNS_DIR, and rejects bad flags', async () => {
    process.env.ASHLR_RUNS_DIR = await fixture([tick('11:00:00', { work: 1 }), tick('11:06:00', { work: 1 })]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetIdleSlots(['--json'], { now })).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ schema: 'fleet.idle-slots.v1', hours: 2, ticks: 2 });
    expect(await cmdFleetIdleSlots(['--hours', '3'], { now })).toBe(0);
    expect(log.mock.calls[1]![0]).toContain('work: average running 1, target 4, idle 0.3 slot-hours');
    for (const bad of [['--hours'], ['--hours', '0'], ['--hours', 'x'], ['--nope']]) expect(await cmdFleetIdleSlots(bad, { now })).toBe(2);
    expect(err).toHaveBeenCalled();
  });
  it('is registered as a fleet verb', () => { expect(FLEET_SUBCOMMAND_LOADERS['idle-slots']).toBeTypeOf('function'); });
});
