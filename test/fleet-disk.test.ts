import { describe, expect, it } from 'vitest';
import {
  buildFleetDisk,
  cmdFleetDisk,
  FLEET_DISK_TOP_DIRS,
  formatFleetDisk,
  parseDuSubdirs,
  parseLeaderFreeGb,
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
const duText = (pairs: Array<[number, string]>): NonNullable<FleetDiskDeps['du']> =>
  () => pairs.map(([kb, path]) => `${kb}\t${path}`).join('\n') + '\n';

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

describe('parseLeaderFreeGb', () => {
  it('keeps only LEADER rows with free_gb inside the last 12 hours', () => {
    const samples = parseLeaderFreeGb([
      leader(60, 140),
      leader(30, 138),
      leader(10, 137.5),
      `${localStamp(NOW - 13 * 60 * 60_000)} LEADER fixups=0 free_gb=200`, // outside window
      `${localStamp(NOW + 5 * 60_000)} LEADER fixups=0 free_gb=90`,        // future row
      `${localStamp(NOW - 20 * 60_000)} LAUNCH RQ-1 pool work`,            // not LEADER
      `${localStamp(NOW - 15 * 60_000)} LEADER fixups=0`,                  // no free_gb
      '2026-02-30 12:00:00 LEADER impossible free_gb=1',                   // bad date
      'garbage line',
      '',
    ].join('\n'), NOW);
    expect(samples.map((s) => s.freeGb)).toEqual([140, 138, 137.5]);
    expect(Date.parse(samples.at(-1)!.at)).toBe(NOW - 10 * 60_000);
  });

  it('lets the later line win a timestamp tie', () => {
    const stamp = localStamp(NOW - 30 * 60_000);
    const samples = parseLeaderFreeGb(`${stamp} LEADER free_gb=140\n${stamp} LEADER free_gb=139\n`, NOW);
    expect(samples).toEqual([expect.objectContaining({ freeGb: 139 })]);
  });
});

describe('buildFleetDisk', () => {
  const sample = (minutesAgo: number, freeGb: number) => ({
    at: new Date(NOW - minutesAgo * 60_000).toISOString(), ms: NOW - minutesAgo * 60_000, freeGb,
  });
  const base = { runsDir: RUNS, nowMs: NOW, source: 'healthy' as const, largestSubdirs: [] };

  it('computes GB per hour lost and hours until 100 GB free', () => {
    // 140 -> 120 over 4 hours: 5 GB/hour, 20 GB to go, 4 hours left.
    const report = buildFleetDisk({ ...base, samples: [sample(240, 140), sample(0, 120)] });
    expect(report).toMatchObject({
      schema: 'fleet.disk.v1', samples: 2, freeGbNow: 120, firstFreeGb: 140,
      observedHours: 4, gbPerHour: 5, hoursUntilTargetFreeGb: 4, targetFreeGb: 100,
    });
  });

  it('reports 0 when free space is already at or under 100 GB', () => {
    const report = buildFleetDisk({ ...base, samples: [sample(240, 110), sample(0, 95)] });
    expect(report.hoursUntilTargetFreeGb).toBe(0);
    expect(report.gbPerHour).toBeGreaterThan(0);
  });

  it('leaves the hours null when free space is flat or growing', () => {
    for (const pair of [[120, 120], [115, 125]] as const) {
      const report = buildFleetDisk({ ...base, samples: [sample(240, pair[0]), sample(0, pair[1])] });
      expect(report.hoursUntilTargetFreeGb).toBeNull();
      expect(report.gbPerHour).not.toBeNull();
    }
  });

  it('leaves rate and hours unknown with fewer than two provable samples', () => {
    const empty = buildFleetDisk({ ...base, samples: [] });
    expect(empty).toMatchObject({ freeGbNow: null, gbPerHour: null, hoursUntilTargetFreeGb: null });
    const one = buildFleetDisk({ ...base, samples: [sample(5, 137)] });
    expect(one).toMatchObject({ freeGbNow: 137, gbPerHour: null, hoursUntilTargetFreeGb: null });
    // Two readings at one instant prove no span.
    const tie = buildFleetDisk({ ...base, samples: [sample(5, 137), sample(5, 136)] });
    expect(tie.gbPerHour).toBeNull();
    expect(tie.hoursUntilTargetFreeGb).toBeNull();
  });
});

describe('parseDuSubdirs', () => {
  it('lists the ten largest direct subdirs, skipping the root total and deeper paths', () => {
    const pairs: Array<[number, string]> = [[9_999_999, RUNS]];
    for (let i = 0; i < FLEET_DISK_TOP_DIRS + 4; i++) pairs.push([(i + 1) * 1_000_000, `${RUNS}/d${i}`]);
    pairs.push([500_000, `${RUNS}/wt/RQ-1`]);            // deeper descendant, not a direct child
    pairs.push([123, ''],                                // malformed
      [7, 'relative/path'],                              // outside the root
    );
    const dirs = parseDuSubdirs(pairs.map(([kb, p]) => `${kb}\t${p}`).join('\n'), RUNS);
    expect(dirs).toHaveLength(FLEET_DISK_TOP_DIRS);
    expect(dirs[0]).toEqual({ name: 'd13', gb: 14.3 }); // 14_000_000 KiB * 1024 = 14.336 GB
    expect(dirs.map((d) => d.name)).not.toContain('wt/RQ-1');
  });

  it('drops the root line, dot names, control bytes and keeps the biggest per name', () => {
    const dirs = parseDuSubdirs([
      `1\t${RUNS}`,
      `10\t${RUNS}/wt`,
      `20\t${RUNS}/wt`,
      `30\t${RUNS}/..`,
      `40\t${RUNS}/bad\tname`,
      `50\t${RUNS}/.`,
    ].join('\n'), `${RUNS}/`);
    expect(dirs).toEqual([{ name: 'wt', gb: 0 }]);
  });
});

describe('readFleetDisk', () => {
  it('reports every trend fact unknown when the log is missing', async () => {
    const report = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: () => ({ state: 'missing', text: '' }),
      du: () => '100\t/runs\n',
    });
    expect(report).toMatchObject({
      source: 'missing', samples: 0, freeGbNow: null,
      gbPerHour: null, hoursUntilTargetFreeGb: null, largestSubdirs: [],
    });
  });

  it('leaves largestSubdirs null when du cannot run', async () => {
    const report = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(240, 140), leader(0, 120)]),
      du: () => { throw new Error('du failed'); },
    });
    expect(report.largestSubdirs).toBeNull();
    expect(report.gbPerHour).toBe(5);
  });

  it('combines both readers into one report', async () => {
    const report = await readFleetDisk({
      now: NOW, runsRoot: RUNS,
      readEvents: events([leader(180, 141), leader(0, 137)]),
      du: duText([[900, RUNS], [50_000_000, `${RUNS}/wt`], [2_000_000, `${RUNS}/logs`], [1_000_000, `${RUNS}/queue`]]),
    });
    expect(report).toMatchObject({ source: 'healthy', samples: 2, freeGbNow: 137 });
    expect(report.largestSubdirs!.map((d) => d.name)).toEqual(['wt', 'logs', 'queue']);
  });
});

describe('formatFleetDisk plain words', () => {
  const report = (over: Partial<Parameters<typeof formatFleetDisk>[0]> = {}) =>
    formatFleetDisk({
      schema: 'fleet.disk.v1', generatedAt: new Date(NOW).toISOString(), runsDir: RUNS,
      windowHours: 12, targetFreeGb: 100, source: 'healthy', samples: 2,
      freeGbNow: 120, firstFreeGb: 140, observedHours: 4, gbPerHour: 5,
      hoursUntilTargetFreeGb: 4, largestSubdirs: [{ name: 'wt', gb: 84.2 }],
      ...over,
    });

  it('prints one line per fact', () => {
    expect(report()).toEqual([
      'disk free now: 120 GB',
      'readings: 2 in the last 12 hours',
      'use rate: 5 GB per hour',
      '100 GB free in: 4 hours',
      `largest folders under ${RUNS}:`,
      '  wt: 84.2 GB',
    ]);
  });

  it('says <0.1 GB for a measured-but-tiny folder, never "unknown"', () => {
    expect(report({ largestSubdirs: [{ name: 'queue', gb: 0 }] }).at(-1)).toBe('  queue: <0.1 GB');
  });

  it('prints unknown — never zero — when nothing was read', () => {
    expect(report({
      source: 'missing', samples: 0, freeGbNow: null, firstFreeGb: null,
      observedHours: null, gbPerHour: null, hoursUntilTargetFreeGb: null, largestSubdirs: null,
    })).toEqual([
      'disk free now: unknown',
      'readings: 0 in the last 12 hours',
      'use rate: unknown',
      '100 GB free in: unknown',
      `largest folders under ${RUNS}:`,
      '  unknown',
    ]);
  });

  it('says not at this rate when free space is not shrinking', () => {
    expect(report({ gbPerHour: -1, hoursUntilTargetFreeGb: null })).toContain('100 GB free in: not at this rate');
    expect(report({ gbPerHour: -1, hoursUntilTargetFreeGb: null })).toContain('use rate: not shrinking');
  });
});

describe('cmdFleetDisk', () => {
  const goodDeps: FleetDiskDeps = {
    now: NOW, runsRoot: RUNS,
    readEvents: events([leader(240, 140), leader(0, 120)]),
    du: duText([[900, RUNS], [50_000_000, `${RUNS}/wt`]]),
  };

  it('prints the JSON schema and the human lines', async () => {
    const json = await run(['--json'], goodDeps);
    expect(json.code).toBe(0);
    expect(json.report).toMatchObject({
      schema: 'fleet.disk.v1', windowHours: 12, source: 'healthy',
      samples: 2, freeGbNow: 120, gbPerHour: 5, hoursUntilTargetFreeGb: 4,
      largestSubdirs: [{ name: 'wt', gb: 51.2 }],
    });
    const plain = await run([], goodDeps);
    expect(plain.code).toBe(0);
    expect(plain.logs).toContain('disk free now: 120 GB');
    expect(plain.logs.at(-1)).toBe('  wt: 51.2 GB');
  });

  it('prints unknown and still exits 0 when the log cannot be read', async () => {
    const { code, logs, report } = await run(['--json'], {
      ...goodDeps, readEvents: () => ({ state: 'missing' as const, text: '' }),
    });
    expect(code).toBe(0);
    expect(report).toMatchObject({ source: 'missing', freeGbNow: null, gbPerHour: null });
    const plain = await run([], { ...goodDeps, readEvents: () => ({ state: 'missing' as const, text: '' }) });
    expect(plain.logs[0]).toBe('disk free now: unknown');
    expect(plain.logs).not.toContain('disk free now: 0 GB');
  });

  it('survives both readers failing', async () => {
    const { code, logs } = await run([], {
      now: NOW, runsRoot: RUNS,
      readEvents: () => { throw new Error('io'); },
      du: () => { throw new Error('no du'); },
    });
    expect(code).toBe(0);
    expect(logs[0]).toBe('disk free now: unknown');
    expect(logs.at(-1)).toBe('  unknown');
  });

  it('accepts --runs-dir and rejects bad arguments', async () => {
    const seen: string[] = [];
    const { code } = await run(['--runs-dir', '/fixture/runs', '--json'], {
      now: NOW,
      readEvents: (p) => { seen.push(p); return { state: 'healthy' as const, text: leader(5, 137) }; },
      du: () => '1\t/fixture/runs\n',
    });
    expect(code).toBe(0);
    expect(seen[0]).toBe('/fixture/runs/queue/dispatch-events.log');
    for (const argv of [
      ['--bogus'], ['--json', '--json'], ['--runs-dir'], ['--runs-dir', 'relative/path'],
      ['--runs-dir', '/a', '--runs-dir', '/b'],
    ]) {
      expect((await run(argv, goodDeps)).code, argv.join(' ')).toBe(2);
    }
    expect((await run(['--help'])).code).toBe(0);
    expect((await run(['-h'])).code).toBe(0);
  });
});
