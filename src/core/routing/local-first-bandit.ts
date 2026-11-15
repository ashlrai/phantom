/**
 * Local-first bandit lane (RQ-AUTO-LOCAL-1, stacked on #926 and #952).
 *
 * A two-arm lane chooser over engine classes { local, frontier }, scored on
 * merged PRs per dollar and merged PRs per hour. Evidence is the per-run
 * routing ledger (routing-ledger.ts: which item ran on which engine class)
 * joined with merge outcomes (merged or not, cost, wall time) by item id.
 *
 * Invariants:
 *   - Default-off: with no valid `localFirstBandit` config (enabled: true),
 *     routing is exactly `routeSeatWithLocalEscalation` (the P4 policy).
 *   - P4 safety vetoes win: the bandit only chooses when P4 already says
 *     local is fine ('local-ok'). It can keep local or move the item to a
 *     frontier seat; it never moves an item P4 escalated back to local.
 *   - Cold start defers to P4 until each arm has `minSamplesPerArm` outcomes.
 *   - The bandit never picks local for merge, merge-rights, credential or
 *     publish roles: those route only over seats `engineClassMayMergeOrPublish`
 *     admits AND that classify as frontier; credentialed steps route nowhere
 *     (P4 behaviour, no model seat holds secrets).
 *   - Unknown engine ids are 'unclassified': no arm, no evidence, no privileges.
 *   - Deterministic: every random draw comes from a seeded PRNG keyed on
 *     (seed, item id), so a replay of the same ledger picks the same lanes.
 *   - Value-free: inputs are ids, classes, counts, dollars and hours only.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ashlrRoot } from './budget-store.js';
import {
  classifyEngine,
  engineClassMayMergeOrPublish,
  routeSeatWithLocalEscalation,
  type LocalRouteContext,
  type LocalRouteDecision,
  type LocalRouteInput,
} from './local-route.js';
import { routeSeat, type RouteOptions } from './router.js';
import { readRoutingLedger, type RoutingLedgerEntry } from './routing-ledger.js';
import type { SeatCapacity } from './headroom.js';
import type { BudgetPolicy, RoutingRequest } from './types.js';

export type BanditArm = 'local' | 'frontier';
export const BANDIT_ARMS: readonly BanditArm[] = ['local', 'frontier'];
export type BanditStrategy = 'thompson' | 'epsilon';

export interface LocalFirstBanditConfig {
  enabled: boolean;
  strategy: BanditStrategy;
  /** Exploration rate for 'epsilon' (0 to 0.5). */
  epsilon: number;
  /** PRNG seed; the per-item stream is keyed on (seed, item id). */
  seed: number;
  /** Outcomes each arm needs before the bandit overrides P4. */
  minSamplesPerArm: number;
  /** Weight of merged-PRs-per-$ vs merged-PRs-per-hour (0 to 1). */
  costWeight: number;
  /** Per-run cost floor in USD, so a free local run is not infinitely good per $. */
  costFloorUsd: number;
  /** Per-run wall time floor in hours. */
  hourFloor: number;
}

export const DEFAULT_LOCAL_FIRST_BANDIT: Readonly<LocalFirstBanditConfig> = Object.freeze({
  enabled: false,
  strategy: 'thompson',
  epsilon: 0.1,
  seed: 1,
  minSamplesPerArm: 5,
  costWeight: 0.5,
  costFloorUsd: 0.01,
  hourFloor: 1 / 60,
});

const num = (v: unknown, lo: number, hi: number, dflt: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : dflt;

/** Pure. Parses `localFirstBandit`; anything absent or malformed keeps it off. Out-of-range fields fall back to defaults. */
export function parseLocalFirstBanditConfig(raw: unknown): LocalFirstBanditConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_LOCAL_FIRST_BANDIT };
  const r = raw as Record<string, unknown>;
  const d = DEFAULT_LOCAL_FIRST_BANDIT;
  return {
    enabled: r['enabled'] === true,
    strategy: r['strategy'] === 'epsilon' ? 'epsilon' : 'thompson',
    epsilon: num(r['epsilon'], 0, 0.5, d.epsilon),
    seed: Number.isSafeInteger(r['seed']) ? (r['seed'] as number) : d.seed,
    minSamplesPerArm: Number.isSafeInteger(r['minSamplesPerArm']) && (r['minSamplesPerArm'] as number) >= 1 && (r['minSamplesPerArm'] as number) <= 1000
      ? (r['minSamplesPerArm'] as number) : d.minSamplesPerArm,
    costWeight: num(r['costWeight'], 0, 1, d.costWeight),
    costFloorUsd: num(r['costFloorUsd'], 0.0001, 100, d.costFloorUsd),
    hourFloor: num(r['hourFloor'], 1 / 3600, 24, d.hourFloor),
  };
}

/** One finished item: did its PR merge, what it cost, how long it took. */
export interface MergeOutcome {
  itemId: string;
  merged: boolean;
  costUsd?: number;
  wallMs?: number;
}

export interface ArmStats {
  /** Items with a known outcome. */
  pulls: number;
  merges: number;
  costUsd: number;
  hours: number;
}
export type BanditStats = Record<BanditArm, ArmStats>;

const emptyArm = (): ArmStats => ({ pulls: 0, merges: 0, costUsd: 0, hours: 0 });
const nonNegFinite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Pure. Joins ledger entries to outcomes by item id. Only entries whose engine
 * class is 'local' or 'frontier' count; unclassified engines earn no evidence.
 * The latest ledger entry per item wins; items without an outcome are skipped.
 */
export function banditStatsFrom(entries: readonly RoutingLedgerEntry[], outcomes: readonly MergeOutcome[]): BanditStats {
  const stats: BanditStats = { local: emptyArm(), frontier: emptyArm() };
  const classOf = new Map<string, BanditArm>();
  for (const e of entries) {
    if (e && (e.engineClass === 'local' || e.engineClass === 'frontier')) classOf.set(String(e.itemId), e.engineClass);
    else if (e) classOf.delete(String(e.itemId));
  }
  const seen = new Set<string>();
  for (const o of outcomes) {
    const id = String(o?.itemId ?? '');
    const arm = classOf.get(id);
    if (!arm || seen.has(id)) continue;
    seen.add(id);
    const s = stats[arm];
    s.pulls++;
    if (o.merged === true) s.merges++;
    s.costUsd += nonNegFinite(o.costUsd);
    s.hours += nonNegFinite(o.wallMs) / 3_600_000;
  }
  return stats;
}

/** Pure. mulberry32 stream keyed on FNV-1a(seed, key). Returns floats in [0, 1). */
export function seededRandom(seed: number, key = ''): () => number {
  let h = 0x811c9dc5;
  for (const ch of `${seed}:${key}`) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normal(rng: () => number): number {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

/** Marsaglia-Tsang gamma sample, shape >= 1 (all shapes here are 1 + count). */
function gamma(shape: number, rng: () => number): number {
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    const x = normal(rng);
    const v = (1 + c * x) ** 3;
    if (v <= 0) continue;
    const u = Math.max(rng(), 1e-12);
    if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
  }
}

/** Pure given rng. Beta(a, b) sample, a and b >= 1. */
export function sampleBeta(a: number, b: number, rng: () => number): number {
  const x = gamma(a, rng);
  return x / (x + gamma(b, rng));
}

export type BanditReason =
  | 'disabled'
  | 'p4-veto'
  | 'authority-frontier-only'
  | 'cold-start-p4'
  | 'exploit'
  | 'explore'
  | 'no-frontier-seat';

export interface ArmScore {
  mergeRate: number;
  perDollar: number;
  perHour: number;
  score: number;
}

export interface BanditChoice {
  lane: BanditArm;
  reason: BanditReason;
  scores?: Record<BanditArm, ArmScore>;
}

/** Pure given rng. Scores both arms; higher combined score wins, ties go local (local-first). */
export function scoreArms(stats: BanditStats, cfg: LocalFirstBanditConfig, rng: () => number, sample: boolean): Record<BanditArm, ArmScore> {
  const raw = {} as Record<BanditArm, Omit<ArmScore, 'score'>>;
  for (const arm of BANDIT_ARMS) {
    const s = stats[arm];
    const fails = Math.max(0, s.pulls - s.merges);
    const mergeRate = sample ? sampleBeta(1 + s.merges, 1 + fails, rng) : (1 + s.merges) / (2 + s.pulls);
    const meanCost = Math.max(cfg.costFloorUsd, s.pulls > 0 ? s.costUsd / s.pulls : cfg.costFloorUsd);
    const meanHours = Math.max(cfg.hourFloor, s.pulls > 0 ? s.hours / s.pulls : cfg.hourFloor);
    raw[arm] = { mergeRate, perDollar: mergeRate / meanCost, perHour: mergeRate / meanHours };
  }
  const maxD = Math.max(raw.local.perDollar, raw.frontier.perDollar) || 1;
  const maxH = Math.max(raw.local.perHour, raw.frontier.perHour) || 1;
  const out = {} as Record<BanditArm, ArmScore>;
  for (const arm of BANDIT_ARMS) {
    const r = raw[arm];
    out[arm] = { ...r, score: cfg.costWeight * (r.perDollar / maxD) + (1 - cfg.costWeight) * (r.perHour / maxH) };
  }
  return out;
}

export interface LaneChoiceInput {
  /** The lane the P4 policy picked and why. */
  p4: Pick<LocalRouteDecision, 'lane' | 'laneReason'>;
  /** Merge, merge-rights, credential or publish role. */
  authority: boolean;
}

/** Pure given rng. The bandit's lane for one item. */
export function chooseLocalFirstLane(
  input: LaneChoiceInput,
  stats: BanditStats,
  cfg: LocalFirstBanditConfig,
  rng: () => number,
): BanditChoice {
  if (!cfg.enabled) return { lane: input.p4.lane, reason: 'disabled' };
  if (input.authority) return { lane: 'frontier', reason: 'authority-frontier-only' };
  if (input.p4.lane !== 'local' || input.p4.laneReason !== 'local-ok') return { lane: input.p4.lane, reason: 'p4-veto' };
  if (BANDIT_ARMS.some((a) => stats[a].pulls < cfg.minSamplesPerArm)) return { lane: 'local', reason: 'cold-start-p4' };
  if (cfg.strategy === 'epsilon') {
    const explore = rng() < cfg.epsilon;
    const scores = scoreArms(stats, cfg, rng, false);
    if (explore) return { lane: rng() < 0.5 ? 'local' : 'frontier', reason: 'explore', scores };
    return { lane: scores.frontier.score > scores.local.score ? 'frontier' : 'local', reason: 'exploit', scores };
  }
  const scores = scoreArms(stats, cfg, rng, true);
  return { lane: scores.frontier.score > scores.local.score ? 'frontier' : 'local', reason: 'exploit', scores };
}

export interface LocalFirstBanditContext {
  /** Raw `localFirstBandit` config value; absent or invalid keeps the bandit off. */
  config: unknown;
  stats: BanditStats;
  /** Item id; keys the deterministic PRNG stream. */
  itemId: string;
}

export type BanditRouteDecision = Omit<LocalRouteDecision, 'laneReason'> & {
  laneReason: LocalRouteDecision['laneReason'] | 'bandit-frontier';
  bandit: BanditChoice;
};

const isAuthority = (i: LocalRouteInput): boolean =>
  Boolean(i.mergesToMain) || Boolean(i.holdsMergeRights) || Boolean(i.publishes) || Boolean(i.needsCredentials);

/**
 * Pure. Routes like `routeSeatWithLocalEscalation`, then lets the bandit keep
 * a P4 'local-ok' item local or move it to a frontier seat. With the bandit
 * disabled the result is the P4 decision unchanged (plus `bandit.reason: 'disabled'`).
 */
export function routeSeatWithLocalFirstBandit(
  req: RoutingRequest,
  capacity: readonly SeatCapacity[],
  budget: BudgetPolicy,
  opts: RouteOptions,
  input: LocalRouteInput,
  ctx: LocalRouteContext,
  bandit: LocalFirstBanditContext | null | undefined,
): BanditRouteDecision {
  const cfg = parseLocalFirstBanditConfig(bandit?.config);
  const p4 = routeSeatWithLocalEscalation(req, capacity, budget, opts, input, ctx);
  if (!cfg.enabled || !bandit) return { ...p4, bandit: { lane: p4.lane, reason: 'disabled' } };

  const engines = ctx.engines;
  const frontierOnly = (c: SeatCapacity): boolean => {
    const cls = classifyEngine(c, engines);
    return cls === 'frontier' && engineClassMayMergeOrPublish(cls);
  };
  const authority = isAuthority(input);
  const choice = chooseLocalFirstLane({ p4, authority }, bandit.stats, cfg, seededRandom(cfg.seed, String(bandit.itemId)));

  if (authority) {
    // Credentialed steps keep P4's route-nowhere result; merge, merge-rights and publish go frontier-only.
    if (input.needsCredentials) return { ...p4, bandit: choice };
    const d = routeSeat(req, capacity.filter(frontierOnly), budget, opts);
    return { ...d, lane: 'frontier', laneReason: p4.laneReason === 'local-ok' ? 'bandit-frontier' : p4.laneReason, bandit: choice };
  }
  if (choice.lane === 'frontier' && p4.lane === 'local') {
    const d = routeSeat(req, capacity.filter(frontierOnly), budget, opts);
    if (d.seatId !== null) return { ...d, lane: 'frontier', laneReason: 'bandit-frontier', bandit: choice };
    return { ...p4, bandit: { ...choice, lane: 'local', reason: 'no-frontier-seat' } };
  }
  return { ...p4, bandit: choice };
}

export const MERGE_OUTCOMES_MAX = 500;

export function mergeOutcomesPath(): string {
  return join(ashlrRoot(), 'routing', 'merge-outcomes.json');
}

interface MergeOutcomesFile { schemaVersion: 1; outcomes: MergeOutcome[] }

/** Never throws; a missing or malformed file reads as no outcomes. */
export function readMergeOutcomes(path = mergeOutcomesPath()): MergeOutcome[] {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as MergeOutcomesFile;
    return v && v.schemaVersion === 1 && Array.isArray(v.outcomes) ? v.outcomes : [];
  } catch { return []; }
}

/** Pure. Appends one outcome (latest per item wins) and bounds the list. */
export function appendMergeOutcome(prev: readonly MergeOutcome[], o: MergeOutcome): MergeOutcome[] {
  const clean: MergeOutcome = {
    itemId: String(o.itemId),
    merged: o.merged === true,
    ...(nonNegFinite(o.costUsd) > 0 ? { costUsd: nonNegFinite(o.costUsd) } : {}),
    ...(nonNegFinite(o.wallMs) > 0 ? { wallMs: nonNegFinite(o.wallMs) } : {}),
  };
  return [...prev.filter((p) => p.itemId !== clean.itemId), clean].slice(-MERGE_OUTCOMES_MAX);
}

/** Records one outcome atomically. Accounting never blocks the caller. */
export function recordMergeOutcome(o: MergeOutcome, path = mergeOutcomesPath()): void {
  try {
    const next: MergeOutcomesFile = { schemaVersion: 1, outcomes: appendMergeOutcome(readMergeOutcomes(path), o) };
    mkdirSync(join(path, '..'), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* never blocks */ }
}

/** Never throws. Bandit evidence from the on-disk routing ledger and merge outcomes. */
export function loadBanditStats(ledgerPath?: string, outcomesPath?: string): BanditStats {
  try {
    const ledger = readRoutingLedger(ledgerPath);
    return banditStatsFrom(ledger?.entries ?? [], readMergeOutcomes(outcomesPath));
  } catch { return { local: emptyArm(), frontier: emptyArm() }; }
}
