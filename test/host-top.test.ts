/** `phm host top`: canned ps, vm_stat and disk readings in, typed buckets and one plain line out. Nothing here runs a command or reads the real home. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdHost } from '../src/cli/host.js';
import {
  HOST_TOP_BUCKETS, buildHostTop, describeHostTop, diskTrend, hostDiskWarningLine, parseDiskHistory, readDiskSamples, readHostTopReport,
  type HostTopBucketId, type HostTopInput, type HostTopReport,
} from '../src/core/fleet/host-top.js';
import { createFleetMemoryApi, VERSE_FLEET_HOST_TOP_PATH } from '../src/core/verse/fleet-memory-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', 'host-top', `${name}.txt`), 'utf8');
const GB = 1024 ** 3;
const HOUR = 3600;
const UNKNOWN_DISK = { freeGb: null, gbPerHour: null, direction: 'unknown', floorGb: 100, hoursToFloor: null, warnUnderHours: 12, warning: null, samples: 0, observedAt: null };
const SWAP = 'vm.swapusage: total = 11264.00M  used = 10444.80M  free = 819.20M  (encrypted)';
const input = (over: Partial<HostTopInput> = {}): HostTopInput => ({
  psText: fixture('busy-mac'), jobRoots: [{ jobId: 'RQ-ONE', pid: 300 }], load: { load1: 41.23, load5: 38, cores: 18 },
  vmStatText: fixture('vm-stat'), swapText: SWAP, pressureText: '2\n', totalBytes: 64 * GB, frontApp: '/Applications/Cursor.app',
  diskSamples: [{ at: 0, freeGb: 412 }], now: 0, ...over,
});
const bucket = (report: HostTopReport, id: HostTopBucketId) => report.buckets.find(b => b.id === id)!;
const brief = (report: HostTopReport) => Object.fromEntries(report.buckets.map(b => [b.id, [b.cpuPercent, b.rssMb, b.processes]]));
const APPS = ['Docker', 'Claude', 'Codex', 'ChatGPT', 'Cursor', 'Grok', 'Google Chrome', 'Phantom', 'Notes'].map(name => `/Applications/${name}.app`);

describe('buildHostTop', () => {
  it('puts every process in one plain bucket, with unknown commands under Other', () => {
    const report = buildHostTop(input());
    expect(brief(report)).toEqual({
      'fleet-workers': [41, 500, 2], 'local-models': [90, 8192, 1], docker: [300, 22528, 2], claude: [45, 1636, 3], codex: [10, 300, 1],
      chatgpt: [2, 200, 1], cursor: [50, 2048, 1], grok: [1, 100, 1], chrome: [100, 5120, 2], phantom: [4, 600, 1], 'other-apps': [3, 300, 1],
      indexing: [80, 300, 2], system: [30.5, 520, 2], other: [8, 53, 3],
    });
    expect(bucket(report, 'other').items.map(item => item.name)).toEqual(['syncer', 'orphan', 'mystery']);
    expect(bucket(report, 'fleet-workers').items).toEqual([{ name: 'RQ-ONE', cpuPercent: 41, rssMb: 500, processes: 2 }]);
    expect(bucket(report, 'other-apps').items[0]!.name).toBe('Notes');
    // A plain node under an app counts with that app; biggest first.
    expect(bucket(report, 'claude').items.map(item => item.name)).toEqual(['Claude', 'Claude Helper', 'node']);
    expect(report.buckets.slice(0, 3).map(b => [b.id, b.sharePercent])).toEqual([['docker', 34], ['local-models', 13], ['chrome', 8]]);
    expect(report.buckets.map(b => b.id).sort()).toEqual(HOST_TOP_BUCKETS.map(b => b.id).sort());
  });

  it('has totals that are exactly the sum of the buckets', () => {
    for (const name of ['busy-mac', 'phantom-heavy', 'quiet-mac']) {
      const report = buildHostTop(input({ psText: fixture(name) }));
      const sum = (key: 'cpuPercent' | 'rssMb' | 'processes') => Math.round(report.buckets.reduce((total, b) => total + b[key], 0) * 10) / 10;
      expect(report.totals).toEqual({ cpuPercent: sum('cpuPercent'), rssMb: sum('rssMb'), processes: sum('processes') });
      expect(report.totals.processes).toBe(fixture(name).trim().split('\n').length - 1);
    }
    expect(buildHostTop(input()).totals).toEqual({ cpuPercent: 764.5, rssMb: 42397, processes: 23 });
  });

  it('names the biggest consumer and one suggested action in plain words', () => {
    const report = buildHostTop(input());
    expect(report.biggest).toBe('docker');
    expect(report.suggestion).toEqual({ line: 'Docker is using 22 GB and 300% CPU; quit it if no lane needs it.', bucket: 'docker', action: 'quit' });
    expect(report.frontApp).toBe('Cursor');
    expect(report.state).toBe('known');
  });

  it('never suggests quitting the app in front: it names it, then moves to the next', () => {
    const report = buildHostTop(input({ frontApp: '/Applications/Docker.app/' }));
    expect(report.biggest).toBe('docker');
    expect(report.suggestion).toEqual({
      line: 'Docker is using 22 GB and 300% CPU. It is the app in front, so no change is suggested. Next: The local model server is using 8.0 GB and 90% CPU; stop it if no lane needs it.',
      bucket: 'local-models', action: 'stop',
    });
  });

  it('never suggests quitting Phantom, even when it is the biggest', () => {
    const report = buildHostTop(input({ psText: fixture('phantom-heavy'), jobRoots: [], frontApp: '/Applications/Google Chrome.app' }));
    expect(report.suggestion).toEqual({ line: 'Phantom is using 12 GB and 400% CPU. No change is suggested for Phantom itself.', bucket: null, action: null });
    const cursorFront = buildHostTop(input({ psText: fixture('phantom-heavy'), jobRoots: [], frontApp: '/Applications/Cursor.app' }));
    expect(cursorFront.suggestion).toMatchObject({ bucket: 'chrome', action: 'quit' });
    expect(cursorFront.suggestion.line).toBe('Phantom is using 12 GB and 400% CPU. No change is suggested for Phantom itself. Next: Chrome is using 8.0 GB and 120% CPU; close tabs, or quit it if you are not using it.');
    // This process and its children are Phantom too.
    expect(bucket(buildHostTop(input({ selfPid: 600 })), 'phantom').processes).toBe(2);
  });

  it('holds for every fixture and every app in front: no suggestion for Phantom or the front app', () => {
    for (const name of ['busy-mac', 'phantom-heavy', 'quiet-mac']) for (const frontApp of [...APPS, null]) {
      const report = buildHostTop(input({ psText: fixture(name), frontApp }));
      const frontBucket = frontApp === null ? null : buildHostTop(input({ psText: `1 0 1.0 1024 ${frontApp}/Contents/MacOS/app` })).biggest;
      expect(report.suggestion.bucket).not.toBe('phantom');
      if (frontBucket) expect(report.suggestion.bucket).not.toBe(frontBucket);
      // With the front app unknown, quitting is never suggested at all.
      if (frontApp === null) expect(report.suggestion.action).not.toBe('quit');
      expect(report.suggestion.line).not.toMatch(/(?:quit|stop|close) Phantom/i);
    }
  });

  it('says so when nothing is using much, and suggests nothing', () => {
    const report = buildHostTop(input({ psText: fixture('quiet-mac'), jobRoots: [] }));
    expect(report.suggestion).toEqual({ line: 'Nothing is using much of this Mac. The largest is Cursor, using 500 MB and 3% CPU.', bucket: null, action: null });
  });

  it('reads load, memory pressure, swap, free memory and the free-disk trend, and shows unknown as unknown', () => {
    const known = buildHostTop(input());
    expect(known.host).toEqual({ load1: 41.23, load5: 38, cores: 18, pressure: 'warning', swapUsedGb: 10.2, memoryFreePercent: 6,
      disk: { ...UNKNOWN_DISK, freeGb: 412, samples: 1, observedAt: '1970-01-01T00:00:00.000Z' } });
    expect(describeHostTop(known.host)).toBe('Load 41.2 (38 over 5 minutes) on 18 cores · memory pressure warning · swap used 10.2 GB · free disk 412 GB, no trend yet');
    const blind = buildHostTop(input({ jobRoots: null, load: { load1: null, load5: null, cores: null }, vmStatText: null, swapText: 'odd words', pressureText: '3', totalBytes: null, frontApp: null, diskSamples: [] }));
    expect(blind.host).toEqual({ load1: null, load5: null, cores: null, pressure: null, swapUsedGb: null, memoryFreePercent: null, disk: UNKNOWN_DISK });
    expect(describeHostTop(blind.host)).toBe('Load unknown · memory pressure unknown · swap used unknown · free disk unknown');
    expect(blind.state).toBe('partial');
    expect(blind.gaps.slice(0, 7)).toEqual([
      'Fleet job roots are unknown, so fleet workers are counted under other buckets.', 'The app in front is unknown.', 'Load is unknown.',
      'Memory pressure is unknown.', 'Swap used is unknown.', 'Free memory is unknown.', 'Free disk is unknown.',
    ]);
    // Without job roots the worker tree is not claimed for the fleet, and without a front app nothing is quit.
    expect(bucket(blind, 'fleet-workers').processes).toBe(0);
    expect(blind.suggestion).toEqual({
      line: 'Docker is using 22 GB and 300% CPU. The app in front is unknown, so quitting is not suggested. Next: The local model server is using 8.0 GB and 90% CPU; stop it if no lane needs it.',
      bucket: 'local-models', action: 'stop',
    });
    const none = buildHostTop(input({ psText: null }));
    expect(none).toMatchObject({ state: 'unknown', biggest: null, totals: { cpuPercent: 0, rssMb: 0, processes: 0 } });
    expect(none.suggestion.line).toBe('What is using this Mac is unknown: the process list could not be read.');
  });
});

describe('diskTrend', () => {
  it('reads a falling trend: GB per hour, hours to the floor, and a warning under 12 hours', () => {
    expect(diskTrend([{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 340 }], 100, 3 * HOUR * 1000)).toEqual({
      freeGb: 340, gbPerHour: 30, direction: 'falling', floorGb: 100, hoursToFloor: 8, warnUnderHours: 12,
      warning: 'under-warn-hours', samples: 2, observedAt: '1970-01-01T02:00:00.000Z',
    });
    expect(hostDiskWarningLine(diskTrend([{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 340 }], 100, 3 * HOUR * 1000)))
      .toBe('Warning: free disk is 340 GB, falling 30.0 GB an hour; it reaches the 100 GB floor in about 8 hours.');
  });

  it('stays quiet when the floor is far away, and measures hours against the floor it is given', () => {
    expect(diskTrend([{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 394 }], 100, 2 * HOUR * 1000))
      .toMatchObject({ gbPerHour: 3, direction: 'falling', hoursToFloor: 98, warning: null });
    expect(diskTrend([{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 340 }], 250, 3 * HOUR * 1000))
      .toMatchObject({ floorGb: 250, hoursToFloor: 3, warning: 'under-warn-hours' });
    expect(hostDiskWarningLine(diskTrend([{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 394 }], 100, 2 * HOUR * 1000))).toBe(null);
  });

  it('warns below the floor even without a trend', () => {
    expect(diskTrend([{ at: 0, freeGb: 96.4 }], 100, HOUR * 1000))
      .toMatchObject({ freeGb: 96.4, direction: 'unknown', hoursToFloor: 0, warning: 'below-floor' });
  });

  it('reads holding steady when the readings barely move', () => {
    expect(diskTrend([{ at: 0, freeGb: 400.02 }, { at: HOUR, freeGb: 400.05 }, { at: 2 * HOUR, freeGb: 399.98 }], 100, 2 * HOUR * 1000))
      .toMatchObject({ freeGb: 400, direction: 'flat', gbPerHour: null, hoursToFloor: null, warning: null });
  });

  it('reads rising after a cleanup, measured from the cleanup onward', () => {
    const trend = diskTrend([{ at: 0, freeGb: 400 }, { at: HOUR, freeGb: 380 }, { at: 2 * HOUR, freeGb: 460 }, { at: 3 * HOUR, freeGb: 480 }], 100, 3 * HOUR * 1000);
    expect(trend).toMatchObject({ freeGb: 480, gbPerHour: -50, direction: 'rising', hoursToFloor: null, warning: null, samples: 4 });
    expect(describeHostTop(buildHostTop(input({ now: 4 * HOUR * 1000, diskSamples: [{ at: HOUR, freeGb: 380 }, { at: 3 * HOUR, freeGb: 480 }] })).host))
      .toBe('Load 41.2 (38 over 5 minutes) on 18 cores · memory pressure warning · swap used 10.2 GB · free disk 480 GB, rising 50.0 GB an hour');
  });

  it('says one reading is no trend yet, and empty input is unknown', () => {
    expect(diskTrend([{ at: HOUR, freeGb: 412 }], 100, 2 * HOUR * 1000))
      .toMatchObject({ freeGb: 412, gbPerHour: null, direction: 'unknown', hoursToFloor: null, warning: null, samples: 1 });
    expect(diskTrend([], 100, HOUR * 1000)).toEqual(UNKNOWN_DISK);
  });

  it('ignores damaged readings and keeps the last row for a repeated time', () => {
    const readings = [
      { at: -5, freeGb: 900 }, { at: 5 * HOUR, freeGb: 900 }, { at: HOUR, freeGb: -1 }, { at: HOUR, freeGb: Number.NaN },
      { at: HOUR, freeGb: 400 }, { at: 2 * HOUR, freeGb: 380 }, { at: 2 * HOUR, freeGb: 370 },
    ];
    expect(diskTrend(readings, 100, 4 * HOUR * 1000)).toMatchObject({ freeGb: 370, gbPerHour: 30, direction: 'falling', samples: 2 });
  });
});

describe('disk readings', () => {
  it('parses the sampler history, skipping rows that are not readings', () => {
    expect(parseDiskHistory(JSON.stringify([
      { at: 0, free_gb: 400, sizes_gb: { '/x': 1 } }, { at: 3600 }, 'junk', null, { at: 'soon', free_gb: 1 }, { at: 7200, free_gb: 370.5 },
    ]))).toEqual([{ at: 0, freeGb: 400 }, { at: 7200, freeGb: 370.5 }]);
    expect(parseDiskHistory(null)).toEqual([]);
    expect(parseDiskHistory('not json')).toEqual([]);
    expect(parseDiskHistory('{"at": 1}')).toEqual([]);
  });

  it('adds one live reading to the sampler history, and works with neither', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'host-top-disk-'));
    try {
      mkdirSync(join(runs, 'queue'), { recursive: true });
      writeFileSync(join(runs, 'queue', 'disk-growth-history.json'), JSON.stringify([{ at: 0, free_gb: 400 }, { at: HOUR, free_gb: 385 }]));
      expect(await readDiskSamples(runs, async () => ({ at: 2 * HOUR, freeGb: 370 }))).toEqual([
        { at: 0, freeGb: 400 }, { at: HOUR, freeGb: 385 }, { at: 2 * HOUR, freeGb: 370 },
      ]);
      expect(await readDiskSamples(runs, async () => null)).toEqual([{ at: 0, freeGb: 400 }, { at: HOUR, freeGb: 385 }]);
      expect(await readDiskSamples(join(runs, 'nowhere'), async () => null)).toEqual([]);
    } finally { rmSync(runs, { recursive: true, force: true }); }
  });
});

describe('phm host top', () => {
  const texts: Record<string, string> = { vm_stat: fixture('vm-stat'), 'sysctl vm.swapusage': SWAP, 'sysctl -n kern.memorystatus_vm_pressure_level': '1' };
  const deps = (ps: string | null, out: string[], over: { now?: () => number; diskSamples?: () => Promise<{ at: number; freeGb: number }[]> } = {}) => ({
    ps: async () => ps, jobRoots: () => [{ jobId: 'RQ-ONE', pid: 300 }], load: () => ({ load1: 41.23, load5: 38, load15: 30, cores: 18, ratio: 2.3 }),
    run: async (file: string, args: string[]) => texts[[file.split('/').pop(), ...args].join(' ')] ?? null,
    frontApp: async () => '/Applications/Cursor.app', totalBytes: 64 * GB, selfPid: 0, now: () => 0,
    diskSamples: async () => [{ at: 0, freeGb: 412 }], write: (text: string) => { out.push(text); }, ...over,
  });

  it('prints schema and version in JSON, and the same line for people', async () => {
    const json: string[] = [], human: string[] = [], groups: string[] = [];
    expect(await cmdHost(['top', '--json'], deps(fixture('busy-mac'), json))).toBe(0);
    const report = JSON.parse(json.join('')) as HostTopReport;
    expect(report).toMatchObject({ schema: 'host.top.v1', version: 1, generatedAt: '1970-01-01T00:00:00.000Z', state: 'known', biggest: 'docker', host: { pressure: 'normal', swapUsedGb: 10.2 } });
    expect(Object.keys(report)).toEqual(['schema', 'version', 'generatedAt', 'state', 'host', 'totals', 'buckets', 'frontApp', 'biggest', 'suggestion', 'gaps']);
    expect(Object.keys(report.host)).toEqual(['load1', 'load5', 'cores', 'pressure', 'swapUsedGb', 'memoryFreePercent', 'disk']);
    expect(report.host.disk).toEqual({ ...UNKNOWN_DISK, freeGb: 412, samples: 1, observedAt: '1970-01-01T00:00:00.000Z' });
    expect(Object.keys(report.buckets[0]!)).toEqual(['id', 'name', 'cpuPercent', 'rssMb', 'processes', 'items', 'sharePercent']);
    expect(await cmdHost(['top'], deps(fixture('busy-mac'), human))).toBe(0);
    const lines = human.join('').split('\n');
    expect(lines.slice(0, 3)).toEqual(['Load 41.2 (38 over 5 minutes) on 18 cores · memory pressure normal · swap used 10.2 GB · free disk 412 GB, no trend yet', report.suggestion.line, 'App in front: Cursor']);
    expect(lines).toContainEqual(expect.stringMatching(/^Docker\s+300\.0\s+22 GB\s+2$/));
    expect(lines).toContainEqual(expect.stringMatching(/^Total\s+764\.5\s+41 GB\s+23$/));
    expect(lines.some(line => line.startsWith('  '))).toBe(false);
    expect(await cmdHost(['top', '--groups'], deps(fixture('busy-mac'), groups))).toBe(0);
    expect(groups.join('').split('\n')).toContainEqual(expect.stringMatching(/^ {2}com\.docker\.virtualization\s+295\.0\s+22 GB\s+1$/));
  });

  it('shows the free-disk trend against a floor it is given, as a warning line when it is close', async () => {
    const over = { now: () => 4 * HOUR * 1000, diskSamples: async () => [{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 340 }] };
    const json: string[] = [], human: string[] = [];
    expect(await cmdHost(['top', '--json', '--floor', '250'], deps(fixture('busy-mac'), json, over))).toBe(0);
    expect(JSON.parse(json.join('')).host.disk).toEqual({ ...UNKNOWN_DISK, freeGb: 340, gbPerHour: 30, direction: 'falling', floorGb: 250, hoursToFloor: 3, warning: 'under-warn-hours', samples: 2, observedAt: '1970-01-01T02:00:00.000Z' });
    expect(await cmdHost(['top', '--floor', '250'], deps(fixture('busy-mac'), human, over))).toBe(0);
    const lines = human.join('').split('\n');
    // A disk heading for its floor too soon leaves the host line for its own warning line.
    expect(lines[0]).toBe('Load 41.2 (38 over 5 minutes) on 18 cores · memory pressure normal · swap used 10.2 GB');
    expect(lines[1]).toBe('Warning: free disk is 340 GB, falling 30.0 GB an hour; it reaches the 250 GB floor in about 3 hours.');
  });

  it('keeps a far-off floor in the host line, with no warning', async () => {
    const human: string[] = [];
    const over = { now: () => 4 * HOUR * 1000, diskSamples: async () => [{ at: 0, freeGb: 400 }, { at: 2 * HOUR, freeGb: 394 }] };
    expect(await cmdHost(['top'], deps(fixture('busy-mac'), human, over))).toBe(0);
    expect(human.join('').split('\n')[0]).toBe('Load 41.2 (38 over 5 minutes) on 18 cores · memory pressure normal · swap used 10.2 GB · free disk 394 GB, falling 3.0 GB an hour, about 98 hours to the 100 GB floor');
  });

  it('exits 1 when ps cannot be read, 2 on bad usage, and never throws when every read fails', async () => {
    const out: string[] = [];
    expect(await cmdHost(['top', '--json'], deps(null, out))).toBe(1);
    expect(JSON.parse(out.join(''))).toMatchObject({ state: 'unknown', biggest: null });
    expect(await cmdHost(['top', '--kill'], deps('', out))).toBe(2);
    expect(await cmdHost(['top', '--json', '--json'], deps('', out))).toBe(2);
    for (const bad of [['--floor'], ['--floor', 'lots'], ['--floor', '-1'], ['--floor', '100', '--floor', '100'], ['--floor', '100', '--json', '--json']]) {
      expect(await cmdHost(['top', ...bad], deps('', out))).toBe(2);
    }
    const fail = () => Promise.reject(new Error('denied'));
    const failing = await readHostTopReport({ ps: fail, run: fail, frontApp: fail, jobRoots: () => { throw new Error('denied'); }, load: () => ({ load1: null, load5: null, load15: null, cores: null, ratio: null }) });
    expect(failing).toMatchObject({ state: 'unknown', frontApp: null, host: { pressure: null, swapUsedGb: null } });
  });

  it('serves the same report to the This Mac card', async () => {
    let status = 0, text = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
    const api = createFleetMemoryApi({ readHostTop: () => readHostTopReport(deps(fixture('busy-mac'), [])) });
    const call = (method: string) => api({ cfg: {} } as VerseApiContext, Object.assign(new PassThrough(), { url: VERSE_FLEET_HOST_TOP_PATH, method }) as IncomingMessage, res, VERSE_FLEET_HOST_TOP_PATH, method);
    expect(await call('GET')).toBe(true);
    expect([status, JSON.parse(text).schema, JSON.parse(text).suggestion.bucket]).toEqual([200, 'host.top.v1', 'docker']);
    expect(await call('POST')).toBe(true);
    expect(status).toBe(405);
  });
});
