import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BETS_LEDGER_SCHEMA, betDelta, betsCounts, betsShare, foldBets, isBetRow, launchEvent, scoreBet, BetInputError, type Bet,
} from '../src/core/metrics/bets.js';
import { killBet, launchBet, readBets, scoreCycle } from '../src/core/metrics/bets-store.js';
import type { LoopReaders } from '../src/core/metrics/loop-collect.js';
import { cmdBets } from '../src/cli/bets.js';

const T0 = Date.parse('2026-11-16T12:00:00Z');
const iso = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();

function bet(over: Partial<Bet> = {}): Bet {
  return {
    id: 'RQ-BET-X', hypothesis: 'h', metric: 'merges_per_hour.6h', direction: 'up', baseline: 2, minDelta: 0,
    launchedAt: iso(600), budget: { maxLaneHours: 4, maxCycles: 3 }, killCriterion: 'k', status: 'launched', cycles: 0,
    measured: null, decidedAt: null, reason: null, ...over,
  };
}

describe('isBetRow', () => {
  it('tags rows by RQ-BET- id prefix or bet: tier', () => {
    expect(isBetRow({ id: 'RQ-BET-SPEED', tier: 'work' })).toBe(true);
    expect(isBetRow({ id: 'RQ-OTHER', tier: 'bet:frontier' })).toBe(true);
    expect(isBetRow({ id: 'RQ-OTHER', tier: 'work' })).toBe(false);
    expect(isBetRow({ id: 'rq-bet-lower', tier: 'betting' })).toBe(false);
    expect(isBetRow({})).toBe(false);
  });
});

describe('betsShare', () => {
  it('reserves 10 percent of free slots by default, floor, at least 1', () => {
    expect(betsShare({ freeSlots: 30 }).reserved).toBe(3);
    expect(betsShare({ freeSlots: 19 }).reserved).toBe(1);
    expect(betsShare({ freeSlots: 1 }).reserved).toBe(1);
  });
  it('reserves nothing when no slot is free or free slots are unknown', () => {
    expect(betsShare({ freeSlots: 0 })).toMatchObject({ reserved: 0, usable: 0, reason: 'no free slots' });
    expect(betsShare({ freeSlots: null })).toMatchObject({ reserved: 0, reason: expect.stringContaining('unknown') });
    expect(betsShare({ freeSlots: -2 }).reserved).toBe(0);
    expect(betsShare({ freeSlots: 2.5 }).reserved).toBe(0);
  });
  it('honours share, minimum and the off switch, never exceeding free', () => {
    expect(betsShare({ freeSlots: 10 }, { share: 0.5 }).reserved).toBe(5);
    expect(betsShare({ freeSlots: 2 }, { minWhenFree: 5 }).reserved).toBe(2);
    expect(betsShare({ freeSlots: 10 }, { minWhenFree: 0, share: 0 }).reserved).toBe(0);
    expect(betsShare({ freeSlots: 10 }, { enabled: false })).toMatchObject({ reserved: 0, enabled: false });
    expect(betsShare({ freeSlots: 10 }, { share: 7 }).share).toBe(0.1);
  });
  it('limits usable slots to ready bet rows when the queue was read', () => {
    expect(betsShare({ freeSlots: 40, readyBetRows: 1 })).toMatchObject({ reserved: 4, usable: 1, readyBetRows: 1 });
    expect(betsShare({ freeSlots: 40, readyBetRows: null })).toMatchObject({ reserved: 4, usable: 4 });
  });
});

describe('launchEvent', () => {
  const ok = { id: 'RQ-BET-A', hypothesis: 'Faster merges', metric: 'merges_per_hour.6h', budget: { maxLaneHours: 2, maxCycles: 3 } };
  it('builds a launch event with defaults', () => {
    const e = launchEvent(ok, iso(0));
    expect(e).toMatchObject({ schema: BETS_LEDGER_SCHEMA, event: 'launch', bet: { direction: 'up', minDelta: 0, baseline: null } });
    expect(e.event === 'launch' && e.bet.killCriterion).toContain('2 lane-hours');
  });
  it.each([
    [{ id: 'RQ-X' }, 'bet id'], [{ hypothesis: ' ' }, 'hypothesis'], [{ metric: 'Bad Key' }, 'metric'],
    [{ budget: { maxLaneHours: 0, maxCycles: 1 } }, 'lane-hours'], [{ budget: { maxLaneHours: 1, maxCycles: 0 } }, 'cycles'],
    [{ minDelta: -1 }, 'min delta'], [{ baseline: Number.NaN }, 'baseline'], [{ hypothesis: 'bad\u0007bell' }, 'hypothesis'],
  ])('rejects %j', (patch, message) => {
    expect(() => launchEvent({ ...ok, ...patch } as never, iso(0))).toThrow(BetInputError);
    expect(() => launchEvent({ ...ok, ...patch } as never, iso(0))).toThrow(message);
  });
});

describe('foldBets', () => {
  const launch = (id: string) => JSON.stringify(launchEvent({ id, hypothesis: 'h', metric: 'spare_slots', baseline: 1, budget: { maxLaneHours: 1, maxCycles: 2 } }, iso(60)));
  it('folds launch, score and kill in order and ignores junk', () => {
    const b = bet({ id: 'RQ-BET-A', metric: 'spare_slots', baseline: 1 });
    const hold = scoreBet(b, { value: 1, laneHours: 0.5, merged: 0, jobs: 1 });
    const lines = [launch('RQ-BET-A'), 'not json', '{"schema":"other"}', JSON.stringify({ schema: BETS_LEDGER_SCHEMA, event: 'score', ts: iso(30), decision: hold })];
    const f = foldBets(lines.join('\n'));
    expect(f.ignored).toBe(2);
    expect(f.bets[0]).toMatchObject({ status: 'launched', cycles: 1, measured: { value: 1, delta: 0 } });
  });
  it('ignores duplicate launches, unknown ids and events after a terminal state', () => {
    const kill = JSON.stringify({ schema: BETS_LEDGER_SCHEMA, event: 'kill', ts: iso(10), id: 'RQ-BET-A', reason: 'r' });
    const ghost = JSON.stringify({ schema: BETS_LEDGER_SCHEMA, event: 'kill', ts: iso(10), id: 'RQ-BET-NOPE', reason: 'r' });
    const f = foldBets([launch('RQ-BET-A'), launch('RQ-BET-A'), kill, kill, ghost].join('\n'));
    expect(f.bets).toHaveLength(1);
    expect(f.bets[0]!.status).toBe('killed');
    expect(f.ignored).toBe(3);
  });
  it('handles a null ledger', () => {
    expect(foldBets(null)).toEqual({ bets: [], ignored: 0 });
  });
});

describe('scoreBet (kill fast)', () => {
  it('keeps a bet that merged and moved its metric', () => {
    const d = scoreBet(bet(), { value: 3, laneHours: 1, merged: 1, jobs: 1 });
    expect(d.decision).toBe('kept');
    expect(d.numbers).toMatchObject({ delta: 1, moved: true, baseline: 2, value: 3 });
    expect(d.reason).toContain('merges_per_hour.6h 2 -> 3');
  });
  it('kills a bet over its lane-hour budget without movement', () => {
    const d = scoreBet(bet(), { value: 2, laneHours: 5, merged: 1, jobs: 2 });
    expect(d.decision).toBe('killed');
    expect(d.reason).toContain('lane-hours 5/4');
    expect(d.numbers.overBudget).toBe(true);
  });
  it('kills on the last allowed cycle without movement', () => {
    expect(scoreBet(bet({ cycles: 2 }), { value: 1, laneHours: 0, merged: 0, jobs: 0 }).decision).toBe('killed');
    expect(scoreBet(bet({ cycles: 1 }), { value: 1, laneHours: 0, merged: 0, jobs: 0 }).decision).toBe('hold');
  });
  it('kills an over-budget bet that moved the metric but merged nothing', () => {
    const d = scoreBet(bet({ cycles: 2 }), { value: 9, laneHours: 1, merged: 0, jobs: 3 });
    expect(d.decision).toBe('killed');
    expect(d.reason).toContain('0 of 3 jobs merged');
  });
  it('never counts an unknown metric or baseline as moved', () => {
    expect(scoreBet(bet(), { value: null, laneHours: 1, merged: 1, jobs: 1 }).decision).toBe('hold');
    expect(scoreBet(bet({ baseline: null }), { value: 5, laneHours: 1, merged: 1, jobs: 1 }).decision).toBe('hold');
  });
  it('does not treat unknown lane-hours as over budget', () => {
    expect(scoreBet(bet(), { value: 2, laneHours: null, merged: 0, jobs: 1 }).decision).toBe('hold');
  });
  it('respects direction down and minDelta', () => {
    expect(betDelta({ baseline: 10, direction: 'down' }, 7)).toBe(3);
    expect(scoreBet(bet({ direction: 'down', baseline: 10, minDelta: 5 }), { value: 7, laneHours: 1, merged: 1, jobs: 1 }).decision).toBe('hold');
    expect(scoreBet(bet({ direction: 'down', baseline: 10, minDelta: 2 }), { value: 7, laneHours: 1, merged: 1, jobs: 1 }).decision).toBe('kept');
  });
});

describe('betsCounts', () => {
  it('counts launched, kept and killed', () => {
    expect(betsCounts([bet(), bet({ status: 'kept' }), bet({ status: 'killed' })])).toEqual({ launched: 3, kept: 1, killed: 1 });
  });
});

function readers(runsDir: string, files: Record<string, string>, over: Partial<LoopReaders> = {}): LoopReaders {
  return {
    runsDir, now: () => T0,
    readText: async (path) => files[path.slice(runsDir.length + 1)] ?? null,
    gh: async () => null, installed: async () => null, nodes: () => null, peerTasks: async () => null, ncpu: () => 8,
    ...over,
  };
}

describe('bet store and CLI', () => {
  it('launches with a baseline from today\'s loop file, scores, and kills only launched bets', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'bets-'));
    mkdirSync(join(runs, 'metrics'), { recursive: true });
    const now = new Date(T0);
    const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    writeFileSync(join(runs, 'metrics', `loop-${day}.json`), JSON.stringify({ schema: 'metrics.loop.v1', throughput: { merges_per_hour: { '1h': 1, '6h': 2 }, opens_per_hour: { '1h': 0, '6h': 0 }, merged_6h: 12, opened_6h: 0 } }));
    const b = await launchBet(runs, { id: 'RQ-BET-FAST', hypothesis: 'h', metric: 'merges_per_hour.6h', budget: { maxLaneHours: 1, maxCycles: 1 } }, now);
    expect(b.baseline).toBe(2);
    await expect(launchBet(runs, { id: 'RQ-BET-FAST', hypothesis: 'h', metric: 'spare_slots', budget: { maxLaneHours: 1, maxCycles: 1 } }, now)).rejects.toThrow('already exists');

    // jobs ledger: the bet job ran 2h and merged; throughput 6h stays at 1/6 -> not moved, over budget -> killed.
    const jobs = [
      { event: 'enqueue', job: 'RQ-BET-FAST', lane: 'claude', tier: 'work', ts: iso(200) },
      { event: 'launch', job: 'RQ-BET-FAST', lane: 'claude', ts: iso(180) },
      { event: 'finish', job: 'RQ-BET-FAST', lane: 'claude', wall_s: 7200, ts: iso(60) },
      { event: 'outcome', job: 'RQ-BET-FAST', lane: 'claude', state: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/9', ts: iso(30) },
    ].map(r => JSON.stringify(r)).join('\n');
    const r = readers(runs, { 'metrics/jobs.jsonl': jobs, 'metrics/bets.jsonl': readFileSync(join(runs, 'metrics', 'bets.jsonl'), 'utf8') });
    const dry = await scoreCycle({ ...r, readText: async (p) => p.endsWith('bets.jsonl') ? readFileSync(p, 'utf8') : r.readText(p, 0) }, { dryRun: true });
    expect(dry.written).toBe(false);
    expect(dry.decisions[0]).toMatchObject({ decision: 'killed', numbers: { laneHours: 2, merged: 1, jobs: 1, value: 0.17 } });

    const lines: string[] = [];
    expect(await cmdBets(['score', '--json'], { out: l => lines.push(l), readers: r })).toBe(0);
    const scored = JSON.parse(lines[0]!);
    expect(scored.written).toBe(true);
    expect(JSON.parse(readFileSync(join(runs, 'metrics', 'bets-share.json'), 'utf8'))).toMatchObject({ schema: 'bets.share.v1' });
    const after = await readBets(runs);
    expect(after.bets[0]!.status).toBe('killed');
    await expect(killBet(runs, 'RQ-BET-FAST', 'again', now)).rejects.toThrow('already killed');
  });

  it('CLI: launch, list, kill, and usage errors', async () => {
    const runs = mkdtempSync(join(tmpdir(), 'bets-cli-'));
    const r = readers(runs, {});
    const out: string[] = [], err: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => err.push(l), readers: r, now: () => new Date(T0) };
    expect(await cmdBets(['launch', '--id', 'RQ-BET-Y', '--hypothesis', 'Spare capacity', '--metric', 'spare_slots', '--max-lane-hours', '3', '--max-cycles', '2', '--direction', 'up', '--json'], io)).toBe(0);
    expect(JSON.parse(out.pop()!).bet).toMatchObject({ id: 'RQ-BET-Y', baseline: null, budget: { maxLaneHours: 3, maxCycles: 2 } });
    expect(await cmdBets(['list'], io)).toBe(0);
    expect(out.pop()).toContain('RQ-BET-Y  launched');
    expect(await cmdBets(['kill', 'RQ-BET-Y', '--reason', 'superseded', '--json'], io)).toBe(0);
    expect(JSON.parse(out.pop()!).bet.status).toBe('killed');
    expect(await cmdBets(['list', '--json'], io)).toBe(0);
    expect(JSON.parse(out.pop()!).bets[0].reason).toBe('killed by operator: superseded');
    expect(await cmdBets(['launch', '--id', 'RQ-BET-Z', '--hypothesis', 'h', '--metric', 'nope', '--max-lane-hours', '1', '--max-cycles', '1'], io)).toBe(2);
    expect(await cmdBets(['launch', '--id', 'RQ-BET-Z'], io)).toBe(2);
    expect(await cmdBets(['launch', '--id', 'RQ-BET-Z', '--hypothesis', 'h', '--metric', 'spare_slots', '--max-lane-hours', 'x', '--max-cycles', '1'], io)).toBe(2);
    expect(await cmdBets(['kill', 'RQ-BET-NONE', '--reason', 'r'], io)).toBe(2);
    expect(await cmdBets(['frob'], io)).toBe(2);
    // No verb is the leader batch view now (phm bets); an unknown flag is still a usage error.
    expect(await cmdBets(['--bogus'], io)).toBe(2);
    expect(await cmdBets([], { ...io, leaderBets: async o => ({ schema: 'fleet.leader-bets.v1', version: 1, window_hours: o.hours, known: true, queue_known: true, batches: [], summary: 'No leader bets in this window.' }) })).toBe(0);
    expect(out.pop()).toBe('No leader bets in this window.');
    expect(await cmdBets(['--help'], io)).toBe(0);
    expect(out.pop()).toContain('Usage: phm bets');
  });
});
