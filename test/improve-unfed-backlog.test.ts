import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldWorkMarket,
  marketDecisionCells,
  UNFED_BACKLOG_MAX_ITEMS,
  UNFED_LANE_MIN_DAYS,
  UNFED_LANE_MIN_TICKS,
  unfedBacklogItems,
  unfedLaneCells,
} from '../src/core/improve/unfed-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are epoch seconds like dispatchd's market_metric writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW_S = Math.floor(NOW_MS / 1000);
/** Epoch seconds `msAgo` milliseconds before NOW_MS. */
const sec = (msAgo: number): number => Math.floor((NOW_MS - msAgo) / 1000);

/** One unfed_capacity row in the writer's shape; lanes default to a single unfed lane. */
function unfedRow(tsSec: number, unfedLane: string, blocked: Record<string, number> = {}): string {
  return J({
    schema: 'work-market.v1', event: 'unfed_capacity', ts: tsSec, waiting: 3,
    unfed_lanes: [unfedLane], unfed_slots: 2,
    lanes: {
      [unfedLane]: {
        running: 1, target: 4, held: false, headroom: 3, utilization: 0.25,
        waiting_elsewhere: 2, blocked, unfed: true,
      },
      claude: {
        running: 4, target: 4, held: false, headroom: 0, utilization: 1.0,
        waiting_elsewhere: 0, blocked: {}, unfed: false,
      },
    },
  });
}

interface DecisionSpec {
  job: string;
  chosen?: string | null;
  preferred?: string | null;
  override?: { from: string | null; to: string; reason: string } | null;
  rejected?: { lane: string; codes: string[] }[];
  codes?: string[];
}

/** One route_decision row in the writer's shape. */
function decisionRow(tsSec: number, spec: DecisionSpec): string {
  return J({
    schema: 'work-market.v1', event: 'route_decision', ts: tsSec, job: spec.job,
    chosen_lane: spec.chosen === undefined ? 'claude' : spec.chosen,
    preferred_lane: spec.preferred === undefined ? 'claude' : spec.preferred,
    work_class: 'standard',
    override: spec.override ?? null,
    rejected_lanes: (spec.rejected ?? []).map((r) => ({ lane: r.lane, reason_codes: r.codes })),
    reason_codes: spec.codes ?? ['healthy_capacity'],
    ranking_inputs: {},
  });
}

/** n unfed ticks for one lane spread across `days` distinct UTC days ending today. */
function unfedSeries(lane: string, days: number, perDay: number, blocked: Record<string, number> = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(unfedRow(sec(d * DAY + i * HOUR), lane, blocked));
    }
  }
  return rows;
}

/** n distinct jobs each decided once, spread across `days` distinct UTC days. */
function decisionSeries(days: number, make: (job: string, dayIndex: number) => DecisionSpec): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < 2; i++) {
      const job = `RQ-M${n}`;
      rows.push(decisionRow(sec(d * DAY + i * HOUR), make(job, d)));
      n += 1;
    }
  }
  return rows;
}

describe('foldWorkMarket', () => {
  it('keeps only in-window work-market.v1 rows of the two evidence events', () => {
    const rows = [
      unfedRow(NOW_S, 'devin'),
      decisionRow(NOW_S, { job: 'RQ-A', chosen: 'devin' }),
      J({ schema: 'work-market.v1', event: 'posture', ts: NOW_S, lanes: {} }),
      J({ schema: 'session-failover.v1', event: 'session_handoff_advisory', ts: NOW_S, job: 'RQ-A', trigger: 'quota-exhausted' }),
      J({ schema: 'other.v9', event: 'route_decision', ts: NOW_S, job: 'RQ-B' }),
      decisionRow(NOW_S - 200 * 3600, { job: 'RQ-C' }), // outside the 168 h window
      decisionRow(NOW_S + 600, { job: 'RQ-D' }), // beyond the +300 s skew tolerance
      'not json',
      '',
    ].join('\n');
    const fold = foldWorkMarket(rows, NOW_MS, 168);
    expect(fold.unfed.size).toBe(1);
    expect([...fold.latest.keys()]).toEqual(['RQ-A']);
    expect(fold.latest.get('RQ-A')!.chosen).toBe('devin');
  });

  it('collapses route decisions to each job\'s latest in-window row', () => {
    const rows = [
      decisionRow(sec(2 * DAY), { job: 'RQ-A', chosen: null, codes: ['no_runnable_lane'] }),
      decisionRow(sec(DAY), { job: 'RQ-A', chosen: 'devin', rejected: [{ lane: 'claude', codes: ['quota_exhausted'] }] }),
      decisionRow(sec(3 * DAY), { job: 'RQ-B', chosen: null, codes: ['no_runnable_lane'] }), // outside window? 3d < 168h — inside
    ].join('\n');
    const fold = foldWorkMarket(rows, NOW_MS, 168);
    // RQ-A counts once, by its newest row (chosen devin, claude rejected).
    expect(fold.latest.get('RQ-A')!.chosen).toBe('devin');
    expect(fold.latest.get('RQ-A')!.day).toBe(new Date(sec(DAY) * 1000).toISOString().slice(0, 10));
    const cells = marketDecisionCells(fold);
    // Only one unrouted job (RQ-B) — below the recurring bar.
    expect(cells.filter((c) => c.kind === 'unrouted')).toEqual([]);
  });

  it('requires unfed===true plus positive headroom and waiting_elsewhere', () => {
    const bad = J({
      schema: 'work-market.v1', event: 'unfed_capacity', ts: NOW_S, waiting: 1, unfed_lanes: ['devin'], unfed_slots: 0,
      lanes: {
        devin: { running: 4, target: 4, held: false, headroom: 0, utilization: 1, waiting_elsewhere: 5, blocked: {}, unfed: true },
        claude: { running: 0, target: 4, held: false, headroom: 4, utilization: 0, waiting_elsewhere: 0, blocked: {}, unfed: true },
      },
    });
    const fold = foldWorkMarket(bad, NOW_MS, 168);
    expect(fold.unfed.size).toBe(0);
  });
});

describe('unfedLaneCells / marketDecisionCells', () => {
  it('emits an unfed lane only across enough days and ticks', () => {
    const oneDay = unfedSeries('devin', 1, UNFED_LANE_MIN_TICKS + 2, { quota_exhausted: 3 });
    const foldOne = foldWorkMarket(oneDay.join('\n'), NOW_MS, 168);
    expect(unfedLaneCells(foldOne)).toEqual([]);

    const recurring = unfedSeries('devin', UNFED_LANE_MIN_DAYS + 1, 3, { quota_exhausted: 2 });
    const cells = unfedLaneCells(foldWorkMarket(recurring.join('\n'), NOW_MS, 168));
    expect(cells).toHaveLength(1);
    expect(cells[0]!.ticks).toBe(9);
    expect(cells[0]!.slotTicks).toBe(18);
    expect(cells[0]!.blocked).toEqual([['quota_exhausted', 18]]);
    expect(cells[0]!.days).toHaveLength(3);

    const fewTicks = unfedSeries('devin', UNFED_LANE_MIN_DAYS + 1, 1);
    const foldFew = foldWorkMarket(fewTicks.join('\n'), NOW_MS, 168);
    expect(fewTicks.length).toBeLessThan(UNFED_LANE_MIN_TICKS);
    expect(unfedLaneCells(foldFew)).toEqual([]);
  });

  it('emits reject cells only for recurring non-mechanical codes across days', () => {
    const mechanical = decisionSeries(3, (job) => ({
      job, chosen: 'claude',
      rejected: [{ lane: 'devin', codes: ['lower_rank', 'saturated'] }],
    }));
    const foldMech = foldWorkMarket(mechanical.join('\n'), NOW_MS, 168);
    expect(marketDecisionCells(foldMech).filter((c) => c.kind === 'reject')).toEqual([]);

    const hysteresis = decisionSeries(3, (job) => ({
      job, chosen: 'claude',
      rejected: [{ lane: 'devin', codes: ['hysteresis_capacity'] }],
    }));
    expect(marketDecisionCells(foldWorkMarket(hysteresis.join('\n'), NOW_MS, 168))
      .filter((c) => c.kind === 'reject')).toEqual([]);

    const real = decisionSeries(3, (job, d) => ({
      job, chosen: 'claude',
      rejected: [{
        lane: 'devin',
        codes: ['missing_capability', ...(d < 2 ? ['quota_exhausted'] : []), 'held'],
      }],
    }));
    const cells = marketDecisionCells(foldWorkMarket(real.join('\n'), NOW_MS, 168));
    const rejects = cells.filter((c) => c.kind === 'reject');
    // devin+missing_capability on all 6 jobs across 3 days; devin+quota_exhausted on the 4 day-0/1 jobs; 'held' is mechanical.
    const mc = rejects.find((c) => c.code === 'missing_capability');
    expect(mc).toMatchObject({ lane: 'devin', jobs: 6 });
    expect(mc!.days).toHaveLength(3);
    const qe = rejects.find((c) => c.code === 'quota_exhausted');
    expect(qe).toMatchObject({ lane: 'devin', jobs: 4 });
    expect(qe!.days).toHaveLength(2);
    expect(rejects.find((c) => c.code === 'saturated')).toBeUndefined();
    expect(rejects.find((c) => c.code === 'held')).toBeUndefined();
  });

  it('requires recurrence for each lane and rejection code independently', () => {
    const rows = decisionSeries(2, (job, day) => ({
      job, chosen: 'claude',
      rejected: day === 0
        ? [{ lane: 'custom', codes: ['provider_backoff'] }]
        : [{ lane: 'customprovider_', codes: ['backoff'] }],
    }));
    expect(marketDecisionCells(foldWorkMarket(rows.join('\n'), NOW_MS, 168))).toEqual([]);
  });

  it('emits unrouted and unknown-preference umbrellas at the recurring bar', () => {
    const unrouted = decisionSeries(3, (job) => ({
      job, chosen: null, codes: ['no_runnable_lane'], rejected: [],
    }));
    const cellsU = marketDecisionCells(foldWorkMarket(unrouted.join('\n'), NOW_MS, 168));
    expect(cellsU.filter((c) => c.kind === 'unrouted')).toHaveLength(1);

    const pref = decisionSeries(3, (job) => ({
      job, chosen: 'claude',
      override: { from: 'ghost-lane', to: 'claude', reason: 'unknown_preference' },
    }));
    const cellsP = marketDecisionCells(foldWorkMarket(pref.join('\n'), NOW_MS, 168));
    const up = cellsP.filter((c) => c.kind === 'unknown-preference');
    expect(up).toHaveLength(1);
    expect(up[0]!.pairs[0]![0]).toBe('ghost-lane→claude');

    // resource_fit overrides are designed behavior — never emit.
    const fitRows = decisionSeries(3, (job) => ({
      job, chosen: 'claude',
      override: { from: 'devin', to: 'claude', reason: 'resource_fit' },
    }));
    expect(marketDecisionCells(foldWorkMarket(fitRows.join('\n'), NOW_MS, 168))
      .filter((c) => c.kind === 'unknown-preference')).toEqual([]);
  });
});

describe('unfedBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'unfed-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/work-market.jsonl carries the given rows. */
  async function runsDir(name: string, rows: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), rows.join('\n') + '\n');
    return dir;
  }

  it('emits an unfed-capacity item for a recurring unfed lane', async () => {
    const rows = unfedSeries('devin', 3, 3, { quota_exhausted: 4, missing_capability: 2 });
    const dir = await runsDir('runs-unfed', rows);
    const items = await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'unfed-capacity' });
    expect(item!.id).toMatch(/^fleet-unfed-[0-9a-f]{16}$/);
    expect(item!.title).toContain('devin');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('devin');
    expect(item!.prompt).toContain('quota_exhausted');
    expect(item!.prompt).toContain('work-market.jsonl');
    expect(item!.prompt).toContain('phm fleet unfed');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('lower bound');
  });

  it('emits route-rejection, unrouted-work and hint-mismatch items', async () => {
    let u = 0;
    const rows = [
      ...decisionSeries(3, (job) => ({
        job, chosen: 'claude', rejected: [{ lane: 'devin', codes: ['missing_capability'] }],
      })),
      ...decisionSeries(3, () => ({ job: `RQ-U${u++}`, chosen: null, codes: ['no_runnable_lane'] })),
      ...decisionSeries(3, (job) => ({
        job: `RQ-P${job.slice(4)}`, chosen: 'claude',
        override: { from: 'ghost-lane', to: 'claude', reason: 'unknown_preference' },
      })),
    ];
    const dir = await runsDir('runs-cells', rows);
    const items = await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const areas = items.map((i) => i.area).sort();
    expect(areas).toEqual(['hint-mismatch', 'route-rejection', 'unrouted-work']);
    const reject = items.find((i) => i.area === 'route-rejection')!;
    expect(reject.prompt).toContain('devin');
    expect(reject.prompt).toContain('missing_capability');
    const unrouted = items.find((i) => i.area === 'unrouted-work')!;
    expect(unrouted.prompt).toContain('no chosen lane');
    const hint = items.find((i) => i.area === 'hint-mismatch')!;
    expect(hint.prompt).toContain('ghost-lane');
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: NOW })).toEqual([]);

    // One day of unfed ticks and one day of rejections — under the day bar.
    const thin = [
      ...unfedSeries('devin', 1, UNFED_LANE_MIN_TICKS + 4, { quota_exhausted: 5 }),
      ...decisionSeries(1, (job) => ({ job, chosen: 'claude', rejected: [{ lane: 'devin', codes: ['missing_capability'] }] })),
    ];
    const dir = await runsDir('runs-thin', thin);
    expect(await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW })).toEqual([]);
    expect(await unfedBacklogItems({ repo: 'ashlrai/lexicon', runsDir: dir, now: NOW })).toEqual([]);
    expect(await unfedBacklogItems({ repo: '', runsDir: dir, now: NOW })).toEqual([]);
  });

  it('a lane unfed on one day only, or with too few ticks, stays silent', async () => {
    const oneDay = unfedSeries('devin', 1, UNFED_LANE_MIN_TICKS + 4);
    const dir = await runsDir('runs-oneday', oneDay);
    expect(await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW })).toEqual([]);
    const fewTicks = unfedSeries('devin', 3, 1);
    const dir2 = await runsDir('runs-few', fewTicks);
    expect(await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir2, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = unfedSeries('devin', 3, 3, { quota_exhausted: 4 });
    // Pad the journal past the 32 MiB tail so the read reports truncated.
    const pad = 'x'.repeat(33 * 1024 * 1024);
    const dir = await runsDir('runs-trunc', []);
    await writeFile(join(dir, 'metrics', 'work-market.jsonl'), pad + '\n' + rows.join('\n') + '\n');
    const items = await unfedBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...unfedSeries('devin', 3, 3, { quota_exhausted: 4 }),
      ...unfedSeries('claude', 3, 3, { auth_failed_or_zero_quota: 5 }),
      ...decisionSeries(3, (job) => ({ job, chosen: 'devin', rejected: [{ lane: 'claude', codes: ['missing_capability'] }] })),
    ];
    const dir = await runsDir('runs-stable', rows);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await unfedBacklogItems(opts);
    const second = await unfedBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(UNFED_BACKLOG_MAX_ITEMS);
    const limited = await unfedBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends work-market items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      await writeFile(join(runs, 'metrics', 'work-market.jsonl'),
        unfedSeries('devin', 3, 3, { quota_exhausted: 4 }).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const unfedItems = first.items.filter((i) => i.id.startsWith('fleet-unfed-'));
      expect(unfedItems).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(unfedItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-unfed-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-unfed-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
