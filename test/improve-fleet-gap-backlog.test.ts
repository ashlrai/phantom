import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GAP_BACKLOG_MAX_ITEMS,
  GAP_WINDOW_HOURS,
  fleetGapBacklogItems,
  foldFleetGapEvidence,
} from '../src/core/improve/fleet-gap-backlog.js';
import type { FleetGap, FleetGapsReport } from '../src/core/fleet/sleep-gaps.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 3_600_000;
/** Fixed evaluation instant; fixture timestamps are epoch ms like the ledgers' stamps. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const REPO = 'ashlrai/phantom';

/** Local wall-clock stamp in the dispatch-events.log dialect parseTicks reads. */
const localStamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** One PLANNER_TICK line; phx is omitted when ready is null so the fold records queue depth as unknown. */
const tickLine = (ms: number, opts: { ready?: number | null; run?: boolean; reason?: string | null } = {}): string => {
  const ready = opts.ready ?? 0;
  const run = opts.run ?? true;
  const reason = opts.reason ?? (run ? 'low-supply' : 'quota-exceeded');
  const phx = ready === null ? '' : ` phx=${ready}`;
  return `${localStamp(ms)} PLANNER_TICK ${run ? 'run' : 'skip'} reason=${reason}${phx} free=2`;
};

/** One metrics/jobs.jsonl row in the dispatchd dialect; `ts` is the ISO stamp ledgerAtMs parses. */
const jobRow = (ms: number, event: string, job = 'RQ-GAP-1'): string =>
  JSON.stringify({ job, event, ts: new Date(ms).toISOString() });

/** Three episode starts on three distinct UTC days inside the 7-day window. */
const EPISODE_STARTS = [
  Date.parse('2026-11-20T08:00:00.000Z'),
  Date.parse('2026-11-21T09:00:00.000Z'),
  Date.parse('2026-11-22T10:00:00.000Z'),
];

/**
 * One dispatcher-stall episode: ticks at T-5, T, T+20, T+25 minutes —
 * the T→T+20 pair is a 20-minute no-tick gap with jobs queued on both
 * edges. `mono: wall` samples make sleptBetween measure zero sleep, so
 * the production fold calls it dispatcher-stalled.
 */
function stallEpisode(startMs: number): { ticks: string[]; samples: { wall: number; mono: number }[] } {
  const times = [startMs - 5 * MIN, startMs, startMs + 20 * MIN, startMs + 25 * MIN];
  return {
    ticks: [
      tickLine(times[0]!, { ready: 0 }),
      tickLine(times[1]!, { ready: 3 }),
      tickLine(times[2]!, { ready: 3 }),
      tickLine(times[3]!, { ready: 0 }),
    ],
    samples: times.map((wall) => ({ wall, mono: wall })),
  };
}

function stallFixture(clock: boolean): { events: string[]; clock?: { wall: number; mono: number }[] } {
  const events: string[] = [];
  const samples: { wall: number; mono: number }[] = [];
  for (const start of EPISODE_STARTS) {
    const ep = stallEpisode(start);
    events.push(...ep.ticks);
    samples.push(...ep.samples);
  }
  return clock ? { events, clock: samples } : { events };
}

/** Continuous 10-minute ticks Nov 20–23; the episode windows carry ready=4 skip-quota ticks, everything else ready=0. */
function admissionEvents(): string[] {
  const episodeMs = new Set<number>();
  for (const start of EPISODE_STARTS) for (let i = 0; i < 5; i++) episodeMs.add(start + i * 10 * MIN);
  const events: string[] = [];
  for (let t = Date.parse('2026-11-20T00:00:00.000Z'); t <= Date.parse('2026-11-23T00:00:00.000Z'); t += 10 * MIN) {
    events.push(episodeMs.has(t)
      ? tickLine(t, { ready: 4, run: false, reason: 'quota-exceeded' })
      : tickLine(t, { ready: 0 }));
  }
  return events;
}

const gap = (spec: Partial<FleetGap>): FleetGap => ({
  start: '2026-11-20T08:00:00.000Z',
  end: '2026-11-20T08:20:00.000Z',
  minutes: 20,
  kind: 'no-tick',
  cause: 'dispatcher-stalled',
  lostWork: true,
  jobsQueued: 3,
  freeSlots: 2,
  sleptMinutes: 0,
  reason: null,
  line: 'The dispatcher stalled.',
  ...spec,
});

const report = (gaps: FleetGap[], sources: FleetGapsReport['sources'] = { ticks: 'read', launches: 'read', clock: 'read' }): FleetGapsReport => ({
  schema: 'fleet.gaps.v1',
  asOf: new Date(NOW_MS).toISOString(),
  since: new Date(NOW_MS - GAP_WINDOW_HOURS * HOUR).toISOString(),
  minMinutes: 15,
  sources,
  count: gaps.length,
  lostMinutes: gaps.filter((g) => g.lostWork !== false).reduce((n, g) => n + g.minutes, 0),
  claudeLeftPct: null,
  gaps,
});

describe('foldFleetGapEvidence', () => {
  it('reports unknown when the tick spine never read, and tallies each cell honestly', () => {
    const unreadable = { ...report([], { ticks: 'unknown', launches: 'unknown', clock: 'unknown' }), count: null, lostMinutes: null };
    const ev0 = foldFleetGapEvidence(unreadable);
    expect(ev0.state).toBe('unknown');
    expect(ev0.gapCount).toBeNull();
    expect(ev0.lostMinutes).toBeNull();
    expect(ev0.stall.episodes).toBe(0);

    const ev = foldFleetGapEvidence(report([
      gap({ start: '2026-11-20T08:00:00.000Z', end: '2026-11-20T08:20:00.000Z' }),
      gap({ start: '2026-11-20T18:00:00.000Z', end: '2026-11-20T18:25:00.000Z', minutes: 25 }),
      gap({ start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T09:30:00.000Z', minutes: 30 }),
      // Excluded: owner-side sleep and a provably-empty queue never reach a cell.
      gap({ start: '2026-11-21T12:00:00.000Z', cause: 'host-asleep', sleptMinutes: 20 }),
      gap({ start: '2026-11-21T13:00:00.000Z', lostWork: false, jobsQueued: 0, cause: 'queue-empty' }),
      gap({ start: '2026-11-21T14:00:00.000Z', kind: 'no-launch', cause: 'unknown', reason: null }),
      gap({
        start: '2026-11-21T22:00:00.000Z', end: '2026-11-21T22:30:00.000Z', minutes: 30,
        kind: 'no-launch', cause: 'admission-blocked', reason: 'quota-exceeded',
      }),
      gap({
        start: '2026-11-22T09:00:00.000Z', end: '2026-11-22T09:30:00.000Z', minutes: 30,
        kind: 'no-launch', cause: 'admission-blocked', reason: 'quota-exceeded',
      }),
      gap({
        start: '2026-11-22T10:00:00.000Z', end: '2026-11-22T10:30:00.000Z', minutes: 30,
        kind: 'no-launch', cause: 'admission-blocked', reason: 'hold',
      }),
    ]));
    expect(ev.stall).toMatchObject({ episodes: 3, days: 2, minutes: 75, lostWork: 3 });
    expect(ev.stall.oldestStart).toBe('2026-11-20T08:00:00.000Z');
    expect(ev.stall.newestEnd).toBe('2026-11-21T09:30:00.000Z');
    // Admission: 3 episodes across 2 days; modal reason quota-exceeded (2 of 3).
    expect(ev.admission.episodes).toBe(3);
    expect(ev.admission.days).toBe(2);
    expect(ev.admission.modalReason).toBe('quota-exceeded');
    expect(ev.admission.reasons).toEqual([
      { reason: 'quota-exceeded', count: 2 },
      { reason: 'hold', count: 1 },
    ]);
    // Unattributed: the single no-launch 'unknown' gap — below the recurrence bars.
    expect(ev.unattributed).toMatchObject({ episodes: 1, days: 1, noTick: 0, noLaunch: 1 });
    // host-asleep and queue-empty episodes never reach any cell: 3+3+1 of 9 gaps.
    expect(ev.stall.episodes + ev.admission.episodes + ev.unattributed.episodes).toBe(7);
  });

  it('keeps unknown-queue-depth episodes actionable and an empty report folds to zeroed cells', () => {
    const ev = foldFleetGapEvidence(report([
      gap({ lostWork: null, jobsQueued: null }),
      gap({ start: '2026-11-21T08:00:00.000Z', end: '2026-11-21T08:20:00.000Z', lostWork: null, jobsQueued: null }),
      gap({ start: '2026-11-22T08:00:00.000Z', end: '2026-11-22T08:20:00.000Z', lostWork: null, jobsQueued: null }),
    ]));
    expect(ev.stall.episodes).toBe(3);
    expect(ev.stall.lostWork).toBe(0);
    expect(ev.stall.lostWorkUnknown).toBe(3);

    const empty = foldFleetGapEvidence(report([]));
    expect(empty.state).toBe('known');
    expect(empty.gapCount).toBe(0);
    expect(empty.stall.episodes).toBe(0);
    expect(empty.admission.episodes).toBe(0);
    expect(empty.unattributed.episodes).toBe(0);
  });
});

describe('fleetGapBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'fleet-gap-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  interface Fixture { events?: string[]; jobs?: string[]; clock?: { wall: number; mono: number }[] }

  /** A runs dir carrying whichever evidence files the fixture names. */
  async function runsDir(name: string, files: Fixture): Promise<string> {
    const dir = join(home, name);
    if (files.events !== undefined) {
      await mkdir(join(dir, 'queue'), { recursive: true });
      await writeFile(join(dir, 'queue', 'dispatch-events.log'), files.events.join('\n') + '\n');
    }
    if (files.jobs !== undefined) {
      await mkdir(join(dir, 'metrics'), { recursive: true });
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.jobs.length ? files.jobs.join('\n') + '\n' : '');
    }
    if (files.clock !== undefined) {
      await mkdir(join(dir, 'queue'), { recursive: true });
      await writeFile(join(dir, 'queue', 'clock-samples.json'), JSON.stringify(files.clock));
    }
    return dir;
  }

  it('emits the dispatch-stall item for recurring proven-awake gaps', async () => {
    const fixture = stallFixture(true);
    const dir = await runsDir('runs-stall', { events: fixture.events, jobs: [], clock: fixture.clock });
    const items = await fleetGapBacklogItems({ repo: REPO, runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ id: 'fleet-gap-dispatch-stall', area: 'fleet-gaps', priority: 3, repo: REPO });
    expect(item.prompt).toContain('dispatcher keeps stalling');
    expect(item.prompt).toContain('3 separate stretches');
    expect(item.prompt).toContain('phm fleet gaps');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).not.toContain('lower bound');
  });

  it('emits the unattributed item when clock samples cannot attribute the gaps', async () => {
    const fixture = stallFixture(false);
    const dir = await runsDir('runs-unknown', { events: fixture.events, jobs: [] });
    const items = await fleetGapBacklogItems({ repo: REPO, runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['fleet-gap-unattributed']);
    expect(items[0]!.prompt).toContain('cannot attribute');
    expect(items[0]!.prompt).toContain('clock samples');
  });

  it('emits the admission item keyed on the modal skip reason', async () => {
    const dir = await runsDir('runs-admission', { events: admissionEvents(), jobs: [] });
    const items = await fleetGapBacklogItems({ repo: REPO, runsDir: dir, now: new Date(NOW_MS) });
    expect(items.map((i) => i.id)).toEqual(['fleet-gap-admission-quota-exceeded']);
    expect(items[0]!.prompt).toContain('refusing launches');
    expect(items[0]!.prompt).toContain('quota-exceeded');
    expect(items[0]!.area).toBe('fleet-gaps');
  });

  it('emits nothing for missing evidence, non-fleet repos, or below-bar recurrence', async () => {
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: new Date(NOW_MS) })).toEqual([]);
    const fixture = stallFixture(true);
    const dir = await runsDir('runs-stall', { events: fixture.events, jobs: [], clock: fixture.clock });
    // A non-fleet repository never inherits this install's machinery evidence.
    expect(await fleetGapBacklogItems({ repo: 'ashlrai/lexicon', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await fleetGapBacklogItems({ repo: 'someone/else', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    // One episode is an incident, not a pattern.
    const oneStart = EPISODE_STARTS[0]!;
    const oneEp = stallEpisode(oneStart);
    const one = await runsDir('runs-one', { events: oneEp.ticks, jobs: [], clock: oneEp.samples });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: one, now: new Date(NOW_MS) })).toEqual([]);
    // Two episodes on one UTC day never reach the day bar.
    const sameDay = oneStart + 6 * HOUR;
    const sameDayEp = stallEpisode(sameDay);
    const twoSameDay = await runsDir('runs-sameday', {
      events: [...oneEp.ticks, ...sameDayEp.ticks],
      jobs: [],
      clock: [...oneEp.samples, ...sameDayEp.samples],
    });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: twoSameDay, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('never counts host-asleep or provably-empty-queue episodes', async () => {
    // Same stall shape, but the clock samples prove the Mac slept through each gap:
    // samples sit within the 5-minute edge tolerance and wall advances far past monotonic.
    const events: string[] = [];
    const samples: { wall: number; mono: number }[] = [];
    for (const start of EPISODE_STARTS) {
      const ep = stallEpisode(start);
      events.push(...ep.ticks);
      samples.push(
        { wall: start - 4 * MIN, mono: 1_000_000 },
        { wall: start + 24 * MIN, mono: 1_000_000 + 2 * MIN },
      );
    }
    const asleep = await runsDir('runs-asleep', { events, jobs: [], clock: samples });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: asleep, now: new Date(NOW_MS) })).toEqual([]);

    // Queue-empty gaps: both edges report ready=0, so nothing was waiting.
    const emptyEvents = EPISODE_STARTS.flatMap((start) => [
      tickLine(start - 5 * MIN, { ready: 0 }),
      tickLine(start, { ready: 0 }),
      tickLine(start + 20 * MIN, { ready: 0 }),
      tickLine(start + 25 * MIN, { ready: 0 }),
    ]);
    const empty = await runsDir('runs-emptyq', { events: emptyEvents, jobs: [] });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('degrades honestly when launch coverage cannot be proven', async () => {
    // The admission fixture needs launch evidence; a missing jobs.jsonl leaves
    // sources.launches 'unknown' and no-launch gaps are never computed.
    const noJobs = await runsDir('runs-nojobs', { events: admissionEvents() });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: noJobs, now: new Date(NOW_MS) })).toEqual([]);

    // A truncated tail whose retained head cannot reach the window start folds
    // launches as unknown — the same no-launch silence, still no items. The pad
    // rows are all stamped today, so the coverage edge lands after `since`.
    const recent = Array.from({ length: 240 }, (_, i) => jobRow(NOW_MS - i * MIN, 'finish', `RQ-F-${i}`));
    const truncated = await runsDir('runs-trunc', { events: admissionEvents(), jobs: recent });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: truncated, jobsLedgerLimit: 4096, now: new Date(NOW_MS) })).toEqual([]);

    // The same truncation with a retained head stamped before the window proves
    // coverage: week-old rows pad the front, in-window rows sit at the tail.
    const oldRows = Array.from({ length: 60 }, (_, i) => jobRow(NOW_MS - (GAP_WINDOW_HOURS + 24 + i) * HOUR, 'finish', `RQ-OLD-${i}`));
    const inWindow = Array.from({ length: 60 }, (_, i) => jobRow(NOW_MS - i * HOUR, 'finish', `RQ-NEW-${i}`));
    const covered = await runsDir('runs-covered', { events: admissionEvents(), jobs: [...oldRows, ...inWindow] });
    const coveredItems = await fleetGapBacklogItems({ repo: REPO, runsDir: covered, jobsLedgerLimit: 8192, now: new Date(NOW_MS) });
    expect(coveredItems.map((i) => i.id)).toEqual(['fleet-gap-admission-quota-exceeded']);
  });

  it('records launches inside the queued stretches so admission-blocked gaps never form', async () => {
    // A launch row inside every inter-tick span disqualifies every no-launch pair.
    const launchTimes = new Set<number>();
    for (let t = Date.parse('2026-11-20T00:00:00.000Z'); t <= Date.parse('2026-11-23T00:00:00.000Z'); t += 10 * MIN) launchTimes.add(t);
    const dir = await runsDir('runs-launched', {
      events: admissionEvents(),
      jobs: [...launchTimes].map((t) => jobRow(t, 'launch', `RQ-L-${t}`)),
    });
    expect(await fleetGapBacklogItems({ repo: REPO, runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);

    // Stable ids: a refresh re-derives the same item and the limit is honoured.
    const fixture = stallFixture(true);
    const stable = await runsDir('runs-stable', { events: fixture.events, jobs: [], clock: fixture.clock });
    const opts = { repo: REPO, runsDir: stable, now: new Date(NOW_MS) };
    const first = await fleetGapBacklogItems(opts);
    const second = await fleetGapBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(GAP_BACKLOG_MAX_ITEMS);
    const limited = await fleetGapBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });
});

describe('discoverBacklog wiring', () => {
  it('appends fleet-gap items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    const home = await mkdtemp(join(tmpdir(), 'fleet-gap-discover-'));
    const saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    process.env.HOME = home;
    try {
      const runs = join(home, '.ashlr-runs');
      const fixture = stallFixture(true);
      await mkdir(join(runs, 'queue'), { recursive: true });
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, 'queue', 'dispatch-events.log'), fixture.events.join('\n') + '\n');
      await writeFile(join(runs, 'metrics', 'jobs.jsonl'), '');
      await writeFile(join(runs, 'queue', 'clock-samples.json'), JSON.stringify(fixture.clock));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const gapItems = first.items.filter((i) => i.id.startsWith('fleet-gap-'));
      expect(gapItems).toHaveLength(1);
      expect(gapItems[0]!.id).toBe('fleet-gap-dispatch-stall');
      expect(gapItems[0]!.area).toBe('fleet-gaps');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(gapItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-gap-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-gap-'))).toHaveLength(1);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      vi.useRealTimers();
      await rm(home, { recursive: true, force: true });
    }
  });
});
