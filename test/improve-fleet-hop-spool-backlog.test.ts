import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FLEET_HOP_SPOOL_BACKLOG_MAX_ITEMS,
  FLEET_HOP_SPOOL_MIN_DAYS,
  FLEET_HOP_SPOOL_MIN_ROWS,
  FLEET_HOP_SPOOL_TAIL_BYTES,
  fleetHopSpoolCells,
  fleetHopSpoolBacklogItems,
  foldFleetHopSpool,
} from '../src/core/improve/fleet-hop-spool-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Fixed reference instant; fixture timestamps are ISO-8601 UTC like the writer's. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/** One spooled fleet_hop event in the writer's FleetHopEvent shape. */
function hopRow(spec: {
  atMs?: number;
  station?: string;
  test?: boolean;
  timestamp?: string | null;
  event?: string;
  distinctId?: string | null;
  properties?: unknown;
} = {}): string {
  const atMs = spec.atMs ?? NOW_MS;
  const timestamp = spec.timestamp === undefined ? iso(atMs) : spec.timestamp;
  const event = spec.event ?? 'fleet_hop';
  const distinctId = spec.distinctId === undefined ? 'agent:claude' : spec.distinctId;
  const properties = spec.properties === undefined
    ? {
      schema: 'queue.v1',
      station: spec.station ?? 'merged',
      job_id: 'job-1',
      pr: 42,
      enter_ts: iso(atMs - HOUR),
      exit_ts: iso(atMs),
      pool: 'claude',
      tokens: 1234,
      usd: 0.05,
      test: spec.test === true,
      $insert_id: 'a'.repeat(32),
      $process_person_profile: false,
    }
    : spec.properties;
  return JSON.stringify({ event, distinct_id: distinctId, timestamp, properties });
}

/**
 * Pending rows spread across `days` distinct UTC days — every row is a
 * hop still awaiting delivery, so there is no window to satisfy.
 */
function hopSeries(opts: { days: number; perDay?: number; station?: string; test?: boolean } = { days: 2 }): string[] {
  const rows: string[] = [];
  const perDay = opts.perDay ?? 1;
  for (let d = 0; d < opts.days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(hopRow({
        atMs: NOW_MS - d * DAY - i * HOUR - HOUR,
        station: opts.station,
        test: opts.test,
      }));
    }
  }
  return rows;
}

/** The production fold: one spool text (the single append-only file). */
function foldRows(rows: string[]) {
  return foldFleetHopSpool([rows.join('\n')]);
}

describe('foldFleetHopSpool', () => {
  it('counts pending hops and skips foreign shapes without guessing', () => {
    const rows = [
      hopRow({ atMs: NOW_MS - HOUR, station: 'merged' }),
      hopRow({ atMs: NOW_MS - 2 * HOUR, station: 'ci', test: true }),
      // Far past — still pending state, so age never disqualifies a row.
      hopRow({ atMs: NOW_MS - 40 * DAY, station: 'review' }),
      // Malformed JSON and non-object rows.
      'not json at all',
      '[1,2,3]',
      'null',
      // Foreign shapes — the writer's contract rejects them all.
      hopRow({ event: 'other_event' }),
      hopRow({ timestamp: null }),
      hopRow({ timestamp: 'not-a-date' }),
      hopRow({ distinctId: null }),
      hopRow({ distinctId: 'x'.repeat(300) }),
      hopRow({ properties: null }),
      hopRow({ properties: 'queue.v1' }),
      hopRow({ properties: { schema: 'queue.v2', station: 'merged' } }),
      hopRow({ properties: { schema: 'queue.v1', station: '' } }),
      hopRow({ properties: { schema: 'queue.v1', station: 'has space' } }),
      hopRow({ properties: { schema: 'queue.v1', station: 'x'.repeat(130) } }),
      '{"event":"fleet_hop","timestamp":"2026',
      '',
    ];
    const fold = foldRows(rows);
    expect(fold.hops).toBe(3);
    expect(fold.testHops).toBe(1);
    expect(fold.stations.size).toBe(3);
    // Two rows park on the fixture day; the 40-day-old row is its own UTC day.
    expect(fold.days.size).toBe(2);
    expect(fold.malformed).toBe(15);
    expect(fold.firstMs).toBe(NOW_MS - 40 * DAY);
    expect(fold.lastMs).toBe(NOW_MS - HOUR);
  });

  it('treats test:false and absent test flags as real traffic', () => {
    const rows = [
      hopRow({ atMs: NOW_MS - DAY, test: false }),
      JSON.stringify({
        event: 'fleet_hop', distinct_id: 'station:merged', timestamp: iso(NOW_MS),
        properties: { schema: 'queue.v1', station: 'merged' },
      }),
    ];
    const fold = foldRows(rows);
    expect(fold.hops).toBe(2);
    expect(fold.testHops).toBe(0);
  });
});

describe('fleetHopSpoolCells', () => {
  it('emits only at the row/day bars', () => {
    // Below bars: too few pending rows even across enough days.
    const twoRows = [hopRow({ atMs: NOW_MS - DAY }), hopRow({ atMs: NOW_MS - 2 * DAY })];
    expect(fleetHopSpoolCells(foldRows(twoRows))).toEqual([]);

    // Below bars: enough rows but all parked on one UTC day.
    const sameDay = [
      hopRow({ atMs: NOW_MS - HOUR }),
      hopRow({ atMs: NOW_MS - 2 * HOUR }),
      hopRow({ atMs: NOW_MS - 3 * HOUR }),
      hopRow({ atMs: NOW_MS - 4 * HOUR }),
    ];
    expect(foldRows(sameDay).days.size).toBe(1);
    expect(fleetHopSpoolCells(foldRows(sameDay))).toEqual([]);

    // At the bars: rows + days → emits one cell carrying the evidence.
    const good = foldRows([
      ...hopSeries({ days: FLEET_HOP_SPOOL_MIN_DAYS, perDay: FLEET_HOP_SPOOL_MIN_ROWS - 1, station: 'merged' }),
      hopRow({ atMs: NOW_MS - 5 * DAY, station: 'ci', test: true }),
    ]);
    const cells = fleetHopSpoolCells(good, { lowerBound: true, spoolBytes: 12345 });
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell).toMatchObject({
      kind: 'fleet-hop-spool',
      hops: 2 * (FLEET_HOP_SPOOL_MIN_ROWS - 1) + 1,
      testHops: 1,
      stations: 2,
      spoolBytes: 12345,
      lowerBound: true,
    });
    expect(cell.days.length).toBeGreaterThanOrEqual(FLEET_HOP_SPOOL_MIN_DAYS);
    expect(cell.stationSample).toEqual(['ci', 'merged']);
    expect(cell.firstSeen).toBe(iso(NOW_MS - 5 * DAY));
    expect(cell.lastSeen).not.toBeNull();
    expect(fleetHopSpoolCells(good)[0]!.lowerBound).toBe(false);
    expect(fleetHopSpoolCells(good)[0]!.spoolBytes).toBeNull();
  });
});

describe('fleetHopSpoolBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'fleet-hop-spool-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(home, { recursive: true, force: true });
  });

  /** A spool file under the temp home carrying the given rows. */
  async function spool(name: string, rows: string[]): Promise<string> {
    const dir = join(home, 'telemetry');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one grounded item for a recurring spool', async () => {
    const rows = [
      ...hopSeries({ days: 3, perDay: 2, station: 'merged' }),
      ...hopSeries({ days: 2, perDay: 1, station: 'ci' }),
      hopRow({ atMs: NOW_MS - 4 * DAY, station: 'review', test: true }),
    ];
    const path = await spool('fleet-hop-spool', rows);
    const items = await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: path });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^fleet-hop-[0-9a-f]{16}$/);
    expect(item).toMatchObject({ area: 'fleet-telemetry', priority: 3, repo: 'ashlrai/phantom' });
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('telemetry spool');
    expect(item.prompt).toContain('fleet-hop-spool.jsonl');
    expect(item.prompt).toContain('fleet_hop');
    expect(item.prompt).toContain('POSTHOG_AGENT_FLEET_TOKEN');
    expect(item.prompt).toContain('queue.v1');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('UTC day(s)');
    expect(item.prompt).not.toContain('lower bound');
    // The env var name is named; no value-shaped material is quoted.
    expect(item.prompt).not.toContain('phc_');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: join(home, 'nope', 'fleet-hop-spool.jsonl') })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, 'telemetry', 'fleet-hop-spool.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: dirPath })).toEqual([]);

    // Another repository never inherits this install's telemetry spool.
    const thin = hopSeries({ days: 3, perDay: 2 });
    const thinPath = await spool('spool-thin', thin);
    expect(await fleetHopSpoolBacklogItems({ repo: 'ashlrai/lexicon', spoolPath: thinPath })).toEqual([]);
    expect(await fleetHopSpoolBacklogItems({ repo: '', spoolPath: thinPath })).toEqual([]);
    expect(await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: thinPath })).not.toEqual([]);

    // Rows below the recurring bars emit nothing.
    const sparse = [hopRow({ atMs: NOW_MS - DAY }), hopRow({ atMs: NOW_MS - 2 * DAY }), 'not json at all'];
    const sparsePath = await spool('spool-sparse', sparse);
    expect(await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: sparsePath })).toEqual([]);

    // All-malformed content emits nothing.
    const junkPath = await spool('spool-junk', ['not json', '{}', '[1]']);
    expect(await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: junkPath })).toEqual([]);
  });

  it('states truncation as a lower bound and reports the file size', async () => {
    const rows = hopSeries({ days: 3, perDay: 2 });
    // Pad past the tail bound so the read reports truncated.
    const pad = 'x'.repeat(FLEET_HOP_SPOOL_TAIL_BYTES + 1024);
    const path = await spool('fleet-hop-spool-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom', spoolPath: path });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
    expect(items[0]!.prompt).toContain('bytes');
  });

  it('derives a stable id and honours the limit', async () => {
    const path = await spool('fleet-hop-spool-stable', hopSeries({ days: 4, perDay: 2 }));
    const opts = { repo: 'ashlrai/phantom', spoolPath: path };
    const first = await fleetHopSpoolBacklogItems(opts);
    const second = await fleetHopSpoolBacklogItems(opts);
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await fleetHopSpoolBacklogItems({ ...opts, limit: FLEET_HOP_SPOOL_BACKLOG_MAX_ITEMS });
    expect(limited).toHaveLength(1);
  });

  it('reads the default spool path under the relocated home', async () => {
    // fleetHopSpoolPath() resolves ~/.ashlr/telemetry/fleet-hop-spool.jsonl
    // through homedir(), which the relocated HOME above controls.
    const dir = join(home, '.ashlr', 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'fleet-hop-spool.jsonl'), hopSeries({ days: 3, perDay: 2 }).join('\n') + '\n');
    const items = await fleetHopSpoolBacklogItems({ repo: 'ashlrai/phantom' });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('fleet-hop-')).toBe(true);
  });

  it('appends the spool item through discovery and dedupes on refresh', async () => {
    // discoverBacklog has no clock option, but the fold is pending state —
    // rows of any age count, so fixed timestamps work here.
    const dir = join(home, '.ashlr', 'telemetry');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'fleet-hop-spool.jsonl'),
      [
        ...hopSeries({ days: 3, perDay: 2, station: 'merged' }),
        hopRow({ atMs: NOW_MS - 6 * DAY, station: 'ci' }),
      ].join('\n') + '\n',
    );
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const spoolItems = first.items.filter((i) => i.id.startsWith('fleet-hop-'));
    expect(spoolItems).toHaveLength(1);
    expect(spoolItems[0]!.area).toBe('fleet-telemetry');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(spoolItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-hop-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-hop-'))).toHaveLength(1);
  });
});
