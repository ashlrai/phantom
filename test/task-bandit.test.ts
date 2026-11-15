/**
 * RQ-PARITYROUTERTASKQ7 — task-aware bandit lane in the existing seat router.
 *
 * Pure modules only (no I/O beyond the checked-in fixture):
 * src/core/routing/{policy,task-bandit,router}.ts plus the #938 pacing module.
 * The fixture in test/fixtures/task-bandit/history.jsonl is synthetic; see its
 * README. The acceptance replay shows the Thompson lane reaching lower
 * tokens-per-merged-PR at no-worse merge rate, with unknown engines never
 * drawable.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TASK_BANDIT_CONFIG,
  FRONTIER_TASK_ENGINES,
  defaultBudgetPolicy,
  isFrontierTaskEngine,
  isTaskBanditEngine,
  parseTaskBanditConfig,
  TASK_BANDIT_ENGINES,
} from '../src/core/routing/policy.js';
import {
  betaSample,
  classifyTaskContext,
  contextCellKeys,
  eligibleTaskArms,
  emptyTaskBanditState,
  pacingAllowance,
  parseTaskOutcomeLog,
  planTaskBandit,
  recordTaskOutcome,
  replayTaskBandit,
  sampleTaskArms,
  seatBanditNote,
  seededTaskRandom,
  TASK_BANDIT_ARMS,
  taskArmById,
  taskBanditStateFrom,
  taskOutcomeRecordFrom,
  taskOutcomeReward,
  UNKNOWN_REPO,
  updateTaskBanditState,
  type TaskBanditContext,
} from '../src/core/routing/task-bandit.js';
import { routeSeat, type RouteOptions } from '../src/core/routing/router.js';
import type { CapacityWindow, SeatCapacity } from '../src/core/routing/headroom.js';
import type { BudgetPolicy, RoutingRequest } from '../src/core/routing/types.js';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString();

const CONFIG = parseTaskBanditConfig({ enabled: true, mode: 'enforce', seed: 7 });

const ctx = (extra: Partial<TaskBanditContext> = {}): TaskBanditContext => ({
  taskClass: 'code', sizeBucket: 'm', riskClass: 'medium', repo: 'ashlrai/phantom', ...extra,
});

// ---------------------------------------------------------------------------
// Flag parsing — fail closed, lenient salvage
// ---------------------------------------------------------------------------

describe('parseTaskBanditConfig', () => {
  it.each([undefined, null, 42, 'yes', [], { enabled: false }])(
    'keeps the lane off for absent or disabled input %j', (raw) => {
      const c = parseTaskBanditConfig(raw);
      expect(c.enabled).toBe(false);
      expect(c.mode).toBe('off');
    });

  it('defaults an enabled flag to shadow — never silently enforces', () => {
    expect(parseTaskBanditConfig({ enabled: true }).mode).toBe('shadow');
    expect(parseTaskBanditConfig({ enabled: true, mode: 'loud' }).mode).toBe('shadow');
    expect(parseTaskBanditConfig({ enabled: true, mode: 'shadow' }).mode).toBe('shadow');
    expect(parseTaskBanditConfig({ enabled: true, mode: 'enforce' }).mode).toBe('enforce');
    expect(parseTaskBanditConfig({ enabled: true, mode: 'off' }).mode).toBe('off');
    expect(parseTaskBanditConfig({ enabled: false, mode: 'enforce' }).mode).toBe('off');
  });

  it('salvages valid fields and defaults invalid ones', () => {
    const c = parseTaskBanditConfig({
      enabled: true, mode: 'enforce', seed: 9, minCellSamples: 3,
      tokenNorm: 'lots', tokenFloor: -5, sizeEdges: [1, 2], pacingFloor: 7, bogus: true,
    });
    expect(c).toEqual({
      enabled: true, mode: 'enforce', seed: 9, minCellSamples: 3, priorMass: 1,
      tokenNorm: DEFAULT_TASK_BANDIT_CONFIG.tokenNorm,
      tokenFloor: DEFAULT_TASK_BANDIT_CONFIG.tokenFloor,
      sizeEdges: DEFAULT_TASK_BANDIT_CONFIG.sizeEdges,
      pacingFloor: 0,
    });
  });

  it('catalog engines cover the five named engines and exclude claude-api', () => {
    expect(TASK_BANDIT_ENGINES).toEqual(['claude', 'codex', 'grok', 'devin', 'local']);
    expect(FRONTIER_TASK_ENGINES).toEqual(['claude', 'codex', 'grok', 'devin']);
    expect(isTaskBanditEngine('local')).toBe(true);
    expect(isTaskBanditEngine('claude-api')).toBe(false);
    expect(isTaskBanditEngine('watson')).toBe(false);
    expect(isFrontierTaskEngine('local')).toBe(false);
    expect(TASK_BANDIT_ARMS.every((a) => isTaskBanditEngine(a.engine))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Classifier — (class, size, risk, repo)
// ---------------------------------------------------------------------------

describe('classifyTaskContext', () => {
  const req = (task: RoutingRequest['task'], difficulty: RoutingRequest['difficulty'], contextTokens?: number): RoutingRequest =>
    ({ task, difficulty, autonomous: true, ...(contextTokens !== undefined ? { contextTokens } : {}) });

  it('maps class from the request, risk from difficulty, repo from hints', () => {
    expect(classifyTaskContext(req('review', 'high', 150_000), CONFIG, { repo: 'AshlrAI/Phantom' }))
      .toEqual({ taskClass: 'review', sizeBucket: 'm', riskClass: 'high', repo: 'ashlrai/phantom' });
  });

  it.each([
    [1, 'xs'], [24_999, 'xs'], [25_000, 's'], [79_999, 's'], [80_000, 'm'],
    [199_999, 'm'], [200_000, 'l'], [599_999, 'l'], [600_000, 'xl'],
    [undefined, 'xs'], [Number.NaN, 'xs'], [-5, 'xs'],
  ])('buckets contextTokens %s as %s', (tokens, bucket) => {
    const c = classifyTaskContext(req('code', 'low', tokens as number | undefined), CONFIG);
    expect(c.sizeBucket).toBe(bucket);
  });

  it('lets a hint override the difficulty-derived risk, only with a valid class', () => {
    expect(classifyTaskContext(req('code', 'low'), CONFIG, { riskClass: 'high' }).riskClass).toBe('high');
    expect(classifyTaskContext(req('code', 'high'), CONFIG, { riskClass: 'bogus' as never }).riskClass).toBe('high');
  });

  it.each([undefined, '', 'not a repo', '/leading', 'owner/name/extra', 'UPPER/CASE/x'])(
    'normalizes unusable repo hint %j to unknown', (repo) => {
      expect(classifyTaskContext(req('code', 'low'), CONFIG, { repo }).repo).toBe(UNKNOWN_REPO);
    });

  it('spells cell keys most-specific-first through the global cell', () => {
    expect(contextCellKeys(ctx())).toEqual([
      'c=code|s=m|r=medium|p=ashlrai/phantom',
      'c=code|s=m|r=medium',
      'c=code|r=medium',
      'g',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Reward — merged and green PR per token
// ---------------------------------------------------------------------------

describe('taskOutcomeReward', () => {
  const cfg = parseTaskBanditConfig({ enabled: true, mode: 'enforce', tokenNorm: 50_000, tokenFloor: 1_000 });

  it('pays full credit for a merged green PR at or under the norm', () => {
    expect(taskOutcomeReward({ merged: true, ciGreen: true, tokens: 30_000 }, cfg))
      .toMatchObject({ success: true, unit: 1 });
    expect(taskOutcomeReward({ merged: true, ciGreen: true, tokens: 30_000 }, cfg).raw).toBeCloseTo(50_000 / 30_000);
  });

  it('pays a fraction for an expensive merged PR', () => {
    const r = taskOutcomeReward({ merged: true, ciGreen: true, tokens: 200_000 }, cfg);
    expect(r.unit).toBeCloseTo(0.25);
  });

  it('pays nothing unless the PR merged AND checks went green', () => {
    for (const outcome of [
      { merged: true, ciGreen: false, tokens: 1_000 },
      { merged: false, ciGreen: true, tokens: 1_000 },
      { merged: undefined, ciGreen: undefined, tokens: 500_000 },
      { merged: true, tokens: 1_000 }, // ciGreen absent is not green
    ]) expect(taskOutcomeReward(outcome, cfg)).toEqual({ unit: 0, raw: 0, success: false });
  });

  it('treats absent token evidence as the floor, never a synthesized cost', () => {
    expect(taskOutcomeReward({ merged: true, ciGreen: true }, cfg).unit).toBe(1);
    expect(taskOutcomeReward({ merged: true, ciGreen: true, tokens: 0 }, cfg).unit).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Posterior state
// ---------------------------------------------------------------------------

describe('task bandit state', () => {
  it('folds one fractional update into all four cell levels', () => {
    const next = updateTaskBanditState(emptyTaskBanditState(), ctx(), 'codex:gpt-6.1-terra:low', 0.8);
    for (const key of contextCellKeys(ctx())) {
      const p = next.cells[key]!['codex:gpt-6.1-terra:low']!;
      expect(p.a).toBeCloseTo(0.8);
      expect(p.b).toBeCloseTo(0.2);
      expect(p.n).toBe(1);
    }
  });

  it('clips rewards outside [0,1] and ignores non-finite rewards', () => {
    const over = updateTaskBanditState(emptyTaskBanditState(), ctx(), 'a', 9);
    expect(over.cells['g']!['a']).toEqual({ a: 1, b: 0, n: 1 });
    expect(updateTaskBanditState(emptyTaskBanditState(), ctx(), 'a', Number.NaN).cells).toEqual({});
  });

  it('fails closed to a fresh prior on corrupt or foreign state', () => {
    for (const bad of [undefined, null, 'x', { v: 2, cells: {} }, { v: 1, cells: [1] }]) {
      expect(taskBanditStateFrom(bad)).toEqual({ v: 1, cells: {} });
    }
    const dirty = { v: 1, cells: { g: { good: { a: 2, b: 1, n: 3 }, neg: { a: -1, b: 0, n: 1 }, nan: { a: Number.NaN, b: 0, n: 0 } } } };
    expect(taskBanditStateFrom(dirty).cells['g']).toEqual({ good: { a: 2, b: 1, n: 3 } });
  });

  it('roundtrips a state through validate without loss', () => {
    const state = updateTaskBanditState(emptyTaskBanditState(), ctx(), 'claude:opus:high', 1);
    expect(taskBanditStateFrom(state)).toEqual(state);
  });
});

// ---------------------------------------------------------------------------
// Deterministic draws
// ---------------------------------------------------------------------------

describe('seeded draws', () => {
  it('repeats the same stream for the same (seed, key)', () => {
    const a = seededTaskRandom(7, 'job-1');
    const b = seededTaskRandom(7, 'job-1');
    const c = seededTaskRandom(7, 'job-2');
    const seqA = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(seqA);
    expect([c(), c(), c()]).not.toEqual(seqA);
    seqA.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); });
  });

  it('keeps beta samples inside (0,1) even for degenerate shapes', () => {
    const rng = seededTaskRandom(3, 'k');
    for (let i = 0; i < 50; i += 1) {
      for (const [a, b] of [[0, 0], [1e-12, 1e-12], [50, 2]] as const) {
        const v = betaSample(a, b, rng);
        expect(v).toBeGreaterThan(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('orders draws by sampled theta with a deterministic tiebreak', () => {
    const arms = TASK_BANDIT_ARMS.slice(0, 4);
    const draws1 = sampleTaskArms(emptyTaskBanditState(), ctx(), arms, CONFIG, seededTaskRandom(7, 'job'));
    const draws2 = sampleTaskArms(emptyTaskBanditState(), ctx(), arms, CONFIG, seededTaskRandom(7, 'job'));
    expect(draws1.map((d) => d.arm.id)).toEqual(draws2.map((d) => d.arm.id));
    expect([...draws1].sort((x, y) => y.theta - x.theta).map((d) => d.arm.id)).toEqual(draws1.map((d) => d.arm.id));
  });

  it('prefers the arm the evidence favors once a cell clears minCellSamples', () => {
    let state = emptyTaskBanditState();
    for (let i = 0; i < 12; i += 1) {
      state = updateTaskBanditState(state, ctx(), 'local:default:low', 1);
      state = updateTaskBanditState(state, ctx(), 'claude:opus:high', 0);
    }
    let first = 0;
    for (let k = 0; k < 20; k += 1) {
      const draws = sampleTaskArms(state, ctx(), TASK_BANDIT_ARMS, CONFIG, seededTaskRandom(11, `k${k}`));
      if (draws[0]!.arm.id === 'local:default:low') first += 1;
    }
    expect(first).toBeGreaterThanOrEqual(18);
  });
});

// ---------------------------------------------------------------------------
// Pacing gate (#938)
// ---------------------------------------------------------------------------

describe('pacingAllowance', () => {
  const window = (used: number) => ({ used, windowStartMs: NOW - DAY, resetAtMs: NOW + DAY });

  it('is inactive when no pacing evidence is supplied at all', () => {
    expect(pacingAllowance('claude', undefined, NOW)).toBe(Number.POSITIVE_INFINITY);
  });

  it('fails closed for a pool with no or invalid reading', () => {
    expect(pacingAllowance('claude', {}, NOW)).toBeNull();
    expect(pacingAllowance('claude', { claude: { used: 1.5, windowStartMs: NOW - DAY, resetAtMs: NOW + DAY } }, NOW)).toBeNull();
    expect(pacingAllowance('claude', { codex: window(0.1) }, NOW)).toBeNull();
  });

  it('admits a pool with room and gates a spent pool', () => {
    const ample = pacingAllowance('claude', { claude: window(0.2) }, NOW);
    expect(ample).not.toBeNull();
    expect(ample!).toBeGreaterThan(0);
    const spent = pacingAllowance('claude', { claude: window(1) }, NOW);
    expect(spent === null || spent <= 0).toBe(true);
  });

  it('drops only the floored pool inside eligibleTaskArms', () => {
    const present = new Set<string>(['claude', 'codex']);
    const res = eligibleTaskArms({
      context: ctx(), presentEngines: present, nowMs: NOW, config: CONFIG,
      pacing: { claude: window(1), codex: window(0.1) },
    });
    expect(res.holdReason).toBeNull();
    expect(res.arms.length).toBeGreaterThan(0);
    expect(res.arms.every((a) => a.engine === 'codex')).toBe(true);
  });

  it('holds when every pool sits at its floor', () => {
    const res = eligibleTaskArms({
      context: ctx(), presentEngines: new Set(['claude']), nowMs: NOW, config: CONFIG,
      pacing: { claude: window(1) },
    });
    expect(res.arms).toEqual([]);
    expect(res.holdReason).toContain('floored');
  });
});

// ---------------------------------------------------------------------------
// Eligibility — frontier-only risky work, unknown engines, credentials
// ---------------------------------------------------------------------------

describe('eligibleTaskArms', () => {
  const allFive = new Set<string>(TASK_BANDIT_ENGINES);

  it('admits catalog arms only for engines the caller actually seats', () => {
    const res = eligibleTaskArms({ context: ctx(), presentEngines: new Set(['claude', 'local']), nowMs: NOW, config: CONFIG });
    expect(new Set(res.arms.map((a) => a.engine))).toEqual(new Set(['claude', 'local']));
    expect(res.holdReason).toBeNull();
  });

  it('keeps high-risk contexts frontier-only — local is never an arm', () => {
    const res = eligibleTaskArms({ context: ctx({ riskClass: 'high' }), presentEngines: allFive, nowMs: NOW, config: CONFIG });
    expect(res.arms.length).toBeGreaterThan(0);
    expect(res.arms.every((a) => isFrontierTaskEngine(a.engine))).toBe(true);
    expect(res.arms.some((a) => a.engine === 'local')).toBe(false);
  });

  it.each(['mergesToMain', 'holdsMergeRights', 'publishes'] as const)(
    'treats the %s authority role as risky even at low nominal risk', (key) => {
      const res = eligibleTaskArms({
        context: ctx({ riskClass: 'low' }), hints: { [key]: true },
        presentEngines: new Set(['local', 'claude']), nowMs: NOW, config: CONFIG,
      });
      expect(res.arms.every((a) => a.engine === 'claude')).toBe(true);
    });

  it('holds outright on credentialed work', () => {
    const res = eligibleTaskArms({
      context: ctx(), hints: { needsCredentials: true }, presentEngines: allFive, nowMs: NOW, config: CONFIG,
    });
    expect(res.arms).toEqual([]);
    expect(res.holdReason).toContain('credentialed');
  });

  it('holds when no seated engine is known to the catalog', () => {
    const res = eligibleTaskArms({ context: ctx(), presentEngines: new Set(['claude-api', 'watson']), nowMs: NOW, config: CONFIG });
    expect(res.arms).toEqual([]);
    expect(res.holdReason).toContain('no seated engine');
  });
});

// ---------------------------------------------------------------------------
// The plan and the annotation
// ---------------------------------------------------------------------------

describe('planTaskBandit + seatBanditNote', () => {
  const req: RoutingRequest = { task: 'code', difficulty: 'medium', autonomous: true, contextTokens: 100_000 };
  const input = (over: Record<string, unknown> = {}) => ({ config: { enabled: true, mode: 'enforce', seed: 7 }, ...over });

  it('returns null for absent, disabled or off config — flag stays off', () => {
    for (const raw of [{}, { config: undefined }, { config: { enabled: false } }, { config: { enabled: true, mode: 'off' } }]) {
      expect(planTaskBandit(req, raw as never, new Set(['claude']), NOW)).toBeNull();
    }
  });

  it('plans draws over seated engines and classifies the context', () => {
    const plan = planTaskBandit(req, input(), new Set(['claude', 'codex']), NOW);
    expect(plan).not.toBeNull();
    expect(plan!.mode).toBe('enforce');
    expect(plan!.context).toEqual({ taskClass: 'code', sizeBucket: 'm', riskClass: 'medium', repo: 'unknown' });
    expect(plan!.ordered.length).toBe(plan!.eligibleArmIds.length);
    expect(plan!.ordered.every((d) => plan!.eligibleArmIds.includes(d.arm.id))).toBe(true);
    expect(plan!.ordered.every((d) => ['claude', 'codex'].includes(d.arm.engine))).toBe(true);
  });

  it('is deterministic for a fixed (seed, itemKey)', () => {
    const a = planTaskBandit(req, input({ hints: { itemKey: 'job-7' } }), new Set(['claude', 'grok']), NOW);
    const b = planTaskBandit(req, input({ hints: { itemKey: 'job-7' } }), new Set(['claude', 'grok']), NOW);
    const c = planTaskBandit(req, input({ hints: { itemKey: 'job-8' } }), new Set(['claude', 'grok']), NOW);
    expect(a!.ordered.map((d) => d.arm.id)).toEqual(b!.ordered.map((d) => d.arm.id));
    expect(a!.context).toEqual(b!.context);
    expect(c).not.toBeNull();
  });

  it('annotates a divergence at engine granularity, including hold-vs-seat', () => {
    const plan = planTaskBandit(req, input(), new Set(['claude', 'codex']), NOW)!;
    const sampled = plan.ordered[0]!.arm;
    const other = plan.ordered.map((d) => d.arm).find((a) => a.engine !== sampled.engine);
    const note = seatBanditNote(plan, other!.id);
    expect(note.divergent).toBe(true);
    expect(note.sampledArmId).toBe(sampled.id);
    expect(note.appliedArmId).toBe(other!.id);
    // same engine, different (model, effort) — not a divergence: effort is advisory.
    const sameEngine = plan.ordered.map((d) => d.arm).find((a) => a.engine === sampled.engine && a.id !== sampled.id);
    if (sameEngine) expect(seatBanditNote(plan, sameEngine.id).divergent).toBe(false);
    // a seat the bandit held is a divergence; a held plan on a held seat is not.
    const held = { ...plan, ordered: [] };
    expect(seatBanditNote(held, 'claude:opus:high').divergent).toBe(true);
    expect(seatBanditNote(held, null).divergent).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Outcome records
// ---------------------------------------------------------------------------

describe('taskOutcomeRecordFrom', () => {
  const good = {
    schema: 'phantom-task-bandit-outcome/v1', job: 'job-1', at: '2026-02-02T14:00:00.000Z',
    context: { taskClass: 'code', sizeTokens: 40_000, riskClass: 'low', repo: 'ashlrai/phantom' },
    arm: 'claude:opus:high', merged: true, ciGreen: true, tokens: 12_000,
  };

  it('accepts a full record and a triple arm', () => {
    expect(taskOutcomeRecordFrom(good).arm).toBe('claude:opus:high');
    expect(taskOutcomeRecordFrom({ ...good, arm: { engine: 'local', effort: 'low' } }).arm)
      .toEqual({ engine: 'local', effort: 'low' });
  });

  it.each([
    [null, 'object'], [{}, 'schema'], [{ ...good, schema: 'v2' }, 'schema'],
    [{ ...good, job: '' }, 'job'], [{ ...good, at: 'nope' }, 'ISO'],
    [{ ...good, context: {} }, 'taskClass'],
    [{ ...good, context: { ...good.context, riskClass: 'spicy' } }, 'riskClass'],
    [{ ...good, context: { taskClass: 'code', riskClass: 'low' } }, 'sizeBucket or sizeTokens'],
    [{ ...good, context: { ...good.context, sizeBucket: 'xxl' } }, 'xs..xl'],
    [{ ...good, arm: null }, 'arm'], [{ ...good, arm: {} }, 'arm'],
    [{ ...good, arm: { engine: 'claude', effort: 'low', model: 4 } }, 'arm'],
    [{ ...good, merged: 'yes' }, 'merged'], [{ ...good, tokens: -1 }, 'nonnegative'],
  ])('rejects malformed record: %j → /%s/', (raw, msg) => {
    expect(() => taskOutcomeRecordFrom(raw)).toThrow(msg);
  });

  it('drops an unknown-engine arm on update — no foreign evidence', () => {
    const rec = taskOutcomeRecordFrom({ ...good, arm: 'watson:x:low' });
    const state = emptyTaskBanditState();
    expect(recordTaskOutcome(state, rec, CONFIG)).toBe(state);
    expect(recordTaskOutcome(state, taskOutcomeRecordFrom(good), CONFIG).cells['g']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// routeSeat integration — flag off, shadow, enforce
// ---------------------------------------------------------------------------

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

const claudeSeat = (): SeatCapacity => seat('claude', 'claude', [
  win('five_hour', 15, { resetDescription: '7pm' }),
  win('seven_day', 40, { resetDescription: 'Sep 25' }),
]);
const codexSeat = (id = 'codex-personal', used = 20): SeatCapacity =>
  seat(id, 'codex', [win('codex_codex_primary', used, { resetsAt: iso(30 * 3_600_000) })]);
const grokSeat = (used = 12): SeatCapacity => seat('grok', 'grok', [win('grok_unified_weekly', used, { resetsAt: iso(3 * DAY) })]);
const localSeat = (tag = 'qwen3.8:27b-ctx64k'): SeatCapacity => seat(`local:${tag}`, 'local', []);

const policy = (): BudgetPolicy => defaultBudgetPolicy();
const opts = (over: Partial<RouteOptions> = {}): RouteOptions => ({ nowMs: NOW, ...over });
const auto = (task: RoutingRequest['task'], difficulty: RoutingRequest['difficulty'], extra: Partial<RoutingRequest> = {}): RoutingRequest =>
  ({ task, difficulty, autonomous: true, ...extra });

const banditOn = (mode: 'shadow' | 'enforce', over: Record<string, unknown> = {}) => ({
  config: { enabled: true, mode, seed: 7, minCellSamples: 2 }, ...over,
});

describe('routeSeat task-bandit integration', () => {
  const fleet = (): SeatCapacity[] => [claudeSeat(), codexSeat(), grokSeat(), localSeat()];
  const req = auto('code', 'medium', { contextTokens: 100_000 });

  it('is byte-identical with no taskBandit option — no bandit field at all', () => {
    const plain = routeSeat(req, fleet(), policy(), opts());
    const absent = routeSeat(req, fleet(), policy(), opts({ taskBandit: undefined }));
    const disabled = routeSeat(req, fleet(), policy(), opts({ taskBandit: { config: { enabled: false } } }));
    const off = routeSeat(req, fleet(), policy(), opts({ taskBandit: { config: { enabled: true, mode: 'off' } } }));
    for (const d of [absent, disabled, off]) {
      expect(d).toEqual(plain);
      expect(d.bandit).toBeUndefined();
    }
    expect('bandit' in plain).toBe(false);
  });

  it('ignores the flag for interactive requests', () => {
    const interactive: RoutingRequest = { ...req, autonomous: false };
    const d = routeSeat(interactive, fleet(), policy(), opts({ taskBandit: banditOn('enforce') }));
    expect(d).toEqual(routeSeat(interactive, fleet(), policy(), opts()));
    expect(d.bandit).toBeUndefined();
  });

  it('shadow mode annotates the draw but applies the static seat', () => {
    const shadowed = routeSeat(req, fleet(), policy(), opts({ taskBandit: banditOn('shadow', { hints: { itemKey: 'j1' } }) }));
    const plain = routeSeat(req, fleet(), policy(), opts());
    expect(shadowed.seatId).toBe(plain.seatId);
    expect(shadowed.candidates).toEqual(plain.candidates);
    expect(shadowed.bandit).toBeDefined();
    expect(shadowed.bandit!.mode).toBe('shadow');
    expect(shadowed.bandit!.context.taskClass).toBe('code');
    for (const id of shadowed.bandit!.eligibleArmIds) expect(taskArmById(id)).not.toBeNull();
    if (shadowed.bandit!.appliedArmId !== null) {
      const applied = taskArmById(shadowed.bandit!.appliedArmId!)!;
      expect(applied.engine).toBe(fleet().find((s) => s.seatId === shadowed.seatId)!.engine);
    }
  });

  it('enforce mode applies the drawn engine through the ordinary gates', () => {
    const d = routeSeat(req, fleet(), policy(), opts({ taskBandit: banditOn('enforce', { hints: { itemKey: 'j2' } }) }));
    expect(d.bandit).toBeDefined();
    expect(d.bandit!.mode).toBe('enforce');
    if (d.seatId !== null) {
      const engine = fleet().find((s) => s.seatId === d.seatId)!.engine;
      expect(d.bandit!.appliedArmId).not.toBeNull();
      expect(taskArmById(d.bandit!.appliedArmId!)!.engine).toBe(engine);
      expect(d.bandit!.eligibleArmIds).toContain(d.bandit!.appliedArmId);
    }
    // Deterministic: the same inputs replay the same decision.
    expect(routeSeat(req, fleet(), policy(), opts({ taskBandit: banditOn('enforce', { hints: { itemKey: 'j2' } }) }))).toEqual(d);
  });

  it('learns: a trained posterior steers enforce to the proven engine', () => {
    // Global-cell evidence: codex terra merges cheap, opus merges expensive.
    const c = ctx();
    let state = emptyTaskBanditState();
    for (let i = 0; i < 12; i += 1) {
      state = updateTaskBanditState(state, c, 'codex:gpt-6.1-terra:low', 1);
      state = updateTaskBanditState(state, c, 'claude:opus:high', 0.1);
    }
    const d = routeSeat(req, fleet(), policy(), opts({ taskBandit: banditOn('enforce', { state, hints: { itemKey: 'j3' } }) }));
    expect(d.seatId).toBe('codex-personal');
    expect(d.bandit!.appliedArmId).toBe('codex:gpt-6.1-terra:low');
    expect(d.bandit!.divergent).toBe(false);
  });

  it('never lets a risky task leave the frontier lane', () => {
    const risky = auto('code', 'high');
    const d = routeSeat(risky, [localSeat(), claudeSeat()], policy(), opts({ taskBandit: banditOn('enforce', { hints: { itemKey: 'r' } }) }));
    const engine = d.seatId === null ? null : [localSeat(), claudeSeat()].find((s) => s.seatId === d.seatId)!.engine;
    expect(engine === null || engine !== 'local').toBe(true);
    expect(d.bandit!.eligibleArmIds.every((id) => isFrontierTaskEngine(taskArmById(id)!.engine))).toBe(true);
    // local-only capacity on a risky task holds: enforce must not relax the gate.
    const held = routeSeat(risky, [localSeat()], policy(), opts({ taskBandit: banditOn('enforce', { hints: { itemKey: 'r' } }) }));
    expect(held.seatId).toBeNull();
    expect(held.bandit!.holdReason).toContain('frontier');
    // ...while the flag-off router still takes the local seat on its own rules.
    expect(routeSeat(risky, [localSeat()], policy(), opts()).seatId).not.toBeNull();
  });

  it('never selects an unknown engine, even when it is the only seat', () => {
    const apiSeat = seat('claude-api', 'claude-api', [win('five_hour', 5), win('seven_day', 10)]);
    const d = routeSeat(req, [apiSeat], policy(), opts({ taskBandit: banditOn('enforce') }));
    expect(d.seatId).toBeNull();
    expect(d.bandit!.sampledArmId).toBeNull();
    expect(d.bandit!.holdReason).toContain('no seated engine');
  });

  it('holds when every drawn engine pool is paced out', () => {
    const d = routeSeat(req, [localSeat()], policy(), opts({
      taskBandit: {
        config: { enabled: true, mode: 'enforce', seed: 7 },
        pacing: { local: { used: 1, windowStartMs: NOW - DAY, resetAtMs: NOW + DAY } },
      },
    }));
    expect(d.seatId).toBeNull();
    expect(d.bandit!.holdReason).toContain('pacing');
  });
});

// ---------------------------------------------------------------------------
// Acceptance — the fixture replay
// ---------------------------------------------------------------------------

describe('fixture replay (acceptance)', () => {
  const records = parseTaskOutcomeLog(readFileSync(
    new URL('./fixtures/task-bandit/history.jsonl', import.meta.url), 'utf8'));
  const replayConfig = parseTaskBanditConfig({
    enabled: true, mode: 'enforce', seed: 42, minCellSamples: 2, tokenNorm: 50_000,
  });
  const report = replayTaskBandit(records, { config: replayConfig });

  it('reaches lower tokens-per-merged-PR at no-worse merge rate', () => {
    expect(report.records).toBe(227);
    expect(report.kept).toBeGreaterThanOrEqual(15);
    // the task's headline metric, on the bandit's kept (on-policy) evidence
    expect(report.bandit.tokensPerMerge!).toBeLessThan(report.staticPolicy.tokensPerMerge!);
    expect(report.bandit.tokensPerMerge!).toBeLessThan(0.75 * report.staticPolicy.tokensPerMerge!);
    expect(report.bandit.mergeRate!).toBeGreaterThanOrEqual(report.staticPolicy.mergeRate!);
    expect(report.staticOnKept).toEqual(report.bandit);
  });

  it('never draws an unknown engine', () => {
    expect(report.unknownArmRecords).toBeGreaterThanOrEqual(2);
    for (const id of report.drawnArmIds) expect(taskArmById(id)).not.toBeNull();
    expect(report.drawnArmIds.some((id) => id.startsWith('watson') || id.startsWith('claude-api'))).toBe(false);
  });

  it('holds gated records and is fully deterministic', () => {
    expect(report.held).toBeGreaterThanOrEqual(2); // credentialed + paced-out (+ risky local logs)
    expect(replayTaskBandit(records, { config: replayConfig })).toEqual(report);
  });

  it('parses the same log from a JSON array too', () => {
    const arrayForm = `[${records.map((r) => JSON.stringify(r)).join(',')}]`;
    expect(parseTaskOutcomeLog(arrayForm)).toEqual(records);
  });
});
