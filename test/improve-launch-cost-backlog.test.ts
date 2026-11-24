import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countWindowLaunches,
  LAUNCH_COST_MIN_DAYS,
  LAUNCH_COST_SILENT_MIN_LAUNCHES,
  LAUNCH_COST_WINDOW_MS,
  launchCostBacklogItems,
  launchCostCells,
  parseLaunchCostJournal,
  parseLaunchCostRow,
  windowLaunchCostRows,
} from '../src/core/improve/launch-cost-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the producer writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * One fleet.launch-cost.v1 row in the producer's shape (contrib/mac/
 * launch_cost.py). 'measured'/'partial' carry the full metric block and a
 * startedAt; 'unknown' carries none — startedAt stays null on the
 * early-return rows the probe writes when claim custody is unverifiable.
 */
function costRow(spec: {
  lane?: string;
  launchId?: string;
  atMs?: number | null;
  status?: 'measured' | 'partial' | 'unknown';
  peakProcesses?: number | null;
  meanCpu?: number | null;
  peakCpu?: number | null;
  samples?: number;
  sampledSeconds?: number;
  startedAt?: string | null;
  extra?: Record<string, unknown>;
}): string {
  const status = spec.status ?? 'measured';
  const atMs = spec.atMs === undefined ? NOW_MS - HOUR : spec.atMs;
  const measuredShape = status !== 'unknown';
  return J({
    schema: 'fleet.launch-cost.v1',
    lane: spec.lane ?? 'claude',
    launchId: spec.launchId ?? `RQ-C${Math.floor(Math.random() * 1e9)}`,
    // startedAt is the verified launch start: set on every measured/partial
    // row and on 'unknown' rows the probe attached to but saw no samples
    // for; null only on the early-return unverifiable rows (atMs: null).
    startedAt: spec.startedAt !== undefined ? spec.startedAt : atMs === null ? null : iso(atMs as number),
    windowSeconds: 60,
    sampledSeconds: spec.sampledSeconds ?? (measuredShape ? 60 : 0),
    samples: spec.samples ?? (measuredShape ? 12 : 0),
    peakProcesses: measuredShape ? (spec.peakProcesses === undefined ? 3 : spec.peakProcesses) : null,
    meanCpuPercentOneCore: measuredShape ? (spec.meanCpu === undefined ? 125 : spec.meanCpu) : null,
    peakCpuPercentOneCore: measuredShape ? (spec.peakCpu === undefined ? 400 : spec.peakCpu) : null,
    status,
    ...spec.extra,
  });
}

/** One dispatchd launch row — the silent cell's "the fleet launched work" proof. */
function launchRow(job: string, atMs: number, lane = 'claude'): string {
  return J({ event: 'launch', job, repo: 'ashlrai/phantom', lane, tier: 'work', ts: iso(atMs) });
}

/** n launch rows for distinct jobs spread across `days` distinct UTC days ending today. */
function launchSeries(days: number, perDay: number, opts: { prefix?: string; lane?: string } = {}): string[] {
  const rows: string[] = [];
  let n = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(launchRow(`${opts.prefix ?? 'RQ-L'}${n++}`, NOW_MS - d * DAY - i * HOUR - HOUR, opts.lane));
    }
  }
  return rows;
}

describe('parseLaunchCostRow / parseLaunchCostJournal', () => {
  it('accepts each status under the producer contract and rejects off-contract rows', () => {
    const measured = parseLaunchCostRow(JSON.parse(costRow({ status: 'measured', lane: 'devin', launchId: 'RQ-1-ab12cd34ef56' })), 0);
    expect(measured).toMatchObject({ lane: 'devin', launchId: 'RQ-1-ab12cd34ef56', status: 'measured', samples: 12, peakProcesses: 3 });
    expect(measured!.atMs).toBe(NOW_MS - HOUR);

    const unknown = parseLaunchCostRow(JSON.parse(costRow({ status: 'unknown', atMs: null, lane: 'codex' })), 1);
    expect(unknown).toMatchObject({ lane: 'codex', status: 'unknown', atMs: null, peakProcesses: null });

    const rejects: unknown[] = [
      { ...JSON.parse(costRow({})), schema: 'other.v1' },
      { ...JSON.parse(costRow({})), lane: 'has space' },
      { ...JSON.parse(costRow({})), launchId: '' },
      { ...JSON.parse(costRow({})), windowSeconds: 30 },
      { ...JSON.parse(costRow({})), startedAt: 'not-a-date' },
      { ...JSON.parse(costRow({ status: 'unknown' })), peakProcesses: 3 },
      { ...JSON.parse(costRow({ status: 'measured', samples: 5 })), samples: 5 },
      { ...JSON.parse(costRow({ status: 'partial' })), startedAt: null },
      { ...JSON.parse(costRow({ status: 'measured', sampledSeconds: 30 })), sampledSeconds: 30 },
      { ...JSON.parse(costRow({ status: 'measured' })), meanCpuPercentOneCore: 900, peakCpuPercentOneCore: 400 },
      'not an object',
      null,
    ];
    for (const bad of rejects) expect(parseLaunchCostRow(bad, 0)).toBeNull();

    // measured requires nearly-full coverage; partial tolerates thin sampling.
    expect(parseLaunchCostRow(JSON.parse(costRow({ status: 'partial', sampledSeconds: 30, samples: 6 })), 0)).not.toBeNull();
    expect(parseLaunchCostRow(JSON.parse(costRow({ status: 'measured', sampledSeconds: 59, samples: 12 })), 0)).not.toBeNull();
    expect(parseLaunchCostRow(JSON.parse(costRow({ status: 'measured', sampledSeconds: 58, samples: 12 })), 0)).toBeNull();
  });

  it('parses a journal keeping file order and counting non-contract lines', () => {
    const text = [
      costRow({ lane: 'a', launchId: 'RQ-A1' }),
      'not json at all',
      costRow({ lane: 'b', launchId: 'RQ-B1', status: 'unknown' }),
      '{"schema":"other.v1"}',
      '',
      costRow({ lane: 'a', launchId: 'RQ-A2', status: 'partial', sampledSeconds: 30, samples: 6 }),
    ].join('\n');
    const { rows, invalidRows } = parseLaunchCostJournal(text);
    expect(rows.map((r) => r.launchId)).toEqual(['RQ-A1', 'RQ-B1', 'RQ-A2']);
    expect(invalidRows).toBe(2);
  });
});

describe('windowLaunchCostRows', () => {
  it('windows dated rows on startedAt and undated rows by append order after the anchor', () => {
    const inWindowDated = JSON.parse(costRow({ launchId: 'RQ-W1', atMs: NOW_MS - DAY })) as Record<string, unknown>;
    const staleDated = JSON.parse(costRow({ launchId: 'RQ-S1', atMs: NOW_MS - LAUNCH_COST_WINDOW_MS - DAY })) as Record<string, unknown>;
    const undatedAfter = JSON.parse(costRow({ launchId: 'RQ-U1', status: 'unknown', atMs: null })) as Record<string, unknown>;
    const undatedBefore = JSON.parse(costRow({ launchId: 'RQ-U0', status: 'unknown', atMs: null })) as Record<string, unknown>;
    const rows = [
      parseLaunchCostRow(staleDated, 0)!,
      parseLaunchCostRow(undatedBefore, 1)!,
      parseLaunchCostRow(inWindowDated, 2)!,
      parseLaunchCostRow(undatedAfter, 3)!,
    ];
    const w = windowLaunchCostRows(rows, NOW_MS, LAUNCH_COST_WINDOW_MS);
    expect(w.inWindow.map((r) => r.launchId)).toEqual(['RQ-W1', 'RQ-U1']);
    expect(w.datedOutside).toBe(1);
    expect(w.undatedBeforeAnchor).toBe(1);
    expect(w.datedInWindow).toBe(1);
    expect(w.allUndated).toBe(false);
  });

  it('treats an all-undated file as unverifiable evidence and a stale-dated file as empty', () => {
    const undated = [0, 1, 2].map((i) => parseLaunchCostRow(JSON.parse(costRow({ launchId: `RQ-U${i}`, status: 'unknown', atMs: null })), i)!);
    const all = windowLaunchCostRows(undated, NOW_MS, LAUNCH_COST_WINDOW_MS);
    expect(all.allUndated).toBe(true);
    expect(all.inWindow).toHaveLength(3);

    const stale = parseLaunchCostRow(JSON.parse(costRow({ launchId: 'RQ-OLD', atMs: NOW_MS - LAUNCH_COST_WINDOW_MS - DAY })), 0)!;
    const mixed = windowLaunchCostRows([stale, undated[0]!], NOW_MS, LAUNCH_COST_WINDOW_MS);
    expect(mixed.allUndated).toBe(false);
    expect(mixed.inWindow).toHaveLength(0);
    expect(mixed.datedOutside).toBe(1);
    expect(mixed.undatedNoAnchor).toBe(1);
  });
});

describe('countWindowLaunches', () => {
  it('counts distinct jobs with in-window launch events under the jobs-ledger dialect', () => {
    const rows = [
      ...launchSeries(2, 2, { prefix: 'RQ-J' }),
      launchRow('RQ-J0', NOW_MS - LAUNCH_COST_WINDOW_MS - DAY), // stale
      launchRow('RQ-JX', NOW_MS + 600_000), // beyond skew
      J({ event: 'finish', job: 'RQ-F1', ts: iso(NOW_MS - HOUR) }),
      J({ event: 'launch', job: 'has space', ts: iso(NOW_MS - HOUR) }),
      J({ schema: 'fleet.session-pool.v1', event: 'launch', job: 'sess-1:2', jobId: 'ready:x', ts: iso(NOW_MS - HOUR) }),
      'not json launch',
    ];
    const { launches, jobs } = countWindowLaunches(rows.join('\n'), NOW_MS, LAUNCH_COST_WINDOW_MS);
    expect(launches).toBe(4);
    expect(jobs.has('RQ-J0')).toBe(true);
    expect(jobs.has('RQ-J1')).toBe(true);
    expect(jobs.has('RQ-J2')).toBe(true);
    expect(jobs.has('RQ-J3')).toBe(true);
  });
});

describe('launchCostCells', () => {
  it('emits the silent cell only when launches are proven and no in-window rows exist', () => {
    const noLaunches = launchCostCells([], { launches: LAUNCH_COST_SILENT_MIN_LAUNCHES - 1 });
    expect(noLaunches).toEqual([]);
    const silent = launchCostCells([], { launches: LAUNCH_COST_SILENT_MIN_LAUNCHES });
    expect(silent).toHaveLength(1);
    expect(silent[0]).toMatchObject({ kind: 'silent', lane: 'fleet', launches: LAUNCH_COST_SILENT_MIN_LAUNCHES });
  });

  it('emits per-lane coverage cells at the recurring bars and cost cells at the storm bar', () => {
    const parse = (spec: Parameters<typeof costRow>[0]) => parseLaunchCostRow(JSON.parse(costRow(spec)), 0)!;
    // Coverage: 3 dated unknown rows across 2 days for lane 'blind'.
    const blind = [
      parse({ lane: 'blind', launchId: 'RQ-B1', status: 'unknown' }),
      parse({ lane: 'blind', launchId: 'RQ-B2', status: 'unknown', atMs: NOW_MS - DAY }),
      parse({ lane: 'blind', launchId: 'RQ-B3', status: 'partial', atMs: NOW_MS - 2 * DAY, sampledSeconds: 30, samples: 6 }),
    ];
    // Below bars: one burst day only.
    const thin = [0, 1, 2].map((i) => parse({ lane: 'thin', launchId: `RQ-T${i}`, status: 'unknown', atMs: NOW_MS - i * HOUR }));
    // Cost: 2 storm rows across 2 days for lane 'stormy'.
    const stormy = [
      parse({ lane: 'stormy', launchId: 'RQ-S1', status: 'measured', peakProcesses: 140, meanCpu: 200, peakCpu: 900 }),
      parse({ lane: 'stormy', launchId: 'RQ-S2', status: 'measured', atMs: NOW_MS - DAY, peakProcesses: 120, meanCpu: 700, peakCpu: 820 }),
      // A normal measured row that must not count as a storm.
      parse({ lane: 'stormy', launchId: 'RQ-S3', status: 'measured', atMs: NOW_MS - 2 * DAY }),
    ];
    // Healthy: measured rows with ordinary figures emit nothing.
    const healthy = [0, 1, 2].map((i) => parse({ lane: 'ok', launchId: `RQ-H${i}`, status: 'measured', atMs: NOW_MS - i * DAY }));
    const cells = launchCostCells([...blind, ...thin, ...stormy, ...healthy], { launches: 0 });
    const kinds = cells.map((c) => `${c.kind}:${c.lane}`);
    expect(kinds).toContain('coverage:blind');
    expect(kinds).toContain('cost:stormy');
    expect(kinds).not.toContain('coverage:thin');
    expect(cells.find((c) => c.kind === 'coverage')!.days.length).toBeGreaterThanOrEqual(LAUNCH_COST_MIN_DAYS);
    const cost = cells.find((c) => c.kind === 'cost')!;
    expect(cost.adverse).toBe(2);
    expect(cost.maxPeakProcesses).toBe(140);
    expect(cost.maxPeakCpuPct).toBe(900);
  });

  it('emits undated-dominated coverage on attempt count and says days are unrecorded', () => {
    const undated = [0, 1, 2, 3, 4, 5].map((i) =>
      parseLaunchCostRow(JSON.parse(costRow({ lane: 'ghost', launchId: `RQ-G${i}`, status: 'unknown', atMs: null })), i)!);
    const cells = launchCostCells(undated, { launches: 0 });
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'coverage', lane: 'ghost', undatedRecurrence: true, days: [] });
  });
});

describe('launchCostBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'launch-cost-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir; writes metrics/jobs.jsonl and/or metrics/launch-cost.jsonl when given rows. */
  async function runsDir(name: string, files: { jobs?: string[]; cost?: string[] }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (files.jobs !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.jobs.join('\n') + '\n');
    if (files.cost !== undefined) await writeFile(join(dir, 'metrics', 'launch-cost.jsonl'), files.cost.join('\n') + '\n');
    return dir;
  }

  it('emits the silent item when launches are proven and the probe file is absent', async () => {
    const dir = await runsDir('runs-silent', { jobs: launchSeries(3, 1, { prefix: 'RQ-S' }) });
    const items = await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'launch-cost' });
    expect(item!.id).toMatch(/^launch-cost-[0-9a-f]{16}$/);
    expect(item!.title).toContain('probe');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('fleet.launch-cost.v1');
    expect(item!.prompt).toContain('launch_cost.py');
    expect(item!.prompt).toContain('launch_cost_*');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain(String(LAUNCH_COST_SILENT_MIN_LAUNCHES));
  });

  it('emits the silent item for an empty or all-malformed probe file too', async () => {
    const dir = await runsDir('runs-bad', {
      jobs: launchSeries(2, 2, { prefix: 'RQ-B' }),
      cost: ['not json', '{"schema":"other.v1"}', ''],
    });
    const items = await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items.map((i) => i.id)).toHaveLength(1);
    expect(items[0]!.prompt).toContain('zero valid fleet.launch-cost.v1 rows');
  });

  it('emits per-lane coverage and cost items quoting only recorded evidence', async () => {
    const costRows = [
      // Coverage: lane 'blind' — dated unknowns across 2 days plus a partial.
      costRow({ lane: 'blind', launchId: 'RQ-V1', status: 'unknown' }),
      costRow({ lane: 'blind', launchId: 'RQ-V2', status: 'unknown', atMs: NOW_MS - DAY }),
      costRow({ lane: 'blind', launchId: 'RQ-V3', status: 'partial', atMs: NOW_MS - 2 * DAY, sampledSeconds: 30, samples: 6 }),
      // Cost: lane 'stormy' — two measured storms across 2 days.
      costRow({ lane: 'stormy', launchId: 'RQ-W1', status: 'measured', peakProcesses: 150, meanCpu: 100, peakCpu: 950 }),
      costRow({ lane: 'stormy', launchId: 'RQ-W2', status: 'measured', atMs: NOW_MS - DAY, peakProcesses: 130, meanCpu: 400, peakCpu: 900 }),
      costRow({ lane: 'stormy', launchId: 'RQ-W3', status: 'measured', atMs: NOW_MS - 2 * DAY }),
      // Healthy lane — measured rows with ordinary figures.
      costRow({ lane: 'ok', launchId: 'RQ-W4', status: 'measured', atMs: NOW_MS - DAY }),
    ];
    const dir = await runsDir('runs-cells', { jobs: launchSeries(1, 1), cost: costRows });
    const items = await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    const coverage = items.find((i) => i.prompt.includes("lane 'blind'"));
    const cost = items.find((i) => i.prompt.includes("lane 'stormy'"));
    expect(coverage).toBeDefined();
    expect(cost).toBeDefined();
    expect(coverage!.area).toBe('launch-cost');
    expect(coverage!.prompt).toContain("'unknown' or 'partial'");
    expect(coverage!.prompt).toContain('RQ-V1');
    expect(cost!.prompt).toContain('storm');
    expect(cost!.prompt).toContain('150');
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: NOW })).toEqual([]);

    // No launches proven: an empty probe file alone is not evidence.
    const quiet = await runsDir('runs-quiet', { jobs: launchSeries(1, 1, { prefix: 'RQ-Q' }) });
    expect(await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: quiet, now: NOW })).toEqual([]);
    expect(await launchCostBacklogItems({ repo: 'ashlrai/lexicon', runsDir: quiet, now: NOW })).toEqual([]);
    expect(await launchCostBacklogItems({ repo: '', runsDir: quiet, now: NOW })).toEqual([]);

    // Healthy probe evidence: measured rows only, ordinary figures.
    const healthy = await runsDir('runs-healthy', {
      jobs: launchSeries(2, 2, { prefix: 'RQ-H' }),
      cost: [0, 1, 2, 3].map((i) => costRow({ lane: 'ok', launchId: `RQ-H${i}`, status: 'measured', atMs: NOW_MS - i * DAY })),
    });
    expect(await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: healthy, now: NOW })).toEqual([]);

    // Below the day bar: one burst day of unverifiable launches.
    const thin = await runsDir('runs-thin', {
      jobs: launchSeries(1, 1),
      cost: [0, 1, 2].map((i) => costRow({ lane: 'thin', launchId: `RQ-T${i}`, status: 'unknown', atMs: NOW_MS - i * HOUR })),
    });
    expect(await launchCostBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      jobs: launchSeries(1, 1),
      cost: [
        costRow({ lane: 'blind', launchId: 'RQ-I1', status: 'unknown' }),
        costRow({ lane: 'blind', launchId: 'RQ-I2', status: 'unknown', atMs: NOW_MS - DAY }),
        costRow({ lane: 'blind', launchId: 'RQ-I3', status: 'partial', atMs: NOW_MS - 2 * DAY, sampledSeconds: 30, samples: 6 }),
        costRow({ lane: 'stormy', launchId: 'RQ-I4', status: 'measured', peakProcesses: 200, meanCpu: 100, peakCpu: 900 }),
        costRow({ lane: 'stormy', launchId: 'RQ-I5', status: 'measured', atMs: NOW_MS - DAY, peakProcesses: 130, meanCpu: 400, peakCpu: 900 }),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await launchCostBacklogItems(opts);
    const second = await launchCostBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeGreaterThanOrEqual(2);
    const limited = await launchCostBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends launch-cost items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    const realNow = Date.now();
    const at = (d: number): number => realNow - d * DAY - HOUR;
    const jobsRows = [0, 1, 2].map((d) => J({ event: 'launch', job: `RQ-D${d}`, repo: 'ashlrai/phantom', lane: 'claude', tier: 'work', ts: iso(at(d)) }));
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), jobsRows.join('\n') + '\n');
    // No launch-cost.jsonl at all — the silent cell.
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const costItems = first.items.filter((i) => i.id.startsWith('launch-cost-'));
    expect(costItems).toHaveLength(1);
    expect(costItems[0]!.area).toBe('launch-cost');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(costItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('launch-cost-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('launch-cost-'))).toHaveLength(1);
  });
});
