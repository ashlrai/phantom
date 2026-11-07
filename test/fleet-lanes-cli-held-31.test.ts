import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleet } from '../src/cli/fleet.js';
import { getFleetLaneSnapshot } from '../src/core/fleet/lane-console.js';

let root: string;
let queueDir: string;
const since = '2026-10-31T20:00:00.000Z';
const until = '2099-11-01T04:30:00.000Z';
const slot = (held: boolean, reason: string | null, heldUntil: string | null = null) => ({
  target: 1, floor: 0, ceiling: 2, held, held_reason: reason,
  held_until: heldUntil, last_change: Date.parse(since) / 1000,
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-holds-'));
  queueDir = join(root, 'queue');
  await mkdir(queueDir);
  await writeFile(join(queueDir, 'ready.tsv'), 'READY\tjob-1\tcodex-personal\nREADY\tjob-2\tdevin\nREADY\tjob-3\tcodex-local\nREADY\tjob-4\tother-lane\n');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('fleet lane hold projection', () => {
  it('joins dispatcher holds, including idle lanes, into snapshots and CLI JSON', async () => {
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      'codex-personal': slot(true, 'autobackoff: usage limit', until),
      devin: slot(true, 'Mason t1221u'),
      'codex-local': slot(false, null),
      'idle-lane': slot(true, 'manual pause'),
    }));
    const snapshot = await getFleetLaneSnapshot({ queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [] });
    const byLane = new Map(snapshot.lanes.map(lane => [lane.lane, lane.hold]));
    expect(snapshot.holdSource).toBe('healthy');
    expect(snapshot.notes).toEqual([]);
    expect(byLane.get('codex-personal')).toEqual({ held: true, reason: 'autobackoff: usage limit', until, by: 'autobackoff', since });
    expect(byLane.get('devin')).toEqual({ held: true, reason: 'Mason t1221u', until: null, by: 'manual', since });
    expect(byLane.get('codex-local')).toEqual({ held: false, reason: null, until: null, by: null, since });
    expect(byLane.get('idle-lane')?.held).toBe(true);
    expect(byLane.get('other-lane')).toBeNull();

    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleet(['lanes', '--queue-dir', queueDir, '--json'])).toBe(0);
    const output = JSON.parse(log.mock.calls[0]![0] as string) as typeof snapshot;
    expect(output.holdSource).toBe('healthy');
    expect(output.lanes.find(lane => lane.lane === 'codex-personal')?.hold).toEqual(byLane.get('codex-personal'));
  });

  it('reports a missing hold source without failing the snapshot', async () => {
    const snapshot = await getFleetLaneSnapshot({ queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [] });
    expect(snapshot.holdSource).toBe('missing');
    expect(snapshot.notes).toEqual(['holds: missing']);
    expect(snapshot.lanes.length).toBeGreaterThan(0);
    expect(snapshot.lanes.every(lane => lane.hold === null)).toBe(true);
  });

  it('reports corrupt hold data as degraded without fabricating holds', async () => {
    await writeFile(join(queueDir, 'slots.json'), '{broken');
    const snapshot = await getFleetLaneSnapshot({ queueDir, budgetsDir: join(root, 'budgets'), usageLogPaths: [] });
    expect(snapshot.holdSource).toBe('degraded');
    expect(snapshot.notes).toEqual(['holds: degraded']);
    expect(snapshot.lanes.every(lane => lane.hold === null)).toBe(true);
  });
});
