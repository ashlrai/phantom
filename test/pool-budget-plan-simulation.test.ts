import { describe, expect, it } from 'vitest';
import { projectPoolBudgets, type BudgetPool, type BudgetReading } from '../src/core/fleet/pool-budget.js';
import { projectPoolBudgetPlan, type PoolPaceDecision } from '../src/core/fleet/pool-budget-plan.js';

/**
 * Seven-day dispatch simulation: a faithful stand-in for dispatchd applies the
 * plan's lane and concurrency decisions every 30 minutes, records the burn
 * back into the ledger, and re-plans. The acceptance checks are that every
 * weekly window lands near 0% at its reset, credits never spend while weekly
 * remains, and no weekly quota is stranded.
 */
const T0 = Date.parse('2026-10-26T00:00:00.000Z');
const HOUR = 3_600_000;
const TICK_MS = HOUR / 2;
const WEEK_MS = 7 * 24 * HOUR;
const LANDING_TOLERANCE_PCT = 3;
const iso = (ms: number) => new Date(ms).toISOString();

interface SimPool {
  pool: BudgetPool;
  weekly: number | null;
  credits: number | null;
  acus: number | null;
  weeklyResetAt: number | null;
  acusResetAt: number | null;
  /** Quota units one concurrency slot burns per hour. */
  burnPerWorker: number;
  /** dispatchd's own hardware cap; the plan's cap wins when lower. */
  cap: number;
  concurrency: number;
  refillLag: number;
  landings: number[];
  acusLandings: number[];
  raiseTicks: number;
  totalTicks: number;
}

function pools(): SimPool[] {
  return [
    { pool: 'codex-cmp', weekly: 100, credits: 400, acus: null, weeklyResetAt: T0 + WEEK_MS, acusResetAt: null,
      burnPerWorker: 2, cap: 8, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
    { pool: 'codex-personal', weekly: 100, credits: 100, acus: null, weeklyResetAt: T0 + 3 * 24 * HOUR, acusResetAt: null,
      burnPerWorker: 1.5, cap: 6, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
    { pool: 'grok-build', weekly: 60, credits: 50, acus: null, weeklyResetAt: T0 + 5 * 24 * HOUR, acusResetAt: null,
      burnPerWorker: 2, cap: 4, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
    { pool: 'grok-ultra', weekly: 100, credits: 20, acus: null, weeklyResetAt: T0 + WEEK_MS, acusResetAt: null,
      burnPerWorker: 4, cap: 4, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
    { pool: 'devin', weekly: null, credits: null, acus: 400, weeklyResetAt: null, acusResetAt: T0 + WEEK_MS,
      burnPerWorker: 2, cap: 4, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
    { pool: 'claude', weekly: 100, credits: null, acus: null, weeklyResetAt: null, acusResetAt: null,
      burnPerWorker: 2, cap: 4, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
    { pool: 'local-omlx', weekly: null, credits: null, acus: null, weeklyResetAt: null, acusResetAt: null,
      burnPerWorker: 0, cap: 3, concurrency: 0, refillLag: 0, landings: [], acusLandings: [], raiseTicks: 0, totalTicks: 0 },
  ];
}

interface SimResult {
  pools: SimPool[];
  grokUltraPeakConcurrency: number;
  creditSpendWhileWeeklyRemained: number;
  decisionsByPool: Record<string, PoolPaceDecision[]>;
}

function record(readings: BudgetReading[], p: SimPool, now: number): void {
  if (p.weekly !== null) {
    if (p.refillLag === 0) {
      readings.push({ pool: p.pool, bucket: 'weeklyPct', remaining: p.weekly,
        resetAt: p.weeklyResetAt === null ? null : iso(p.weeklyResetAt), timestamp: iso(now), source: 'log' });
    }
  }
  if (p.credits !== null) readings.push({ pool: p.pool, bucket: 'credits', remaining: p.credits, resetAt: null, timestamp: iso(now), source: 'log' });
  if (p.acus !== null) readings.push({ pool: p.pool, bucket: 'acus', remaining: p.acus,
    resetAt: p.acusResetAt === null ? null : iso(p.acusResetAt), timestamp: iso(now), source: 'log' });
  if (p.pool === 'local-omlx') readings.push({ pool: p.pool, bucket: 'capacity', remaining: 3, resetAt: null, timestamp: iso(now), source: 'log' });
}

function simulate(days: number, mutator: (pools: SimPool[]) => SimPool[] = (p) => p): SimResult {
  const fleet = mutator(pools());
  const readings: BudgetReading[] = [];
  const result: SimResult = { pools: fleet, grokUltraPeakConcurrency: 0, creditSpendWhileWeeklyRemained: 0,
    decisionsByPool: Object.fromEntries(fleet.map((p) => [p.pool, []])) };
  for (let tick = 0; tick <= days * 48; tick += 1) {
    const now = T0 + tick * TICK_MS;
    for (const p of fleet) {
      if (p.weeklyResetAt !== null && now >= p.weeklyResetAt) {
        p.landings.push(p.weekly!);
        p.weekly = 100;
        p.weeklyResetAt += WEEK_MS;
        p.refillLag = 1;
      }
      if (p.acusResetAt !== null && now >= p.acusResetAt) {
        p.acusLandings.push(p.acus!);
        p.acus = 400;
        p.acusResetAt += WEEK_MS;
        p.refillLag = 1;
      }
    }
    for (const p of fleet) record(readings, p, now);
    for (const p of fleet) if (p.refillLag > 0) p.refillLag -= 1;
    const plan = projectPoolBudgetPlan(projectPoolBudgets(readings, new Date(now)), now);
    for (const p of fleet) {
      const d = plan.decisions[p.pool];
      result.decisionsByPool[p.pool]!.push(d);
      p.totalTicks += 1;
      if (d.concurrency === 'raise') p.raiseTicks += 1;
      // Lane gating invariants, checked on every tick of every pool.
      if (d.creditsOpen) {
        expect(d.weeklyOpen).toBe(false);
        expect(d.weeklyRemainingPct).toBe(0);
      }
      if (d.lane === 'credits') expect(d.creditsOpen).toBe(true);
      if (d.lane === 'weekly') expect(d.weeklyOpen).toBe(true);
      expect(d.reasons.length).toBeGreaterThan(0);
      const ceiling = Math.min(p.cap, d.maxConcurrency ?? p.cap);
      if (p.pool === 'grok-ultra') expect(d.maxConcurrency).toBe(1);
      // dispatchd applies the direction; the plan's cap bounds the raise.
      if (d.concurrency === 'raise') p.concurrency = Math.min(ceiling, p.concurrency + 1);
      else if (d.concurrency === 'lower') p.concurrency = Math.max(0, p.concurrency - 1);
      else if (d.concurrency === 'pause') p.concurrency = 0;
      p.concurrency = Math.min(p.concurrency, ceiling);
      if (p.pool === 'grok-ultra') result.grokUltraPeakConcurrency = Math.max(result.grokUltraPeakConcurrency, p.concurrency);
      const spend = p.concurrency * p.burnPerWorker * (TICK_MS / HOUR);
      if (spend <= 0) continue;
      if (d.lane === 'weekly' && p.weekly !== null) p.weekly = Math.max(0, p.weekly - spend);
      else if (d.lane === 'credits' && p.credits !== null) {
        if (p.weekly !== null && p.weekly > 0) result.creditSpendWhileWeeklyRemained += 1;
        p.credits = Math.max(0, p.credits - spend);
      } else if (d.lane === 'metered' && p.acus !== null) p.acus = Math.max(0, p.acus - spend);
    }
  }
  return result;
}

describe('seven-day dispatch pacing simulation', () => {
  it('lands every weekly window near 0% at reset with no early credit spend', () => {
    const r = simulate(7);
    const cmp = r.pools.find((p) => p.pool === 'codex-cmp')!;
    const personal = r.pools.find((p) => p.pool === 'codex-personal')!;
    const build = r.pools.find((p) => p.pool === 'grok-build')!;
    const ultra = r.pools.find((p) => p.pool === 'grok-ultra')!;
    const devin = r.pools.find((p) => p.pool === 'devin')!;
    // Every reset that occurred inside the seven days landed near 0%.
    expect(cmp.landings).toHaveLength(1);
    expect(personal.landings).toHaveLength(1);
    expect(build.landings).toHaveLength(1);
    expect(ultra.landings).toHaveLength(1);
    for (const p of [cmp, personal, build, ultra]) {
      for (const landing of p.landings) expect(landing).toBeLessThanOrEqual(LANDING_TOLERANCE_PCT);
    }
    // The metered Devin budget landed near empty as well.
    expect(devin.acusLandings).toHaveLength(1);
    expect(devin.acusLandings[0]!).toBeLessThanOrEqual(12); // <=3% of the 400-unit window
    // No credit spend while weekly remained, anywhere in the week.
    expect(r.creditSpendWhileWeeklyRemained).toBe(0);
    // Grok Ultra never exceeded its scarce single-slot orchestration cap.
    expect(r.grokUltraPeakConcurrency).toBeLessThanOrEqual(1);
    // Held and capacity-only pools were never charged.
    expect(r.pools.find((p) => p.pool === 'claude')!.weekly).toBe(100);
    // Post-reset windows reopened and resumed spending instead of stranding.
    const personalLate = r.decisionsByPool['codex-personal']!.at(-1)!;
    expect(personalLate.lane === 'weekly' || personalLate.lane === 'none').toBe(true);
    expect(personal.weekly!).toBeLessThan(100);
    // No weekly window closed out with spendable quota left behind.
    for (const p of [cmp, personal, build, ultra]) {
      for (const landing of p.landings) expect(landing).toBeLessThanOrEqual(LANDING_TOLERANCE_PCT);
    }
  });

  it('keeps raising honestly when capacity cannot catch the required pace', () => {
    // cap=1 at 0.4%/h can burn at most 0.4%/h against a 0.583%/h need: the
    // window must strand, and the plan must keep saying so.
    const r = simulate(7, (fleet) => fleet.map((p) => p.pool === 'codex-cmp'
      ? { ...p, burnPerWorker: 0.4, cap: 1 } : p));
    const cmp = r.pools.find((p) => p.pool === 'codex-cmp')!;
    expect(cmp.landings).toHaveLength(1);
    expect(cmp.landings[0]!).toBeGreaterThan(LANDING_TOLERANCE_PCT);
    expect(cmp.raiseTicks / cmp.totalTicks).toBeGreaterThan(0.8);
    // Stranded weekly never opened the credits lane.
    expect(r.creditSpendWhileWeeklyRemained).toBe(0);
    expect(cmp.credits).toBe(400);
    // The last in-window decision still calls for more concurrency.
    const lastInWindow = r.decisionsByPool['codex-cmp']!.filter((d) => d.lane === 'weekly').at(-1)!;
    expect(lastInWindow.concurrency).toBe('raise');
    expect(lastInWindow.creditsOpen).toBe(false);
  });
});
