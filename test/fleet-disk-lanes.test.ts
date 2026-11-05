import { describe, expect, it } from 'vitest';
import {
  buildFleetDisk,
  cmdFleetDisk,
  FLEET_DISK_LANE_FREEZE_GB,
  FLEET_DISK_LANE_HALVE_GB,
  formatFleetDisk,
  parseLaneDiskLines,
  readFleetDisk,
  type FleetDiskDeps,
} from '../src/cli/fleet-disk.js';

// Fixed local clock: Nov 2 2026 12:00. Fixture stamps sit relative to it so the
// log's local wall-time convention resolves on any host timezone.
const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const pad2 = (n: number): string => String(n).padStart(2, '0');
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const leader = (minutesAgo: number, freeGb: number): string =>
  `${localStamp(NOW - minutesAgo * 60_000)} LEADER fixups=1 bets=2 reaps=0 ignored=0 free_gb=${freeGb}`;

const RUNS = '/runs';
const events = (lines: string[]): NonNullable<FleetDiskDeps['readEvents']> =>
  () => ({ state: 'healthy', text: `${lines.join('\n')}\n` });
const overrides = (text: string, state: 'healthy' | 'missing' | 'degraded' = 'healthy'): NonNullable<FleetDiskDeps['readOverrides']> =>
  () => ({ state, text });
const du = (): NonNullable<FleetDiskDeps['du']> => () => `100\t${RUNS}\n`;

async function run(argv: string[], deps: FleetDiskDeps = {}) {
  const logs: string[] = [];
  const errors: string[] = [];
  const code = await cmdFleetDisk(argv, {
    now: NOW,
    output: { log: (s) => logs.push(s), error: (s) => errors.push(s) },
    ...deps,
  });
  return { code, logs, errors, report: argv.includes('--json') && logs.length ? JSON.parse(logs[0]!) : null };
}

describe('parseLaneDiskLines', () => {
  it('returns the 60/35 defaults for empty, garbage or structureless input', () => {
    const defaults = { freezeBelowGb: FLEET_DISK_LANE_FREEZE_GB, halveBelowGb: FLEET_DISK_LANE_HALVE_GB };
    for (const text of ['', 'not json', 'null', '42', '"x"', '[]', '{}', '{"compact":{}}', '{"compact":{"lanes":{}}}']) {
      expect(parseLaneDiskLines(text), JSON.stringify(text)).toEqual(defaults);
    }
    expect(defaults).toEqual({ freezeBelowGb: 60, halveBelowGb: 35 });
  });

  it('reads compact.lanes raise_freeze_below_gb and halve_below_gb', () => {
    expect(parseLaneDiskLines(JSON.stringify({
      compact: { lanes: { raise_freeze_below_gb: 80, halve_below_gb: 45.9 } },
    }))).toEqual({ freezeBelowGb: 80, halveBelowGb: 45 });
  });

  it('falls back per key on invalid values and ignores lookalike keys elsewhere', () => {
    for (const value of ['80', -1, null, Number.NaN, {}, [80]]) {
      expect(parseLaneDiskLines(JSON.stringify({ compact: { lanes: { raise_freeze_below_gb: value } } })))
        .toEqual({ freezeBelowGb: 60, halveBelowGb: 35 });
    }
    // The compact block's other keys and top-level namesakes are not the lane lines.
    expect(parseLaneDiskLines(JSON.stringify({
      raise_freeze_below_gb: 200,
      compact: { l1_free_gb: 300, lanes: { halve_below_gb: 0 } },
    }))).toEqual({ freezeBelowGb: 60, halveBelowGb: 0 });
    expect(parseLaneDiskLines(JSON.stringify({ compact: 'x', lanes: 7 })))
      .toEqual({ freezeBelowGb: 60, halveBelowGb: 35 });
  });
});

describe('buildFleetDisk lane lines', () => {
  const sample = (minutesAgo: number, freeGb: number) => ({
    at: new Date(NOW - minutesAgo * 60_000).toISOString(), ms: NOW - minutesAgo * 60_000, freeGb,
  });
  const base = { runsDir: RUNS, nowMs: NOW, source: 'healthy' as const, overridesSource: 'healthy' as const, largestSubdirs: [] };

  it('projects the freeze and halve crossings off the same rate', () => {
    // 140 -> 120 over 4 hours: 5 GB/hour. 60 GB to the freeze line: 12 h; 85 to the halve line: 17 h.
    const report = buildFleetDisk({
      ...base, laneLines: { freezeBelowGb: 60, halveBelowGb: 35 },
      samples: [sample(240, 140), sample(0, 120)],
    });
    expect(report).toMatchObject({
      laneFreezeBelowGb: 60, laneHalveBelowGb: 35,
      hoursUntilLaneFreeze: 12, hoursUntilLaneHalve: 17,
    });
  });

  it('reports 0 for a line already crossed', () => {
    const report = buildFleetDisk({
      ...base, laneLines: { freezeBelowGb: 130, halveBelowGb: 35 },
      samples: [sample(240, 140), sample(0, 120)],
    });
    expect(report.hoursUntilLaneFreeze).toBe(0);
    expect(report.hoursUntilLaneHalve).toBe(17);
  });

  it('leaves the hours null when the trend is unprovable or not shrinking', () => {
    const empty = buildFleetDisk({ ...base, laneLines: { freezeBelowGb: 60, halveBelowGb: 35 }, samples: [] });
    expect([empty.hoursUntilLaneFreeze, empty.hoursUntilLaneHalve]).toEqual([null, null]);
    const flat = buildFleetDisk({
      ...base, laneLines: { freezeBelowGb: 60, halveBelowGb: 35 },
      samples: [sample(240, 120), sample(0, 120)],
    });
    expect([flat.hoursUntilLaneFreeze, flat.hoursUntilLaneHalve]).toEqual([null, null]);
  });
});

describe('readFleetDisk lane lines', () => {
  it('reads queue/budget-overrides.json under the runs root through the injected reader', async () => {
    const seen: string[] = [];
    const report = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(240, 140), leader(0, 120)]),
      readOverrides: (path) => { seen.push(path); return { state: 'healthy', text: '{"compact":{"lanes":{"raise_freeze_below_gb":80,"halve_below_gb":40}}}' }; },
      du: du(),
    });
    expect(seen).toEqual([`${RUNS}/queue/budget-overrides.json`]);
    expect(report).toMatchObject({
      overridesSource: 'healthy', laneFreezeBelowGb: 80, laneHalveBelowGb: 40,
      hoursUntilLaneFreeze: 8, hoursUntilLaneHalve: 16,
    });
  });

  it('supports an async overrides reader', async () => {
    const report = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(240, 140), leader(0, 120)]),
      readOverrides: async () => ({ state: 'healthy' as const, text: '{"compact":{"lanes":{"raise_freeze_below_gb":100}}}' }),
      du: du(),
    });
    expect(report).toMatchObject({ laneFreezeBelowGb: 100, laneHalveBelowGb: 35, hoursUntilLaneFreeze: 4 });
  });

  it('falls back to defaults and still reports the read state when the file is missing or degraded', async () => {
    const missing = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(240, 140), leader(0, 120)]),
      readOverrides: overrides('', 'missing'),
      du: du(),
    });
    expect(missing).toMatchObject({
      overridesSource: 'missing', laneFreezeBelowGb: 60, laneHalveBelowGb: 35,
      hoursUntilLaneFreeze: 12, hoursUntilLaneHalve: 17,
    });
    const thrown = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(240, 140), leader(0, 120)]),
      readOverrides: () => { throw new Error('io'); },
      du: du(),
    });
    expect(thrown).toMatchObject({ overridesSource: 'degraded', laneFreezeBelowGb: 60, laneHalveBelowGb: 35 });
    const garbage = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(240, 140), leader(0, 120)]),
      readOverrides: overrides('}{ not json'),
      du: du(),
    });
    expect(garbage).toMatchObject({ overridesSource: 'healthy', laneFreezeBelowGb: 60, laneHalveBelowGb: 35 });
  });

  it('leaves lane hours null when the event trend is unknown even though the lines are known', async () => {
    const report = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: () => ({ state: 'missing', text: '' }),
      readOverrides: overrides('{"compact":{"lanes":{"raise_freeze_below_gb":80,"halve_below_gb":40}}}'),
      du: du(),
    });
    expect(report).toMatchObject({
      source: 'missing', laneFreezeBelowGb: 80, laneHalveBelowGb: 40,
      hoursUntilLaneFreeze: null, hoursUntilLaneHalve: null,
    });
  });
});

describe('formatFleetDisk lane lines', () => {
  const report = (over: Partial<Parameters<typeof formatFleetDisk>[0]> = {}) =>
    formatFleetDisk({
      schema: 'fleet.disk.v1', generatedAt: new Date(NOW).toISOString(), runsDir: RUNS,
      windowHours: 12, targetFreeGb: 100, source: 'healthy', overridesSource: 'healthy', samples: 2,
      freeGbNow: 120, firstFreeGb: 140, observedHours: 4, gbPerHour: 5,
      hoursUntilTargetFreeGb: 4, laneFreezeBelowGb: 60, laneHalveBelowGb: 35,
      hoursUntilLaneFreeze: 12, hoursUntilLaneHalve: 17,
      largestSubdirs: [],
      ...over,
    });

  it('prints the lane lines in plain words with hours', () => {
    const lines = report();
    expect(lines).toContain('lane freeze below 60 GB in: 12 hours');
    expect(lines).toContain('lane halve below 35 GB in: 17 hours');
  });

  it('prints now for a line already crossed', () => {
    const lines = report({ freeGbNow: 55, hoursUntilLaneFreeze: 0, hoursUntilLaneHalve: 4 });
    expect(lines).toContain('lane freeze below 60 GB in: now');
    expect(lines).toContain('lane halve below 35 GB in: 4 hours');
  });

  it('prints unknown when the trend is unknown, never zero', () => {
    const lines = report({
      freeGbNow: null, gbPerHour: null, hoursUntilTargetFreeGb: null,
      hoursUntilLaneFreeze: null, hoursUntilLaneHalve: null,
    });
    expect(lines).toContain('lane freeze below 60 GB in: unknown');
    expect(lines).toContain('lane halve below 35 GB in: unknown');
    expect(lines.some((l) => l.endsWith('in: 0 hours'))).toBe(false);
  });

  it('prints not at this rate when free space is provably not shrinking', () => {
    const lines = report({ gbPerHour: -1, hoursUntilLaneFreeze: null, hoursUntilLaneHalve: null });
    expect(lines).toContain('lane freeze below 60 GB in: not at this rate');
    expect(lines).toContain('lane halve below 35 GB in: not at this rate');
  });

  it('prints the overridden line values, not the defaults', () => {
    const lines = report({ laneFreezeBelowGb: 80, laneHalveBelowGb: 40 });
    expect(lines).toContain('lane freeze below 80 GB in: 12 hours');
    expect(lines).toContain('lane halve below 40 GB in: 17 hours');
  });
});

describe('cmdFleetDisk lane lines', () => {
  const goodDeps: FleetDiskDeps = {
    now: NOW, runsRoot: RUNS,
    readEvents: events([leader(240, 140), leader(0, 120)]),
    readOverrides: overrides('{"compact":{"lanes":{"raise_freeze_below_gb":80,"halve_below_gb":40}}}'),
    du: du(),
  };

  it('adds both lane facts to --json', async () => {
    const { code, report } = await run(['--json'], goodDeps);
    expect(code).toBe(0);
    expect(report).toMatchObject({
      schema: 'fleet.disk.v1', overridesSource: 'healthy',
      laneFreezeBelowGb: 80, laneHalveBelowGb: 40,
      hoursUntilLaneFreeze: 8, hoursUntilLaneHalve: 16,
    });
  });

  it('prints now in the human output when a line is already crossed', async () => {
    const { code, logs } = await run([], {
      ...goodDeps,
      readEvents: events([leader(240, 140), leader(0, 75)]),
      readOverrides: overrides('{"compact":{"lanes":{"raise_freeze_below_gb":80,"halve_below_gb":40}}}'),
    });
    expect(code).toBe(0);
    expect(logs).toContain('lane freeze below 80 GB in: now');
    // 140 -> 75 over 4 hours: 16.3 GB/hour, 35 GB to the halve line: 2.1 hours.
    expect(logs).toContain('lane halve below 40 GB in: 2.1 hours');
  });

  it('prints unknown for the lane lines when the log cannot be read and exits 0', async () => {
    const { code, report } = await run(['--json'], {
      ...goodDeps, readEvents: () => ({ state: 'missing' as const, text: '' }),
    });
    expect(code).toBe(0);
    expect(report).toMatchObject({ hoursUntilLaneFreeze: null, hoursUntilLaneHalve: null });
    const plain = await run([], { ...goodDeps, readEvents: () => ({ state: 'missing' as const, text: '' }) });
    expect(plain.logs).toContain('lane freeze below 80 GB in: unknown');
    expect(plain.logs).toContain('lane halve below 40 GB in: unknown');
  });
});
