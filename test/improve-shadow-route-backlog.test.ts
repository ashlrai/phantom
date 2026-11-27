import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldShadowJournal,
  SHADOW_ROUTE_MAX_ITEMS,
  SHADOW_ROUTE_MIN_DISAGREEMENTS,
  SHADOW_ROUTE_WINDOW_MS,
  shadowRouteBacklogItems,
  shadowRouteCells,
} from '../src/core/improve/shadow-route-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture `at` stamps are ISO like recordShadowPolicyDecision writes. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
/** ISO timestamp `msAgo` milliseconds before NOW_MS. */
const iso = (msAgo: number): string => new Date(NOW_MS - msAgo).toISOString();

/** One advisory route.shadow.v1 record in the producer's shape; spec keys override the defaults. */
function shadowRow(atIso: string, spec: Record<string, unknown> = {}): string {
  return J({
    schema: 'route.shadow.v1',
    advisory: true,
    dispatched: false,
    at: atIso,
    policy: 'class-failure-avoidance',
    job: 'RQ-AAA1',
    repo: 'phantom',
    task_class: 'bug-fix',
    tier_hint: 'work',
    eligible_lanes: ['claude', 'codex'],
    live_lane: 'claude',
    shadow_lane: 'codex',
    disagreed: true,
    support_status: 'supported',
    reason_codes: ['task_class_failure_avoidance', 'no_escalation'],
    lane_stats: [],
    ...spec,
  });
}

/** n supported disagreements for one (repo, task_class) cell spread across `days` distinct UTC days. */
function disagreeSeries(days: number, perDay: number, spec: Record<string, unknown> = {}): string[] {
  const rows: string[] = [];
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      rows.push(shadowRow(iso(d * DAY + i * HOUR), spec));
    }
  }
  return rows;
}

/** jobs.jsonl rows resolving the given job ids: 'fail' closes or reverts, 'good' merges, 'open' stays unresolved. */
function outcomeRows(jobs: Record<string, 'fail' | 'good' | 'open'>): string[] {
  const rows: string[] = [];
  for (const [job, kind] of Object.entries(jobs)) {
    if (kind === 'fail') rows.push(J({ job, state: 'CLOSED', ts: iso(HOUR) }));
    else if (kind === 'good') rows.push(J({ job, state: 'MERGED', ts: iso(HOUR) }));
    else rows.push(J({ job, ts: iso(HOUR) }));
  }
  return rows;
}

describe('foldShadowJournal', () => {
  it('keeps only in-window route.shadow.v1 records of the producer contract', () => {
    const rows = [
      shadowRow(iso(0)),
      shadowRow(iso(HOUR)),
      // Wrong schema, wrong advisory/dispatched, unknown policy, bad repo, bad support, bad at, non-JSON.
      J({ ...JSON.parse(shadowRow(iso(0))), schema: 'other.v9' }),
      J({ ...JSON.parse(shadowRow(iso(0))), advisory: false }),
      J({ ...JSON.parse(shadowRow(iso(0))), dispatched: true }),
      shadowRow(iso(0), { policy: 'made-up-policy' }),
      shadowRow(iso(0), { repo: 'not a repo!' }),
      shadowRow(iso(0), { support_status: 'maybe' }),
      shadowRow('not a date'),
      'not json {"schema":"route.shadow.v1"',
      '',
      // Out-of-window and beyond the +300 s skew: skipped as non-evidence, not invalid.
      shadowRow(iso(SHADOW_ROUTE_WINDOW_MS + 10_000)),
      shadowRow(new Date(NOW_MS + 600_000).toISOString()),
    ].join('\n');
    const fold = foldShadowJournal(rows, NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    expect(fold.records).toBe(2);
    // The wrong-schema row never reaches the parse — the schema prefilter
    // skips it silently; the seven route.shadow.v1 claimants that fail the
    // contract (advisory, dispatched, policy, repo, support, at, non-JSON)
    // all count invalid. Out-of-window/future rows are skipped, not invalid.
    expect(fold.invalidRows).toBe(7);
    expect(fold.cells.size).toBe(1);
  });

  it('counts only supported live!==shadow divergence as cell evidence', () => {
    const rows = [
      // Supported disagreement — counts.
      shadowRow(iso(0), { job: 'RQ-A1' }),
      // Stored disagreed flag is never trusted: recomputed live!==shadow rules.
      shadowRow(iso(HOUR), { job: 'RQ-A2', disagreed: false }),
      shadowRow(iso(2 * HOUR), { job: 'RQ-A3', disagreed: true, live_lane: 'codex', shadow_lane: 'codex' }),
      // Echo picks and empty candidate sets are not divergence.
      shadowRow(iso(3 * HOUR), { job: 'RQ-A4', support_status: 'insufficient_support', shadow_lane: 'claude' }),
      shadowRow(iso(4 * HOUR), { job: 'RQ-A5', support_status: 'no_candidates', shadow_lane: null, live_lane: 'claude' }),
      // A job-less record still counts as divergence but can never resolve.
      shadowRow(iso(5 * HOUR), { job: null }),
      // A different (repo, task_class) lands in its own cell.
      shadowRow(iso(6 * HOUR), { job: 'RQ-B1', repo: 'lexicon', task_class: 'feature' }),
    ].join('\n');
    const fold = foldShadowJournal(rows, NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    expect(fold.records).toBe(7);
    const cell = fold.cells.get('phantom\u0000bug-fix');
    // A1, A2 (stored disagreed:false but live!==shadow recomputes true) and
    // the job-less record count; A3's live===shadow, the insufficient_support
    // echo and the no_candidates null never do.
    expect(cell?.disagreements).toBe(3);
    expect(cell?.pending).toHaveLength(3);
    expect(fold.cells.get('lexicon\u0000feature')?.disagreements).toBe(1);
  });
});

describe('shadowRouteCells', () => {
  const outcomes = (entries: Record<string, { merged: boolean | null; reverted: boolean | null; repo?: string | null }>) =>
    new Map(Object.entries(entries).map(([k, v]) => [k, { repo: null, ...v }]));

  it('emits only at the disagreement, day and adverse-failure bars', () => {
    // Below the disagreement bar.
    const few = foldShadowJournal(disagreeSeries(2, 1).join('\n'), NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    expect(few.cells.get('phantom\u0000bug-fix')!.disagreements).toBeLessThan(SHADOW_ROUTE_MIN_DISAGREEMENTS);
    expect(shadowRouteCells(few, outcomes({}))).toEqual([]);

    // One day only — a burst, not a pattern.
    const oneDay = foldShadowJournal(disagreeSeries(1, SHADOW_ROUTE_MIN_DISAGREEMENTS + 2).join('\n'), NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    expect(oneDay.cells.get('phantom\u0000bug-fix')!.days.size).toBe(1);
    expect(shadowRouteCells(oneDay, outcomes({}))).toEqual([]);

    // Recurring divergence but no resolved failures: quiet.
    const quiet = foldShadowJournal(disagreeSeries(3, 2).join('\n'), NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    expect(shadowRouteCells(quiet, outcomes({}))).toEqual([]);
    expect(shadowRouteCells(quiet)).toEqual([]); // no outcome map at all — unknown stays unknown

    // Failures below the bar or below half of resolved: quiet.
    const thinFailures = foldShadowJournal(
      disagreeSeries(3, 2, { job: 'RQ-F1' }).concat(disagreeSeries(3, 2, { job: 'RQ-F2' })).join('\n'),
      NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    const oneFailure = outcomes({ 'RQ-F1': { merged: false, reverted: null }, 'RQ-F2': { merged: true, reverted: null } });
    // 12 disagreements, resolved=2 (one per job id — wait: each job id appears on 6 records).
    // Every record joins the same outcome per job, so resolved=12, failures=6, goods=6 → exactly half → emits.
    const emitted = shadowRouteCells(thinFailures, oneFailure);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ repo: 'phantom', task_class: 'bug-fix', disagreements: 12, resolved: 12, failures: 6, goods: 6, unresolved: 0 });

    const minority = outcomes({ 'RQ-F1': { merged: false, reverted: null }, 'RQ-F2': { merged: true, reverted: null }, 'RQ-F3': { merged: true, reverted: null } });
    const threeJobs = foldShadowJournal(
      disagreeSeries(2, 2, { job: 'RQ-F1' }).concat(disagreeSeries(2, 2, { job: 'RQ-F2' }), disagreeSeries(2, 2, { job: 'RQ-F3' })).join('\n'),
      NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    // resolved=12, failures=4 (RQ-F1's 4 records), goods=8 → 4*2=8 < 12 → below the adverse bar.
    expect(shadowRouteCells(threeJobs, minority)).toEqual([]);
  });

  it('joins outcomes through the report repo-match guard and counts unresolved honestly', () => {
    const rows = [
      ...disagreeSeries(2, 2, { job: 'RQ-G1' }),
      ...disagreeSeries(2, 1, { job: 'RQ-G2' }),
      ...disagreeSeries(2, 1, { job: 'RQ-G3' }),
      shadowRow(iso(0), { job: 'RQ-G4', repo: 'phantom', task_class: 'bug-fix' }),
      shadowRow(iso(HOUR), { job: 'RQ-G5' }),
      // A different record repo lands in its own below-bar cell — never joins this one.
      shadowRow(iso(2 * HOUR), { job: 'RQ-G6', repo: 'otherrepo' }),
    ].join('\n');
    const fold = foldShadowJournal(rows, NOW_MS, SHADOW_ROUTE_WINDOW_MS);
    const cell = fold.cells.get('phantom\u0000bug-fix')!;
    // G1×4 + G2×2 + G3×2 + G4 + G5 = 10 supported disagreements over 2 days;
    // the otherrepo row lands in its own below-bar cell.
    expect(cell.disagreements).toBe(10);
    const map = outcomes({
      'RQ-G1': { merged: false, reverted: null },   // failure ×4
      'RQ-G2': { merged: true, reverted: null },    // good ×2
      'RQ-G3': { merged: null, reverted: true },    // failure ×2 (reverted alone is failure)
      'RQ-G4': { merged: true, reverted: null, repo: 'lexicon' }, // repo mismatch → unresolved
      'RQ-G5': { merged: null, reverted: null },    // unresolved
      'RQ-G6': { merged: false, reverted: null },   // sits in the below-bar otherrepo cell — never reached
    });
    const cells = shadowRouteCells(fold, map);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      repo: 'phantom', task_class: 'bug-fix',
      disagreements: 10, resolved: 8, failures: 6, goods: 2, unresolved: 2,
    });
    expect(cells[0]!.days).toHaveLength(2);
  });
});

describe('shadowRouteBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'shadow-route-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose metrics/route.shadow.jsonl and metrics/jobs.jsonl carry the given rows. */
  async function runsDir(name: string, shadow: string[], jobs: string[] = []): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'metrics', 'route.shadow.jsonl'), shadow.join('\n') + '\n');
    if (jobs.length > 0) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.join('\n') + '\n');
    return dir;
  }

  it('emits an item for a recurring adverse divergence cell', async () => {
    const shadow = [
      ...disagreeSeries(3, 2, { job: 'RQ-H1' }),
      ...disagreeSeries(3, 2, { job: 'RQ-H2' }),
      ...disagreeSeries(3, 1, { job: 'RQ-H3' }),
    ];
    const jobs = outcomeRows({ 'RQ-H1': 'fail', 'RQ-H2': 'fail', 'RQ-H3': 'good' });
    const dir = await runsDir('runs-cell', shadow, jobs);
    const items = await shadowRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'route-shadow' });
    expect(item.id).toMatch(/^shadow-route-[0-9a-f]{16}$/);
    expect(item.title).toContain('phantom');
    expect(item.title).toContain('bug-fix');
    expect(item.prompt).toContain('route.shadow.jsonl');
    expect(item.prompt).toContain('counterfactual');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).not.toContain('lower bound');
  });

  it('emits nothing for missing evidence, another repository, or below-bar cells', async () => {
    expect(await shadowRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'nope'), now: new Date(NOW_MS) })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await shadowRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);

    // A journal directory instead of a file.
    const notFile = join(home, 'runs-notfile');
    await mkdir(join(notFile, 'metrics', 'route.shadow.jsonl'), { recursive: true });
    expect(await shadowRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: notFile, now: new Date(NOW_MS) })).toEqual([]);

    // Recurring divergence but every pick resolves good — no adverse signal.
    const agreedWins = [
      ...disagreeSeries(3, 2, { job: 'RQ-W1' }),
      ...disagreeSeries(3, 2, { job: 'RQ-W2' }),
    ];
    const goodDir = await runsDir('runs-good', agreedWins, outcomeRows({ 'RQ-W1': 'good', 'RQ-W2': 'good' }));
    expect(await shadowRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: goodDir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await shadowRouteBacklogItems({ repo: 'ashlrai/lexicon', runsDir: goodDir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await shadowRouteBacklogItems({ repo: '', runsDir: goodDir, now: new Date(NOW_MS) })).toEqual([]);

    // Below the day bar: one burst day of divergence.
    const thin = await runsDir('runs-thin', disagreeSeries(1, SHADOW_ROUTE_MIN_DISAGREEMENTS + 4), outcomeRows({ 'RQ-AAA1': 'fail' }));
    expect(await shadowRouteBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: new Date(NOW_MS) })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const shadow = [
      ...disagreeSeries(3, 2, { job: 'RQ-S1', repo: 'phantom', task_class: 'bug-fix' }),
      ...disagreeSeries(3, 2, { job: 'RQ-S2', repo: 'phantom', task_class: 'feature' }),
    ];
    const jobs = outcomeRows({ 'RQ-S1': 'fail', 'RQ-S2': 'fail' });
    const dir = await runsDir('runs-stable', shadow, jobs);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await shadowRouteBacklogItems(opts);
    const second = await shadowRouteBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(2);
    expect(first.length).toBeLessThanOrEqual(SHADOW_ROUTE_MAX_ITEMS);
    const limited = await shadowRouteBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('appends shadow-route items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_MS);
    try {
      const runs = join(home, '.ashlr-runs');
      await mkdir(join(runs, 'metrics'), { recursive: true });
      const shadow = [
        ...disagreeSeries(3, 2, { job: 'RQ-D1' }),
        ...disagreeSeries(3, 2, { job: 'RQ-D2' }),
      ];
      await writeFile(join(runs, 'metrics', 'route.shadow.jsonl'), shadow.join('\n') + '\n');
      await writeFile(join(runs, 'metrics', 'jobs.jsonl'), outcomeRows({ 'RQ-D1': 'fail', 'RQ-D2': 'fail' }).join('\n') + '\n');
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const shadowItems = first.items.filter((i) => i.id.startsWith('shadow-route-'));
      expect(shadowItems).toHaveLength(1);
      expect(shadowItems[0]!.area).toBe('route-shadow');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(shadowItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('shadow-route-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('shadow-route-'))).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
