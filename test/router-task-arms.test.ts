/**
 * Task-aware arms in the seat router (flagged; policy.taskArms).
 *
 * Hermetic, no I/O: src/core/routing/{policy,router}.ts plus the
 * paceCeilingAt constraint in src/core/resources/pacing.ts.
 *
 * Covers:
 *   - flag off is byte-identical (absent, enabled:false, no valid arm,
 *     interactive requests): the whole SeatDecision deep-equals baseline
 *   - armed classes gate to seats that can serve a valid arm
 *   - reward: higher merged-PR-per-token wins over the baseline order
 *   - LP pacing: an arm ahead of its pace ceiling is inadmissible until the
 *     line catches up; malformed pace evidence fails closed
 *   - an unknown engine can never be selected (sanitize + runtime agree)
 */
import { describe, expect, it } from 'vitest';
import {
  applyModeSwitch,
  defaultBudgetPolicy,
  isTaskArm,
  sanitizeBudgetPolicy,
  sanitizeTaskArmsPolicy,
  taskArmKey,
  taskArmsFor,
} from '../src/core/routing/policy.js';
import { paceCeilingAt } from '../src/core/resources/pacing.js';
import { rankEligibleCapacities, routeSeat } from '../src/core/routing/router.js';
import type { CapacityWindow, SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy, RoutingRequest, TaskArm, TaskArmsPolicy } from '../src/core/routing/types.js';

const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const H = 3_600_000;
const DAY = 24 * H;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

function win(id: string, usedPercent: number | null, extra: Partial<CapacityWindow> = {}): CapacityWindow {
  return { id, usedPercent, resetsAt: null, resetDescription: null, limitReached: false, ...extra };
}

function seat(seatId: string, engine: SeatCapacity['engine'], windows: CapacityWindow[], extra: Partial<SeatCapacity> = {}): SeatCapacity {
  return {
    seatId,
    engine,
    label: seatId,
    free: engine === 'local',
    windows,
    signedOut: false,
    reachable: engine === 'local' ? true : null,
    contextWindow: engine === 'local' ? 65_536 : 200_000,
    observedAt: engine === 'local' ? null : iso(-60_000),
    spentTodayUsd: null,
    ...extra,
  };
}

const claude = (): SeatCapacity => seat('claude', 'claude', [
  win('five_hour', 20, { resetDescription: '7pm (America/New_York)' }),
  win('seven_day', 30, { resetDescription: 'Oct 28 at 7pm (America/New_York)' }),
]);
const codex = (): SeatCapacity => seat('codex-personal', 'codex', [
  win('codex_codex_primary', 30, { resetsAt: iso(3 * DAY) }),
]);
const local = (tag = 'fixture'): SeatCapacity => seat(`local:${tag}`, 'local', []);
const capacity = (): SeatCapacity[] => [claude(), codex(), local()];

const codeTaskArms = (arms: TaskArm[]): TaskArmsPolicy => ({ enabled: true, classes: { code: arms } });
const armedPolicy = (arms: TaskArm[]): BudgetPolicy => ({ ...defaultBudgetPolicy(), taskArms: codeTaskArms(arms) });

const claudeArm = (extra: Partial<TaskArm> = {}): TaskArm => ({
  engine: 'claude', model: 'claude-opus-4-6', effort: 'high',
  pace: { windowMs: 7 * DAY, budgetTokens: 1_000_000 },
  ...extra,
});
const localArm = (extra: Partial<TaskArm> = {}): TaskArm => ({ engine: 'local', model: null, effort: 'medium', ...extra });
const grokArm = (): TaskArm => ({ engine: 'grok', model: null, effort: 'low' });
const bogusArm = (engine = 'bogus-engine'): TaskArm => ({ engine, model: null, effort: 'high' });

const code = { task: 'code', difficulty: 'high', autonomous: true } as const;
const opts = { nowMs: NOW };
const auto = (req: Partial<RoutingRequest> = {}): RoutingRequest => ({ ...code, ...req });

const claudeStats = (over: object = {}) => ({
  mergedPrs: 4,
  tokens: 40_000,
  pace: { windowStartMs: NOW - 2 * H, spentTokens: 10_000 },
  ...over,
});
const localStats = { mergedPrs: 1, tokens: 30_000 };
const armStats = {
  [taskArmKey(claudeArm())]: claudeStats(),
  [taskArmKey(localArm())]: localStats,
};

// ---------------------------------------------------------------------------
// Policy: sanitize, validate, mode switch
// ---------------------------------------------------------------------------

describe('taskArms policy plumbing', () => {
  it('round-trips a valid flag through the lenient load', () => {
    const policy = { ...defaultBudgetPolicy(), taskArms: codeTaskArms([claudeArm(), localArm()]) };
    const out = sanitizeBudgetPolicy(JSON.parse(JSON.stringify(policy)));
    expect(out.taskArms).toEqual(policy.taskArms);
  });

  it('drops unknown engines, bad efforts, malformed pace and duplicate keys', () => {
    const out = sanitizeTaskArmsPolicy({
      enabled: true,
      classes: {
        code: [
          bogusArm(),
          bogusArm('also-unknown'),
          { engine: 'claude', model: null, effort: 'ludicrous' },
          { engine: 'claude', model: null, effort: 'high', pace: { windowMs: -1, budgetTokens: 100 } },
          claudeArm(),
          { ...localArm(), id: 'first' },
          { ...localArm(), id: 'first', model: 'dup' },
        ],
        'not-a-task': [claudeArm()],
      },
    });
    expect(out).toEqual({
      enabled: true,
      classes: { code: [claudeArm(), { ...localArm(), id: 'first' }] },
    });
  });

  it('drops the whole field when enabled is not boolean, and tolerates absent classes', () => {
    expect(sanitizeTaskArmsPolicy({ classes: {} })).toBeNull();
    expect(sanitizeTaskArmsPolicy('x')).toBeNull();
    expect(sanitizeBudgetPolicy({ ...defaultBudgetPolicy(), taskArms: { enabled: 'yes' } }).taskArms).toBeUndefined();
    expect(sanitizeTaskArmsPolicy({ enabled: false })).toEqual({ enabled: false, classes: {} });
    expect(sanitizeTaskArmsPolicy({ enabled: true, classes: { code: 'not-array', plan: [claudeArm()] } }))
      .toEqual({ enabled: true, classes: { plan: [claudeArm()] } });
  });

  it('validates arm shape the same way the router does', () => {
    expect(isTaskArm(claudeArm())).toBe(true);
    expect(isTaskArm(bogusArm())).toBe(false);
    expect(isTaskArm({ engine: 'claude', model: 'bad model', effort: 'high' })).toBe(false);
    expect(isTaskArm({ engine: 'claude', model: 'ok:model', effort: 'high', pace: { windowMs: 1, budgetTokens: 1, leadFraction: 2 } })).toBe(false);
    expect(isTaskArm({ engine: 'claude', model: null, effort: 'high', pace: { windowMs: 1, budgetTokens: 1 } })).toBe(true);
    expect(isTaskArm({ engine: 'claude', model: null, effort: 'high', id: 'contains|pipe' })).toBe(false);
    expect(taskArmsFor(codeTaskArms([bogusArm()]), 'code')).toEqual([]);
  });

  it('carries the flag across a mode switch with a structural copy', () => {
    const policy = armedPolicy([claudeArm()]);
    const switched = applyModeSwitch(policy, 'all-in', iso(0));
    expect(switched.taskArms).toEqual(policy.taskArms);
    expect(switched.taskArms).not.toBe(policy.taskArms);
    expect(switched.taskArms!.classes.code![0]!.pace).toEqual(policy.taskArms.classes.code![0]!.pace);
  });
});

// ---------------------------------------------------------------------------
// paceCeilingAt
// ---------------------------------------------------------------------------

describe('paceCeilingAt', () => {
  const start = NOW;
  const reset = NOW + 7 * DAY;
  it('is the ideal line plus lead inside the window, 0 outside it', () => {
    expect(paceCeilingAt({ nowMs: start, resetAtMs: reset, windowStartMs: start })).toBe(0);
    expect(paceCeilingAt({ nowMs: start + 3.5 * DAY, resetAtMs: reset, windowStartMs: start })).toBeCloseTo(0.5);
    expect(paceCeilingAt({ nowMs: start + 3.5 * DAY, resetAtMs: reset, windowStartMs: start, leadFraction: 0.05 })).toBeCloseTo(0.55);
    expect(paceCeilingAt({ nowMs: reset, resetAtMs: reset, windowStartMs: start })).toBe(0);
    expect(paceCeilingAt({ nowMs: reset - 1, resetAtMs: reset, windowStartMs: start })).toBeCloseTo(1);
    expect(paceCeilingAt({ nowMs: start - 1, resetAtMs: reset, windowStartMs: start })).toBe(0);
    expect(paceCeilingAt({ nowMs: start, resetAtMs: start, windowStartMs: start })).toBe(0);
    expect(paceCeilingAt({ nowMs: Number.NaN, resetAtMs: reset, windowStartMs: start })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Flag off: byte-identical
// ---------------------------------------------------------------------------

describe('flag-off byte identity', () => {
  const baseline = (): ReturnType<typeof routeSeat> => routeSeat(auto(), capacity(), defaultBudgetPolicy(), opts);

  it('enabled:false is identical to no flag at all', () => {
    const policy: BudgetPolicy = { ...defaultBudgetPolicy(), taskArms: { enabled: false, classes: codeTaskArms([claudeArm()]).classes } };
    expect(routeSeat(auto(), capacity(), policy, opts)).toEqual(baseline());
    expect(routeSeat(auto(), capacity(), policy, { ...opts, armStats })).toEqual(baseline());
  });

  it('enabled:true with no valid arm for the class is identical', () => {
    const policy = armedPolicy([bogusArm()]);
    expect(routeSeat(auto(), capacity(), policy, opts)).toEqual(baseline());
    const review = armedPolicy([claudeArm()]);
    expect(routeSeat(auto({ task: 'review' }), capacity(), review, opts)).toEqual(
      routeSeat(auto({ task: 'review' }), capacity(), defaultBudgetPolicy(), opts),
    );
  });

  it('interactive requests are never steered', () => {
    const policy = armedPolicy([claudeArm()]);
    expect(routeSeat(auto({ autonomous: false }), capacity(), policy, opts)).toEqual(
      routeSeat(auto({ autonomous: false }), capacity(), defaultBudgetPolicy(), opts),
    );
  });
});

// ---------------------------------------------------------------------------
// Flag on: gating, reward, pacing
// ---------------------------------------------------------------------------

describe('task-arm steering', () => {
  it('routes to the higher-yield arm over the baseline order', () => {
    const policy = armedPolicy([claudeArm(), localArm()]);
    const decision = routeSeat(auto(), capacity(), policy, { ...opts, armStats });
    expect(decision.seatId).toBe('claude');
    expect(decision.taskArm).toEqual({
      key: 'claude|claude-opus-4-6|high',
      engine: 'claude',
      model: 'claude-opus-4-6',
      effort: 'high',
      rewardPerToken: 4 / 40_000,
    });
    expect(decision.why).toContain('task arm claude|claude-opus-4-6|high at 0.0001 merged PRs/token');
    expect(decision.summary).toContain('task arm');
  });

  it('excludes eligible seats no valid arm serves, with a task-arm reason', () => {
    const policy = armedPolicy([claudeArm(), localArm()]);
    const decision = routeSeat(auto(), capacity(), policy, { ...opts, armStats });
    expect(decision.candidates).toEqual(['claude', 'local:fixture']);
    const excluded = decision.exclusions.find((e) => e.seatId === 'codex-personal')!;
    expect(excluded.details![0]).toMatchObject({ kind: 'task-arm' });
    expect(excluded.details![0]!.text).toContain('No task arm for code work runs on the codex engine');
  });

  it('holds the class when no eligible seat can serve its arms', () => {
    const decision = routeSeat(auto(), capacity(), armedPolicy([grokArm()]), opts);
    expect(decision.seatId).toBeNull();
    expect(decision.candidates).toEqual([]);
    expect(decision.exclusions).toHaveLength(3);
    expect(decision.exclusions.every((e) => e.details?.some((d) => d.kind === 'task-arm'))).toBe(true);
    expect(decision.taskArm).toBeUndefined();
  });

  it('an unknown engine is never selected even beside valid arms', () => {
    const policy = armedPolicy([bogusArm(), claudeArm()]);
    const decision = routeSeat(auto(), capacity(), policy, { ...opts, armStats });
    expect(decision.seatId).toBe('claude');
    expect(decision.taskArm!.engine).toBe('claude');
    // A class whose only arm names an unknown engine falls back to baseline.
    expect(routeSeat(auto(), capacity(), armedPolicy([bogusArm()]), opts).seatId).toBe('local:fixture');
  });

  it('an arm ahead of its pace ceiling is inadmissible until the line catches up', () => {
    const stats = {
      ...armStats,
      [taskArmKey(claudeArm())]: claudeStats({ pace: { windowStartMs: NOW - 2 * H, spentTokens: 300_000 } }),
    };
    const decision = routeSeat(auto(), capacity(), armedPolicy([claudeArm(), localArm()]), { ...opts, armStats: stats });
    expect(decision.seatId).toBe('local:fixture');
    const excluded = decision.exclusions.find((e) => e.seatId === 'claude')!;
    expect(excluded.details![0]).toMatchObject({ kind: 'task-arm' });
    expect(excluded.details![0]!.text).toContain('cannot prove they are inside their token pacing budgets');
    // ceiling(t) = ideal + 0.05 reaches 0.3 at ideal = 0.25: a quarter of the window in.
    expect(excluded.nextEligibleAt).toBe(new Date(NOW - 2 * H + 0.25 * 7 * DAY).toISOString());
  });

  it('a rolled window is fresh spend; an over-budget arm reopens at reset', () => {
    const rolled = routeSeat(auto(), capacity(), armedPolicy([claudeArm()]), {
      ...opts,
      armStats: { [taskArmKey(claudeArm())]: claudeStats({ pace: { windowStartMs: NOW - 8 * DAY, spentTokens: 900_000 } }) },
    });
    expect(rolled.seatId).toBe('claude');
    const over = routeSeat(auto(), capacity(), armedPolicy([claudeArm()]), {
      ...opts,
      armStats: { [taskArmKey(claudeArm())]: claudeStats({ pace: { windowStartMs: NOW - 2 * H, spentTokens: 1_500_000 } }) },
    });
    expect(over.seatId).toBeNull();
    expect(over.exclusions[0]!.nextEligibleAt).toBe(new Date(NOW - 2 * H + 7 * DAY).toISOString());
  });

  it('malformed pace evidence fails closed; absent evidence is a fresh window', () => {
    const corrupt = routeSeat(auto(), capacity(), armedPolicy([claudeArm()]), {
      ...opts,
      armStats: { [taskArmKey(claudeArm())]: claudeStats({ pace: { windowStartMs: NOW + H, spentTokens: 1 } }) },
    });
    expect(corrupt.seatId).toBeNull();
    const future = corrupt.exclusions[0]!;
    expect(future.nextEligibleAt).toBeNull();
    const fresh = routeSeat(auto(), capacity(), armedPolicy([claudeArm()]), {
      ...opts,
      armStats: { [taskArmKey(claudeArm())]: { mergedPrs: 4, tokens: 40_000 } },
    });
    expect(fresh.seatId).toBe('claude');
    expect(fresh.taskArm!.rewardPerToken).toBe(4 / 40_000);
  });

  it('unmeasured arms rank neutral and keep baseline order', () => {
    const policy = armedPolicy([localArm(), claudeArm({ pace: undefined })]);
    const decision = routeSeat(auto(), capacity(), policy, opts);
    expect(decision.seatId).toBe('local:fixture');
    expect(decision.taskArm!.rewardPerToken).toBeNull();
    expect(decision.why).toContain('no measured merged-PR yield');
  });

  it('a malformed pace spec drops the arm, never just the spec', () => {
    const badPace = { engine: 'claude', model: null, effort: 'high', pace: { windowMs: 0, budgetTokens: 10 } } as TaskArm;
    const policy = armedPolicy([badPace, localArm()]);
    const decision = routeSeat(auto(), capacity(), policy, { ...opts, armStats });
    expect(decision.seatId).toBe('local:fixture');
    expect(decision.exclusions.find((e) => e.seatId === 'claude')!.details![0]!.text).toContain('No task arm');
  });

  it('picks a seat\'s best arm and shares the reward across same-engine seats', () => {
    const secondLocal = seat('local:second', 'local', []);
    const policy = armedPolicy([localArm(), localArm({ model: 'qwen3.8:27b', effort: 'high' })]);
    const stats = {
      [taskArmKey(localArm())]: { mergedPrs: 1, tokens: 30_000 },
      [taskArmKey(localArm({ model: 'qwen3.8:27b', effort: 'high' }))]: { mergedPrs: 9, tokens: 10_000 },
    };
    const decision = routeSeat(auto(), [claude(), codex(), local(), secondLocal], policy, { ...opts, armStats: stats });
    expect(decision.seatId).toBe('local:fixture');
    expect(decision.taskArm!.model).toBe('qwen3.8:27b');
    expect(decision.candidates.slice(0, 2)).toEqual(['local:fixture', 'local:second']);
  });

  it('rankEligibleCapacities applies the same gate and reward order', () => {
    const policy = armedPolicy([claudeArm(), localArm()]);
    const ranked = rankEligibleCapacities(auto(), capacity(), policy, { ...opts, armStats });
    expect(ranked.map((c) => c.seatId)).toEqual(['claude', 'local:fixture']);
    const off = rankEligibleCapacities(auto(), capacity(), defaultBudgetPolicy(), opts);
    expect(off.map((c) => c.seatId)).toEqual(['local:fixture', 'claude', 'codex-personal']);
  });
});
