import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readLaneTargets, setLaneTarget } from '../src/core/fleet/runs-lane-targets.js';

// Dispatcher-style direct map (verse-fleet-day-one) and wrapped map
// (fleet-runs-lane-targets-oct31), with synthetic settings and identities.
function laneFixture() {
  return {
    'codex-cmp': {
      target: 2, floor: 0, ceiling: 4, held: true,
      held_reason: 'fake maintenance', held_until: '2026-11-02T12:00:00Z',
      held_by: 'Fake operator 2026-10-31T00:00:00Z',
      last_change: 1793404800, changed_by: 'Fake operator 2026-10-31T00:00:00Z',
      provider: { name: 'fake-provider', model: 'fake-model' },
      billing: { account: 'fake-account', mode: 'fixture' },
      extra: { preserve: ['unknown', 42] },
    },
    claude: {
      target: 1, floor: 0, ceiling: 2, held: false,
      extra: { preserve: true },
    },
  };
}

const formats = ['direct', 'wrapped'] as const;
const pauseTime = '2026-10-31T00:12:00.000Z';
const restoreTime = '2026-11-01T09:30:00.000Z';
const actor = 'Fake phone operator';
let runsDir: string;
let slotsPath: string;
let settingsPath: string;
const settings = '{ "provider": "fake-provider", "billing": { "account": "fake-account" } }\n';

beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'upgrade-lane-slots-'));
  await mkdir(join(runsDir, 'queue'));
  slotsPath = join(runsDir, 'queue', 'slots.json');
  settingsPath = join(runsDir, 'fixture-settings.json');
  await writeFile(settingsPath, settings);
});
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });

describe.each(formats)('%s dispatcher slots', (format) => {
  function fixture() {
    const lanes = laneFixture();
    return format === 'direct' ? lanes : {
      lanes,
      metadata: { unknown: ['preserve', { revision: 7 }], provider: 'fake-provider', billing: 'fake-account' },
    };
  }

  it('pauses and restores the target while preserving holds, other lanes and settings', async () => {
    const initial = fixture();
    await writeFile(slotsPath, `${JSON.stringify(initial, null, 2)}\n`);
    const expected = structuredClone(initial);
    const expectedLanes = 'lanes' in expected ? expected.lanes : expected;
    const held = {
      lane: 'codex-cmp', floor: 0, ceiling: 4, held: true,
      heldReason: 'fake maintenance', heldUntil: '2026-11-02T12:00:00Z',
    };
    const initialRead = await readLaneTargets({ runsDir, now: () => new Date(pauseTime) });
    expect(initialRead).toMatchObject({ v: 1, generatedAt: pauseTime, sourceState: 'healthy' });
    expect(initialRead.lanes).toHaveLength(2);
    expect(initialRead.lanes.find((row) => row.lane === 'codex-cmp')).toMatchObject({ ...held, target: 2 });
    const otherLane = initialRead.lanes.find((row) => row.lane === 'claude');
    expect(otherLane).toBeDefined();

    for (const [target, time] of [[0, pauseTime], [2, restoreTime]] as const) {
      const opts = { runsDir, now: () => new Date(time), changedBy: actor };
      const result = await setLaneTarget('codex-cmp', target, opts);
      const roundtrip = await readLaneTargets(opts);
      expect(result).toEqual(roundtrip);
      expect(roundtrip).toMatchObject({ v: 1, generatedAt: time, sourceState: 'healthy' });
      expect(roundtrip.lanes).toHaveLength(2);
      expect(roundtrip.lanes.find((row) => row.lane === 'codex-cmp')).toMatchObject({
        ...held, target, lastChange: time, changedBy: `${actor} ${time}`,
      });
      expect(roundtrip.lanes.find((row) => row.lane === 'claude')).toEqual(otherLane);
      Object.assign(expectedLanes['codex-cmp'], {
        target, last_change: new Date(time).getTime() / 1000, changed_by: `${actor} ${time}`,
      });
      const expectedLane = expectedLanes['codex-cmp'] as Record<string, unknown>;
      if (target === 0) expectedLane.paused_from = 2;
      else delete expectedLane.paused_from;
      expect(JSON.parse(await readFile(slotsPath, 'utf8'))).toEqual(expected);
      expect(await readFile(settingsPath, 'utf8')).toBe(settings);
    }
    expect(await readFile(join(runsDir, 'queue', 'lane-target-changes.log'), 'utf8')).toBe(
      `${pauseTime}\tcodex-cmp\t2->0\t${actor}\n${restoreTime}\tcodex-cmp\t0->2\t${actor}\n`,
    );
  });

  it('rejects an out-of-range target without changing the original bytes', async () => {
    const original = `  ${JSON.stringify(fixture())}\n\n`;
    await writeFile(slotsPath, original);
    await expect(setLaneTarget('codex-cmp', 5, { runsDir, now: () => new Date(pauseTime), changedBy: actor }))
      .rejects.toMatchObject({ code: 'out-of-range', status: 422 });
    expect(await readFile(slotsPath, 'utf8')).toBe(original);
    expect(await readFile(settingsPath, 'utf8')).toBe(settings);
    await expect(readFile(join(runsDir, 'queue', 'lane-target-changes.log'))).rejects.toMatchObject({ code: 'ENOENT' });
    const state = await readLaneTargets({ runsDir, now: () => new Date(pauseTime) });
    expect(state.sourceState).toBe('healthy');
    expect(state.lanes.find((row) => row.lane === 'codex-cmp')).toMatchObject({
      target: 2, held: true, heldUntil: '2026-11-02T12:00:00Z',
    });
  });
});
