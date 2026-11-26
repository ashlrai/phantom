import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bet } from '../src/core/metrics/bets.js';
import {
  BET_OUTCOME_KILLED_RECURRING,
  BET_OUTCOME_MAX_ITEMS,
  betOutcomeBacklogItems,
  foldBetOutcomeCells,
} from '../src/core/improve/bet-outcome-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const NOW = Date.now();
const DAY = 24 * HOUR;

const bet = (over: Partial<Bet> & { id: string; metric: string }): Bet => ({
  hypothesis: `move ${over.metric}`,
  direction: 'up',
  baseline: 1,
  minDelta: 0,
  launchedAt: new Date(NOW - DAY).toISOString(),
  budget: { maxLaneHours: 4, maxCycles: 3 },
  killCriterion: 'test',
  status: 'launched',
  cycles: 0,
  measured: null,
  decidedAt: null,
  reason: null,
  ...over,
});

const scorerKilled = (id: string, metric: string, minsAgo: number, reason = 'killed: over budget (lane-hours 5/4, cycle 3/3) and merges_per_hour.6h 1 -> 1 (delta 0, need > 0 up)'): Bet =>
  bet({ id, metric, status: 'killed', decidedAt: new Date(NOW - minsAgo * MIN).toISOString(), reason, cycles: 3 });
const kept = (id: string, metric: string, minsAgo: number): Bet =>
  bet({ id, metric, status: 'kept', decidedAt: new Date(NOW - minsAgo * MIN).toISOString(), reason: 'kept: 1 merged and metric moved', cycles: 2 });
const operatorKilled = (id: string, metric: string, minsAgo: number): Bet =>
  bet({ id, metric, status: 'killed', decidedAt: new Date(NOW - minsAgo * MIN).toISOString(), reason: 'killed by operator: superseded by RQ-BET-NEW', cycles: 1 });

describe('foldBetOutcomeCells', () => {
  const opts = { nowMs: NOW, windowHours: 168 };

  it('groups scorer-killed bets per metric with kept context and example bets', () => {
    const cells = foldBetOutcomeCells([
      scorerKilled('RQ-BET-A1', 'merges_per_hour.6h', 60),
      scorerKilled('RQ-BET-A2', 'merges_per_hour.6h', 120),
      scorerKilled('RQ-BET-A3', 'merges_per_hour.6h', 180),
      kept('RQ-BET-A4', 'merges_per_hour.6h', 200),
      scorerKilled('RQ-BET-B1', 'tokens_per_merge', 60),
      scorerKilled('RQ-BET-B2', 'tokens_per_merge', 120),
      scorerKilled('RQ-BET-B3', 'tokens_per_merge', 180),
      kept('RQ-BET-B4', 'tokens_per_merge', 190),
    ], opts);
    expect(cells.map((c) => [c.metric, c.killed, c.kept])).toEqual([
      ['merges_per_hour.6h', 3, 1],
      ['tokens_per_merge', 3, 1],
    ]);
    const cell = cells[0]!;
    expect(cell.examples.map((e) => e.id)).toEqual(['RQ-BET-A1', 'RQ-BET-A2', 'RQ-BET-A3']);
    expect(cell.examples[0]!.reason).toContain('killed: over budget');
    expect(cell.examples[0]!.hypothesis).toBe('move merges_per_hour.6h');
    expect(cell.firstDecided).toBe(new Date(NOW - 180 * MIN).toISOString());
    expect(cell.lastDecided).toBe(new Date(NOW - 60 * MIN).toISOString());
  });

  it('never counts operator kills, in-flight bets or decisions outside the window', () => {
    const cells = foldBetOutcomeCells([
      operatorKilled('RQ-BET-O1', 'merges_per_hour.6h', 30),
      operatorKilled('RQ-BET-O2', 'merges_per_hour.6h', 40),
      operatorKilled('RQ-BET-O3', 'merges_per_hour.6h', 50),
      scorerKilled('RQ-BET-O4', 'merges_per_hour.6h', 8 * 24 * 60), // 8 days ago: outside the 7-day window
      bet({ id: 'RQ-BET-O5', metric: 'merges_per_hour.6h', status: 'launched' }),
      bet({ id: 'RQ-BET-O6', metric: 'merges_per_hour.6h', status: 'killed', decidedAt: 'not a date', reason: 'killed: x' }),
      scorerKilled('RQ-BET-O7', 'merges_per_hour.6h', 60),
      scorerKilled('RQ-BET-O8', 'merges_per_hour.6h', 120),
    ], opts);
    // Only two in-window scorer kills — under the recurring bar.
    expect(cells).toEqual([]);
  });

  it('drops cells below the recurring bar and sorts strongest first', () => {
    expect(BET_OUTCOME_KILLED_RECURRING).toBe(3);
    const cells = foldBetOutcomeCells([
      scorerKilled('RQ-BET-S1', 'weak_metric', 60),
      scorerKilled('RQ-BET-S2', 'weak_metric', 120),
      scorerKilled('RQ-BET-S3', 'strong_metric', 60),
      scorerKilled('RQ-BET-S4', 'strong_metric', 120),
      scorerKilled('RQ-BET-S5', 'strong_metric', 180),
      scorerKilled('RQ-BET-S6', 'strong_metric', 240),
    ], opts);
    expect(cells.map((c) => c.metric)).toEqual(['strong_metric']);
    expect(cells[0]!.killed).toBe(4);
  });
});

describe('betOutcomeBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'bet-outcome-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding metrics/bets.jsonl. */
  async function runsDir(name: string, ledger: string[] | null | undefined): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (ledger !== undefined && ledger !== null) {
      await writeFile(join(dir, 'metrics', 'bets.jsonl'), ledger.join('\n') + '\n');
    }
    return dir;
  }

  const LEDGER = 'bets.ledger.v1';
  const launch = (id: string, metric: string, minsAgo: number): string => J({
    schema: LEDGER, event: 'launch', ts: new Date(NOW - (minsAgo + 120) * MIN).toISOString(),
    bet: {
      id, hypothesis: `move ${metric}`, metric, direction: 'up', baseline: 1, minDelta: 0,
      launchedAt: new Date(NOW - (minsAgo + 120) * MIN).toISOString(),
      budget: { maxLaneHours: 4, maxCycles: 3 }, killCriterion: 'over budget without movement',
    },
  });
  const score = (id: string, decision: 'kept' | 'killed' | 'hold', minsAgo: number, reason: string): string => J({
    schema: LEDGER, event: 'score', ts: new Date(NOW - minsAgo * MIN).toISOString(),
    decision: {
      id, decision, reason, cycle: 3,
      numbers: { value: 1, laneHours: 5, merged: 0, jobs: 1, baseline: 1, delta: 0, moved: false, overBudget: true, maxLaneHours: 4, maxCycles: 3 },
    },
  });
  const kill = (id: string, minsAgo: number, reason: string): string => J({
    schema: LEDGER, event: 'kill', ts: new Date(NOW - minsAgo * MIN).toISOString(), id, reason,
  });
  const KILL_REASON = 'killed: over budget (lane-hours 5/4, cycle 3/3) and merges_per_hour.6h 1 -> 1 (delta 0, need > 0 up)';

  it('emits a bet-outcomes item for a recurring scorer-killed metric and validates it', async () => {
    const dir = await runsDir('runs-killed', [
      launch('RQ-BET-ALPHA-1', 'merges_per_hour.6h', 300),
      score('RQ-BET-ALPHA-1', 'killed', 180, KILL_REASON),
      launch('RQ-BET-ALPHA-2', 'merges_per_hour.6h', 280),
      score('RQ-BET-ALPHA-2', 'killed', 120, KILL_REASON),
      launch('RQ-BET-ALPHA-3', 'merges_per_hour.6h', 260),
      score('RQ-BET-ALPHA-3', 'killed', 60, KILL_REASON),
      launch('RQ-BET-ALPHA-4', 'merges_per_hour.6h', 240),
      score('RQ-BET-ALPHA-4', 'kept', 30, 'kept: 1 merged and metric moved'),
      launch('RQ-BET-OTHER-1', 'tokens_per_merge', 200),
      score('RQ-BET-OTHER-1', 'killed', 100, 'killed: over budget'),
    ]);
    const items = await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'bet-outcomes' });
    expect(item!.id).toMatch(/^bet-outcome-[0-9a-f]{16}$/);
    expect(item!.title).toContain('merges_per_hour.6h');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('3 recorded scorer-killed bets');
    expect(item!.prompt).toContain('1 kept bet on the same metric');
    expect(item!.prompt).toContain('RQ-BET-ALPHA-1');
    expect(item!.prompt).toContain('bets.ledger.v1');
    expect(item!.prompt).toContain('phm bets score');
    expect(item!.prompt).toContain('no-change');
    // The single kill on tokens_per_merge stays under the bar.
    expect(item!.prompt).not.toContain('tokens_per_merge');
  });

  it('never counts operator kills toward the recurring bar', async () => {
    const dir = await runsDir('runs-operator', [
      launch('RQ-BET-OP1', 'merges_per_hour.6h', 300),
      kill('RQ-BET-OP1', 200, 'killed by operator: hypothesis retired'),
      launch('RQ-BET-OP2', 'merges_per_hour.6h', 280),
      kill('RQ-BET-OP2', 150, 'killed by operator: duplicate of RQ-BET-OP1'),
      launch('RQ-BET-OP3', 'merges_per_hour.6h', 260),
      kill('RQ-BET-OP3', 100, 'killed by operator: owner call'),
      launch('RQ-BET-OP4', 'merges_per_hour.6h', 240),
      score('RQ-BET-OP4', 'killed', 50, KILL_REASON),
    ]);
    expect(await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing below the recurring bar, for a missing ledger, or another repository', async () => {
    const quiet = await runsDir('runs-quiet', [
      launch('RQ-BET-Q1', 'merges_per_hour.6h', 300),
      score('RQ-BET-Q1', 'killed', 200, KILL_REASON),
      launch('RQ-BET-Q2', 'merges_per_hour.6h', 280),
      score('RQ-BET-Q2', 'killed', 100, KILL_REASON),
    ]);
    expect(await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: quiet, now: new Date(NOW) })).toEqual([]);
    expect(BET_OUTCOME_KILLED_RECURRING).toBe(3);

    expect(await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);
    const empty = await runsDir('runs-empty', null);
    expect(await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      launch('RQ-BET-P1', 'merges_per_hour.6h', 300),
      score('RQ-BET-P1', 'killed', 200, KILL_REASON),
      launch('RQ-BET-P2', 'merges_per_hour.6h', 280),
      score('RQ-BET-P2', 'killed', 150, KILL_REASON),
      launch('RQ-BET-P3', 'merges_per_hour.6h', 260),
      score('RQ-BET-P3', 'killed', 100, KILL_REASON),
    ]);
    expect(await betOutcomeBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await betOutcomeBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('ignores kills decided outside the window and in-flight bets', async () => {
    const dir = await runsDir('runs-window', [
      launch('RQ-BET-W1', 'merges_per_hour.6h', 24 * 60 * 8),
      score('RQ-BET-W1', 'killed', 24 * 60 * 7 - 1, KILL_REASON), // just inside 7d? decidedAt = NOW - (7d-1m)
      launch('RQ-BET-W2', 'merges_per_hour.6h', 24 * 60 * 8),
      score('RQ-BET-W2', 'killed', 24 * 60 * 7 + 1, KILL_REASON), // outside: 7d+1m ago
      launch('RQ-BET-W3', 'merges_per_hour.6h', 100),
      score('RQ-BET-W3', 'hold', 50, 'hold: lane-hours 2/4, cycle 1/3; 0 merged'),
      launch('RQ-BET-W4', 'merges_per_hour.6h', 90),
      score('RQ-BET-W4', 'killed', 40, KILL_REASON),
      launch('RQ-BET-W5', 'merges_per_hour.6h', 80),
      score('RQ-BET-W5', 'killed', 30, KILL_REASON),
    ]);
    // W2 is outside the window; W3 is still launched (last decision hold); W1, W4, W5 are in-window kills = 3.
    const items = await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3 recorded scorer-killed bets');
    expect(items[0]!.prompt).not.toContain('RQ-BET-W2');
  });

  it('states counts as recorded floors when the fold ignored events', async () => {
    const dir = await runsDir('runs-partial', [
      launch('RQ-BET-I1', 'merges_per_hour.6h', 300),
      score('RQ-BET-I1', 'killed', 200, KILL_REASON),
      launch('RQ-BET-I2', 'merges_per_hour.6h', 280),
      score('RQ-BET-I2', 'killed', 120, KILL_REASON),
      'not json at all',
      launch('RQ-BET-I3', 'merges_per_hour.6h', 260),
      score('RQ-BET-I3', 'killed', 60, KILL_REASON),
    ]);
    const items = await betOutcomeBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 3 recorded scorer-killed bets');
  });

  it('derives stable ids per metric cell so a refresh re-adds nothing and honours the limit', async () => {
    const ledger: string[] = [];
    for (const [metric, prefix] of [['metric_a', 'A'], ['metric_b', 'B'], ['metric_c', 'C']] as const) {
      for (let i = 1; i <= 3; i += 1) {
        ledger.push(launch(`RQ-BET-${prefix}${i}`, metric, 300 - i * 10));
        ledger.push(score(`RQ-BET-${prefix}${i}`, 'killed', 200 - i * 10, KILL_REASON));
      }
    }
    const dir = await runsDir('runs-stable', ledger);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await betOutcomeBacklogItems(opts);
    const second = await betOutcomeBacklogItems(opts);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(3);
    expect(first.length).toBeLessThanOrEqual(BET_OUTCOME_MAX_ITEMS);
    expect(await betOutcomeBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends bet-outcome items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'bets.jsonl'), [
      launch('RQ-BET-D1', 'merges_per_hour.6h', 300),
      score('RQ-BET-D1', 'killed', 200, KILL_REASON),
      launch('RQ-BET-D2', 'merges_per_hour.6h', 280),
      score('RQ-BET-D2', 'killed', 120, KILL_REASON),
      launch('RQ-BET-D3', 'merges_per_hour.6h', 260),
      score('RQ-BET-D3', 'killed', 60, KILL_REASON),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const betItems = first.items.filter((i) => i.id.startsWith('bet-outcome-'));
    expect(betItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(betItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('bet-outcome-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('bet-outcome-'))).toHaveLength(1);
  });
});
