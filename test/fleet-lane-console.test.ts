/**
 * RQ-PHANTOM-ENG-CONSOLE — fleet.lanes.v1 engineering-console projection.
 *
 * Contract:
 *   - parseReadyTsv reads header-form, key=value and positional queue exports;
 *     rows that cannot name their pool are dropped, never guessed.
 *   - queue.v1.json is authoritative for live jobs; its READY counts are the
 *     queue-depth fallback when ready.tsv is absent.
 *   - jobs.jsonl merge transitions count per lane inside the trailing window;
 *     a `job` id with no `pool` resolves through the queue's job→pool map.
 *   - The budget ledger is the preferred credit source; the usage journal
 *     fills pools the ledger has never observed.
 *   - Every missing/corrupt input degrades only its own slice — the snapshot
 *     never throws, never fabricates zeros without evidence.
 *   - `phm fleet lanes [--json] --queue-dir <abs>` runs against the fixture
 *     and GET /api/fleet/lanes serves the same projection on loopback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as http from 'node:http';

import {
  getFleetLaneSnapshot,
  parseJobsJsonl,
  parseQueueV1Document,
  parseReadyTsv,
  parseUsageJournals,
  type FleetLaneSnapshot,
} from '../src/core/fleet/lane-console.js';
import { cmdFleet, formatFleetLanes } from '../src/cli/fleet.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const FIXTURE_QUEUE = resolve('test/fixtures/fleet-lanes/queue');
const ANCHOR = new Date('2026-10-28T02:00:00Z');
const fixtureOptions = { queueDir: FIXTURE_QUEUE, usageLogPaths: [join(FIXTURE_QUEUE, 'usage-readings.jsonl')], now: () => ANCHOR } as const;

let scratch: string;
let openHandles: Array<{ close(): Promise<void> }>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'fleet-lanes-'));
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// parseReadyTsv
// ---------------------------------------------------------------------------

describe('parseReadyTsv', () => {
  it('reads the header-form fixture rows', () => {
    const text = [
      '# comment lines are skipped',
      'id\tstatus\tpool\ttier\trepo\tpriority\tat',
      'RQ-1\tREADY\tdevin\twork\tphantom\tP1\t2026-10-28T01:00:00Z',
      'RQ-2\tCLAIMED\tcodex-cmp\twork\tphantom\tP0\t2026-10-28T01:05:00Z',
      '',
    ].join('\n');
    const { rows, dropped } = parseReadyTsv(text);
    expect(dropped).toBe(0);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: 'RQ-1', status: 'READY', pool: 'devin', repo: 'phantom', at: '2026-10-28T01:00:00Z' });
    expect(rows[1]).toMatchObject({ id: 'RQ-2', status: 'CLAIMED', pool: 'codex-cmp' });
  });

  it('reads key=value rows and upcases status', () => {
    const { rows, dropped } = parseReadyTsv(
      'id=RQ-9\tpool=devin\tstatus=pr-open\trepo=phantom\tat=2026-10-28T01:30:00Z\n',
    );
    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({ id: 'RQ-9', pool: 'devin', status: 'PR-OPEN' });
  });

  it('reads positional rows with and without a leading status', () => {
    const { rows, dropped } = parseReadyTsv(
      'READY\tRQ-1\tdevin\twork\tphantom\tP1 fix the thing\n' +
      'RQ-2\tcodex-cmp\twork\tphantom\tP2 another job\n',
    );
    expect(dropped).toBe(0);
    expect(rows[0]).toMatchObject({ id: 'RQ-1', status: 'READY', pool: 'devin' });
    // No status column → the row is a queue row by definition (READY).
    expect(rows[1]).toMatchObject({ id: 'RQ-2', status: 'READY', pool: 'codex-cmp' });
  });

  it('drops rows that cannot name a lane instead of guessing', () => {
    const { rows, dropped } = parseReadyTsv(
      'READY\tRQ-1\tdevin\n' +           // good
      'READY\tRQ-2\tnot a lane!\n' +     // pool fails LANE_ID
      'RQ-3\n' +                        // id only, no pool
      'garbage row with spaces\n',      // unsplittable junk
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pool).toBe('devin');
    expect(dropped).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// parseQueueV1Document
// ---------------------------------------------------------------------------

describe('parseQueueV1Document', () => {
  it('counts live and ready per pool and maps job ids to pools', () => {
    const doc = JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'READY', pool: 'devin' },
        { id: 'RQ-2', status: 'CLAIMED', pool: 'devin' },
        { id: 'RQ-3', status: 'PR-OPEN', pool: 'codex-cmp' },
        { id: 'RQ-4', status: 'DONE', pool: 'local-omlx' },
      ],
    });
    const read = parseQueueV1Document(doc);
    expect(read.jobs).toBe(4);
    expect(read.live.get('devin')).toBe(1);
    expect(read.live.get('codex-cmp')).toBe(1);
    expect(read.ready.get('devin')).toBe(1);
    expect(read.live.has('local-omlx')).toBe(false); // DONE is terminal, not live
    expect(read.jobPool.get('RQ-3')).toBe('codex-cmp');
  });

  it('rejects a non-queue.v1 document and malformed jobs', () => {
    expect(() => parseQueueV1Document('{"schema":"other","jobs":[]}')).toThrow();
    expect(() => parseQueueV1Document('{"schema":"queue.v1","jobs":[{"id":"RQ-1","status":"READY","pool":"bad pool!"}]}')).toThrow();
    expect(() => parseQueueV1Document('not json')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// parseJobsJsonl
// ---------------------------------------------------------------------------

describe('parseJobsJsonl', () => {
  it('marks merge transitions and leaves non-merges false', () => {
    const { events, dropped } = parseJobsJsonl([
      '{"job":"RQ-1","pool":"devin","to":"LAND","at":"2026-10-28T01:40:00Z"}',
      '{"job":"RQ-2","pool":"devin","to":"FAILED","at":"2026-10-28T01:41:00Z"}',
      '{"job":"RQ-3","event":"pr-merge","at":"2026-10-28T01:42:00Z"}',
      '{"job":"RQ-4","status":"merged","at":"2026-10-28T01:43:00Z"}',
      '{"job":"RQ-5","landed":true,"at":"2026-10-28T01:44:00Z"}',
      'not json at all',
    ].join('\n'));
    expect(dropped).toBe(1);
    expect(events).toHaveLength(5);
    expect(events.map(e => e.merge)).toEqual([true, false, true, true, true]);
    expect(events[2]!.pool).toBeNull(); // pool unresolved here — the snapshot layer maps it
  });
});

// ---------------------------------------------------------------------------
// parseUsageJournals
// ---------------------------------------------------------------------------

describe('parseUsageJournals', () => {
  it('keeps the newest row per pool across journals', () => {
    const older = '{"pool":"devin","pctUsed":90,"writtenAt":"2026-10-28T00:00:00Z"}';
    const newer = '{"pool":"devin","pctUsed":36,"writtenAt":"2026-10-28T01:50:00Z"}';
    const { latest, dropped } = parseUsageJournals([older, newer]);
    expect(dropped).toBe(0);
    expect(latest.get('devin')!.pctUsed).toBe(36);
  });

  it('parses status-only rows with null pctUsed and counts malformed lines', () => {
    const { latest, dropped } = parseUsageJournals([
      '{"pool":"terra@cmp","pctUsed":null,"fetchedAt":"2026-10-28T01:50:00Z"}',
      '{"pool":"devin","pctUsed":150,"fetchedAt":"2026-10-28T01:50:00Z"}', // out of range → null
      '{"noPool":true}',
      'broken',
    ]);
    expect(latest.get('terra@cmp')!.pctUsed).toBeNull();
    expect(latest.get('devin')!.pctUsed).toBeNull();
    expect(dropped).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getFleetLaneSnapshot against the committed fixture (anchor 2026-10-28T02:00Z)
// ---------------------------------------------------------------------------

describe('getFleetLaneSnapshot (fixture)', () => {
  it('counts unique PR outcomes by event time across observations and queue rows', async () => {
    const dir = join(scratch, 'queue');
    await mkdir(dir, { recursive: true });
    const url = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
    const rows = [
      { jobId: 'j1', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(1), ts: '2026-10-29T04:37:00Z', reconciledAt: '2026-10-29T07:00:00Z' },
      { jobId: 'j1', pool: 'codex-personal', status: 'MERGED', pr: url(1) + '/', ts: '2026-10-29T00:37:00-04:00' },
      { jobId: 'other', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(1).toUpperCase(), ts: '2026-10-29T04:37:00Z' },
      { jobId: 'j2', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(2), ts: '2026-10-28T23:59:00-05:00' },
      { jobId: 'j2', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(8), ts: '2026-10-29T05:00:00Z' },
      { jobId: 'j3', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(3), ts: '2026-10-29T04:00:00Z' },
      { jobId: 'old', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(4), ts: '2026-10-29T03:59:59Z', reconciledAt: '2026-10-29T04:59:00Z' },
      { jobId: 'future', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(5), ts: '2026-10-29T05:00:01Z' },
      { jobId: 'naive', pool: 'codex-personal', outcome: 'MERGED', prUrl: url(6), ts: '2026-10-29T04:59:00' },
      { jobId: 'closed', pool: 'codex-personal', outcome: 'CLOSED', prUrl: url(7), ts: '2026-10-29T04:59:00Z' },
      { job: 'legacy', pool: 'codex-personal', to: 'LAND', at: '2026-10-29T04:45:00Z' },
      { job: 'legacy', pool: 'codex-personal', event: 'pr-merge', at: '2026-10-29T04:45:00Z' },
    ];
    await writeFile(join(dir, 'jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
    await writeFile(join(dir, 'ready.tsv'), [
      'id\tstatus\tpool\tat',
      'j1\tLAND\tcodex-personal\t2026-10-29T04:37:00Z',
      'legacy\tLAND\tcodex-personal\t2026-10-29T04:45:00Z',
    ].join('\n'));
    const snapshot = await getFleetLaneSnapshot({
      queueDir: dir, budgetsDir: join(scratch, 'budgets'), usageLogPaths: [],
      now: () => new Date('2026-10-29T05:00:00Z'),
    });
    expect(snapshot.lanes.find(l => l.lane === 'codex-personal')!.mergesPerHour).toBe(5);
  });

  it('finds recent event timestamps before a large backfilled ledger tail', async () => {
    const dir = join(scratch, 'queue');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'jobs.jsonl'), [
      JSON.stringify({ jobId: 'recent', pool: 'devin', outcome: 'MERGED', ts: '2026-10-28T01:59:00Z' }),
      JSON.stringify({ jobId: 'old', pool: 'devin', outcome: 'MERGED', ts: '2026-10-27T01:00:00Z', padding: 'x'.repeat(1_100_000) }),
    ].join('\n'));
    const snapshot = await getFleetLaneSnapshot({
      queueDir: dir, budgetsDir: join(scratch, 'budgets'), usageLogPaths: [], now: () => ANCHOR,
    });
    expect(snapshot.lanes.find(l => l.lane === 'devin')!.mergesPerHour).toBe(1);
    expect(snapshot.sources.ledger).toMatchObject({ state: 'healthy', events: 2 });
  });

  it('projects credit, queue depth, live jobs and merges per lane', async () => {
    const snapshot = await getFleetLaneSnapshot(fixtureOptions);
    expect(snapshot.schema).toBe('fleet.lanes.v1');
    expect(snapshot.generatedAt).toBe('2026-10-28T02:00:00.000Z');
    expect(snapshot.mergeWindowMinutes).toBe(60);

    const byLane = new Map(snapshot.lanes.map(l => [l.lane, l]));

    const devin = byLane.get('devin')!;
    expect(devin.queueDepth).toBe(2);          // RQ-FIXTURE-001/002 READY in ready.tsv
    expect(devin.liveJobs).toBe(1);            // RQ-FIXTURE-007 CLAIMED in queue.v1.json
    expect(devin.mergesPerHour).toBe(1);       // RQ-FIXTURE-005 LAND at 01:30 (in window)
    expect(devin.credit).toMatchObject({
      state: 'observed', label: '12.5 ACU', remainingCredits: 12.5,
      creditsUnit: 'acus', source: 'budget-ledger',
    });

    const codex = byLane.get('codex-cmp')!;
    expect(codex.queueDepth).toBe(1);
    expect(codex.liveJobs).toBe(1);            // RQ-FIXTURE-008 PR-OPEN
    expect(codex.mergesPerHour).toBe(1);       // RQ-FIXTURE-008 → LAND at 01:40
    expect(codex.credit.label).toBe('64% weekly · 3 credits');
    expect(codex.credit.remainingPct).toBe(64);

    const local = byLane.get('local-omlx')!;
    expect(local.liveJobs).toBe(1);            // RQ-FIXTURE-009 CLAIMED
    expect(local.mergesPerHour).toBe(1);       // pr-merge event resolved via job→pool map
    expect(local.credit.state).toBe('unknown'); // capacity bucket never observed

    const grok = byLane.get('grok-ultra')!;
    expect(grok.queueDepth).toBe(1);
    expect(grok.liveJobs).toBe(0);
    expect(grok.mergesPerHour).toBe(0);        // FAILED is not a merge; evidence exists → 0 not null
    expect(grok.credit).toMatchObject({
      state: 'observed', label: '64% window', remainingPct: 64,
      burnPerHour: 1.2, source: 'usage-journal',
    });

    const terra = byLane.get('terra@cmp')!;    // usage-journal-only lane
    expect(terra.credit.state).toBe('unknown'); // pctUsed null → honestly unknown
    expect(terra.queueDepth).toBe(0);

    // Out-of-window LAND (20:00 previous day) contributes nothing.
    expect(byLane.get('codex-cmp')!.mergesPerHour).toBe(1);

    // Busiest lanes first; every known budget pool is present.
    expect(snapshot.lanes[0]!.lane).toBe('devin');
    for (const lane of ['codex-cmp', 'codex-personal', 'claude', 'grok-build', 'grok-ultra', 'local-omlx']) {
      expect(byLane.has(lane)).toBe(true);
    }
  });

  it('reports per-source health without leaking absolute paths', async () => {
    const snapshot = await getFleetLaneSnapshot(fixtureOptions);
    expect(snapshot.sources.queue).toMatchObject({ state: 'healthy', file: 'ready.tsv', rows: 6, dropped: 0 });
    expect(snapshot.sources.queueState).toMatchObject({ state: 'healthy', jobs: 8 });
    expect(snapshot.sources.ledger).toMatchObject({ state: 'healthy', events: 6, dropped: 0 });
    expect(snapshot.sources.usage).toMatchObject({ state: 'healthy', pools: 2 });
    expect(snapshot.sources.budgets.state).toBe('healthy');
    expect(JSON.stringify(snapshot)).not.toContain(FIXTURE_QUEUE);
    expect(JSON.stringify(snapshot)).not.toContain(scratch);
  });

  it('degrades cleanly when the queue directory does not exist', async () => {
    const snapshot = await getFleetLaneSnapshot({
      queueDir: join(scratch, 'no-such-queue'),
      budgetsDir: join(scratch, 'no-such-budgets'),
      usageLogPaths: [join(scratch, 'no-such-log')],
      now: () => ANCHOR,
    });
    expect(snapshot.schema).toBe('fleet.lanes.v1');
    expect(snapshot.sources.queue.state).toBe('missing');
    expect(snapshot.sources.queueState.state).toBe('missing');
    expect(snapshot.sources.ledger.state).toBe('missing');
    expect(snapshot.sources.usage.state).toBe('missing');
    for (const lane of snapshot.lanes) {
      expect(lane.queueDepth).toBeNull();   // no source — honest null, not a fake 0
      expect(lane.liveJobs).toBeNull();
      expect(lane.mergesPerHour).toBeNull();
      expect(lane.credit.state).toBe('unknown');
    }
  });

  it('falls back to queue.v1 READY counts when ready.tsv is absent', async () => {
    const dir = join(scratch, 'queue');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'queue.v1.json'), JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'READY', pool: 'devin' },
        { id: 'RQ-2', status: 'READY', pool: 'devin' },
        { id: 'RQ-3', status: 'CLAIMED', pool: 'claude' },
      ],
    }));
    const snapshot = await getFleetLaneSnapshot({
      queueDir: dir, budgetsDir: join(scratch, 'budgets'),
      usageLogPaths: [], now: () => ANCHOR,
    });
    const byLane = new Map(snapshot.lanes.map(l => [l.lane, l]));
    expect(snapshot.sources.queue.state).toBe('missing');
    expect(byLane.get('devin')!.queueDepth).toBe(2);   // queue.v1 fallback
    expect(byLane.get('devin')!.liveJobs).toBe(0);
    expect(byLane.get('claude')!.liveJobs).toBe(1);
  });

  it('marks a present-but-corrupt file degraded and still projects its rows', async () => {
    const dir = join(scratch, 'queue');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'ready.tsv'), 'READY\tRQ-1\tdevin\n\x00binary junk\x00\n');
    const snapshot = await getFleetLaneSnapshot({
      queueDir: dir, budgetsDir: join(scratch, 'budgets'),
      usageLogPaths: [], now: () => ANCHOR,
    });
    expect(snapshot.sources.queue.state).toBe('degraded');
    expect(snapshot.sources.queue.dropped).toBe(1);
    const devin = snapshot.lanes.find(l => l.lane === 'devin')!;
    expect(devin.queueDepth).toBe(1);      // surviving row still counts
    expect(devin.liveJobs).toBe(0);        // tsv was readable → live = in-flight rows (none)
  });
});

// ---------------------------------------------------------------------------
// formatFleetLanes + cmdFleet lanes
// ---------------------------------------------------------------------------

describe('formatFleetLanes', () => {
  it('renders the lane table and source line without color', async () => {
    const snapshot = await getFleetLaneSnapshot(fixtureOptions);
    const out = formatFleetLanes(snapshot);
    expect(out).toContain('lane');
    expect(out).toContain('merges/h');
    expect(out).toContain('devin');
    expect(out).toContain('12.5 ACU');
    expect(out).toContain('64% weekly · 3 credits');
    expect(out).toContain('sources: ready.tsv healthy (6 rows)');
    expect(out).not.toContain('\x1b[');
  });
});

describe('cmdFleet lanes', () => {
  it('prints the raw snapshot as JSON against the fixture', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleet(['lanes', '--queue-dir', FIXTURE_QUEUE, '--json'])).toBe(0);
    expect(log).toHaveBeenCalledTimes(1);
    const snapshot = JSON.parse(log.mock.calls[0]![0] as string) as FleetLaneSnapshot;
    expect(snapshot.schema).toBe('fleet.lanes.v1');
    expect(snapshot.lanes.find(l => l.lane === 'devin')).toMatchObject({ queueDepth: 2, liveJobs: 1 });
  });

  it('prints the human table against the fixture', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleet(['lanes', '--queue-dir', FIXTURE_QUEUE])).toBe(0);
    const out = log.mock.calls.map(c => String(c[0])).join('\n');
    expect(out).toContain('devin');
    expect(out).toContain('12.5 ACU');
  });

  it('exits 2 on a relative --queue-dir and on unknown options', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleet(['lanes', '--queue-dir', 'relative/dir'])).toBe(2);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('absolute path');
    err.mockClear();
    expect(await cmdFleet(['lanes', '--bogus'])).toBe(2);
    expect(err.mock.calls.map(c => String(c[0])).join('')).toContain('unknown option');
    err.mockClear();
    expect(await cmdFleet(['lanes', '--queue-dir'])).toBe(2); // missing value
  });

  it('never throws when every source is absent', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleet(['lanes', '--queue-dir', join(scratch, 'absent'), '--json'])).toBe(0);
    const snapshot = JSON.parse(log.mock.calls[0]![0] as string) as FleetLaneSnapshot;
    expect(snapshot.sources.queue.state).toBe('missing');
    expect(snapshot.lanes.every(l => l.queueDepth === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet/lanes — loopback route serves the same projection.
// ---------------------------------------------------------------------------

describe('GET /api/fleet/lanes', () => {
  function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname, port, path: parsed.pathname + parsed.search,
          method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('returns a fleet.lanes.v1 snapshot on the loopback server', async () => {
    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);
    const res = await get(`${h.url}/api/fleet/lanes`, h.port);
    expect(res.statusCode).toBe(200);
    const snapshot = JSON.parse(res.body) as FleetLaneSnapshot;
    expect(snapshot.schema).toBe('fleet.lanes.v1');
    expect(Array.isArray(snapshot.lanes)).toBe(true);
    // Default queue dir is absent under the isolated test HOME → honest nulls.
    expect(snapshot.sources.queue.state).toBe('missing');
    expect(JSON.stringify(snapshot)).not.toContain(process.env.HOME ?? 'IMPOSSIBLE');
  });
});
