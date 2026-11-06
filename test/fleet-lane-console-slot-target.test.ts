/**
 * fleet-lane-console-slot-target.test.ts : FleetLaneView.slotTarget is the
 * lane's target from a healthy lane-targets read (<runs>/queue/slots.json),
 * null for a lane without a row and null for every lane when the file is corrupt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getFleetLaneSnapshot } from '../src/core/fleet/lane-console.js';

let scratch: string;
let queueDir: string;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'fleet-lanes-slot-'));
  queueDir = join(scratch, 'queue');
  await mkdir(queueDir, { recursive: true });
  await writeFile(join(queueDir, 'ready.tsv'), [
    'id\tstatus\tpool',
    'j1\tREADY\tdevin',
    'j2\tREADY\tcodex-personal',
  ].join('\n'));
});
afterEach(async () => { await rm(scratch, { recursive: true, force: true }); });

const snapshot = () => getFleetLaneSnapshot({
  queueDir, budgetsDir: join(scratch, 'budgets'), usageLogPaths: [], now: () => new Date('2026-11-04T12:00:00Z'),
});
const target = async (lane: string) => (await snapshot()).lanes.find(l => l.lane === lane)!.slotTarget;

describe('FleetLaneView.slotTarget', () => {
  it('is filled for a lane with a target row and null for one without', async () => {
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      devin: { target: 10, floor: 0, ceiling: 12, held: false },
    }), { mode: 0o600 });
    expect(await target('devin')).toBe(10);
    expect(await target('codex-personal')).toBeNull();
  });

  it('keeps a zero target as 0, not null', async () => {
    await writeFile(join(queueDir, 'slots.json'), JSON.stringify({
      devin: { target: 0, floor: 0, ceiling: 12, held: true },
    }), { mode: 0o600 });
    expect(await target('devin')).toBe(0);
  });

  it('is null for every lane when the targets file is corrupt', async () => {
    await writeFile(join(queueDir, 'slots.json'), '{ not json', { mode: 0o600 });
    const snap = await snapshot();
    expect(snap.holdSource).toBe('degraded');
    expect(snap.lanes.length).toBeGreaterThan(0);
    expect(snap.lanes.every(l => l.slotTarget === null)).toBe(true);
  });

  it('is null when the targets file is missing', async () => {
    const snap = await snapshot();
    expect(snap.lanes.length).toBeGreaterThan(0);
    expect(snap.lanes.every(l => l.slotTarget === null)).toBe(true);
  });
});
