/**
 * Bets lane (RQ-BETS-LANE-1): a fixed share of free capacity goes to
 * ambitious experiments, each scored by the leverage it delivers and killed
 * fast when it does not pay off.
 *
 * Pure module: no I/O, no clock. The ledger is append-only JSONL; every line
 * is one event (launch, score, kill) and the current state of a bet is the
 * fold of its events in file order. A decision row always carries the numbers
 * it was made from, so the ledger alone explains every kill and every keep.
 */

export const BETS_LEDGER_SCHEMA = 'bets.ledger.v1';
export const BETS_SHARE_SCHEMA = 'bets.share.v1';
export const BET_ID_PREFIX = 'RQ-BET-';
export const BET_TIER_PREFIX = 'bet:';

export type BetStatus = 'launched' | 'kept' | 'killed';
export type BetDirection = 'up' | 'down';

export interface BetBudget {
  /** Lane-hours (sum of launch-to-finish wall time of the bet's jobs) the bet may spend. */
  maxLaneHours: number;
  /** Scoring cycles the bet may run before it must show movement. */
  maxCycles: number;
}

export interface BetMeasured {
  /** Metric value observed at the last scoring cycle, or null when the metric could not be read. */
  value: number | null;
  /** Signed improvement against baseline in the bet's direction (positive is better), or null. */
  delta: number | null;
  at: string;
}

export interface Bet {
  id: string;
  hypothesis: string;
  /** Loop metric key the bet is expected to move (see LOOP_METRIC_KEYS in loop.ts). */
  metric: string;
  direction: BetDirection;
  /** Metric value captured at launch, or null when it was unknown then. */
  baseline: number | null;
  /** Smallest improvement that counts as moved. Default 0 (any strict improvement). */
  minDelta: number;
  launchedAt: string;
  budget: BetBudget;
  killCriterion: string;
  status: BetStatus;
  cycles: number;
  measured: BetMeasured | null;
  decidedAt: string | null;
  reason: string | null;
}

export interface BetLaunchInput {
  id: string;
  hypothesis: string;
  metric: string;
  direction?: BetDirection;
  baseline?: number | null;
  minDelta?: number;
  budget: BetBudget;
  killCriterion?: string;
}

/** Numbers one scoring cycle used; persisted verbatim on the decision row. */
export interface BetObservation {
  /** Current metric value, or null when unknown. */
  value: number | null;
  /** Lane-hours consumed by the bet's jobs so far, or null when unknown. */
  laneHours: number | null;
  /** Jobs of this bet that reached MERGED. */
  merged: number;
  /** Jobs of this bet seen in the jobs ledger. */
  jobs: number;
}

export type BetDecisionKind = 'hold' | 'kept' | 'killed';
export interface BetDecision {
  id: string;
  decision: BetDecisionKind;
  reason: string;
  cycle: number;
  numbers: BetObservation & { baseline: number | null; delta: number | null; moved: boolean; overBudget: boolean; maxLaneHours: number; maxCycles: number };
}

export type BetLedgerEvent =
  | { schema: typeof BETS_LEDGER_SCHEMA; event: 'launch'; ts: string; bet: Omit<Bet, 'status' | 'cycles' | 'measured' | 'decidedAt' | 'reason'> }
  | { schema: typeof BETS_LEDGER_SCHEMA; event: 'score'; ts: string; decision: BetDecision }
  | { schema: typeof BETS_LEDGER_SCHEMA; event: 'kill'; ts: string; id: string; reason: string };

export class BetInputError extends Error {}

const BET_ID = /^RQ-BET-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const METRIC_KEY = /^[a-z][a-z0-9_.]{0,79}$/;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const positive = (v: unknown): v is number => finite(v) && v > 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !/[\p{Cc}]/u.test(v);

/** True when a ready row is a bet: id prefix RQ-BET- or a `bet:` tier. */
export function isBetRow(row: { id?: unknown; tier?: unknown }): boolean {
  return (typeof row.id === 'string' && row.id.startsWith(BET_ID_PREFIX))
    || (typeof row.tier === 'string' && row.tier.startsWith(BET_TIER_PREFIX));
}

/** Validate launch input into the ledger's launch event. Throws BetInputError on bad input. */
export function launchEvent(input: BetLaunchInput, ts: string): BetLedgerEvent {
  if (!BET_ID.test(input.id)) throw new BetInputError(`bet id must match ${BET_ID.source}`);
  if (!text(input.hypothesis, 1000)) throw new BetInputError('hypothesis is required (1 to 1000 printable characters)');
  if (!METRIC_KEY.test(input.metric)) throw new BetInputError('metric must be a loop metric key such as merges_per_hour.6h');
  const direction = input.direction ?? 'up';
  if (direction !== 'up' && direction !== 'down') throw new BetInputError('direction must be up or down');
  if (!positive(input.budget.maxLaneHours)) throw new BetInputError('max lane-hours must be a positive number');
  if (!Number.isSafeInteger(input.budget.maxCycles) || input.budget.maxCycles < 1) throw new BetInputError('max cycles must be a positive integer');
  const minDelta = input.minDelta ?? 0;
  if (!finite(minDelta) || minDelta < 0) throw new BetInputError('min delta must be a non-negative number');
  const baseline = input.baseline ?? null;
  if (baseline !== null && !finite(baseline)) throw new BetInputError('baseline must be a number');
  const killCriterion = input.killCriterion ?? `over ${input.budget.maxLaneHours} lane-hours or ${input.budget.maxCycles} cycles without ${input.metric} moving ${direction}`;
  if (!text(killCriterion, 500)) throw new BetInputError('kill criterion must be 1 to 500 printable characters');
  return {
    schema: BETS_LEDGER_SCHEMA, event: 'launch', ts,
    bet: { id: input.id, hypothesis: input.hypothesis.trim(), metric: input.metric, direction, baseline, minDelta, launchedAt: ts, budget: { ...input.budget }, killCriterion },
  };
}

function asEvent(line: string): BetLedgerEvent | null {
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.schema !== BETS_LEDGER_SCHEMA || typeof row.ts !== 'string') return null;
  if (row.event === 'launch' && row.bet && typeof row.bet === 'object') {
    const b = row.bet as Record<string, unknown>;
    const budget = b.budget as Record<string, unknown> | undefined;
    if (typeof b.id !== 'string' || !BET_ID.test(b.id) || typeof b.hypothesis !== 'string' || typeof b.metric !== 'string'
      || (b.direction !== 'up' && b.direction !== 'down') || !budget || !positive(budget.maxLaneHours)
      || !Number.isSafeInteger(budget.maxCycles) || typeof b.launchedAt !== 'string') return null;
    return row as unknown as BetLedgerEvent;
  }
  if (row.event === 'score' && row.decision && typeof row.decision === 'object') {
    const d = row.decision as Record<string, unknown>;
    return typeof d.id === 'string' && ['hold', 'kept', 'killed'].includes(d.decision as string) ? row as unknown as BetLedgerEvent : null;
  }
  if (row.event === 'kill' && typeof row.id === 'string' && typeof row.reason === 'string') return row as unknown as BetLedgerEvent;
  return null;
}

export interface BetsFold { bets: Bet[]; ignored: number }

/**
 * Fold ledger text into the current bets, in launch order. A second launch of
 * a known id, events for unknown ids and any event after a terminal decision
 * are ignored (counted) so a replayed or hand-edited line cannot resurrect a
 * killed bet.
 */
export function foldBets(ledger: string | null): BetsFold {
  const bets = new Map<string, Bet>();
  let ignored = 0;
  for (const line of (ledger ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const event = asEvent(line);
    if (!event) { ignored++; continue; }
    if (event.event === 'launch') {
      if (bets.has(event.bet.id)) { ignored++; continue; }
      bets.set(event.bet.id, {
        ...event.bet, minDelta: finite(event.bet.minDelta) ? event.bet.minDelta : 0,
        baseline: finite(event.bet.baseline) ? event.bet.baseline : null,
        status: 'launched', cycles: 0, measured: null, decidedAt: null, reason: null,
      });
      continue;
    }
    const id = event.event === 'score' ? event.decision.id : event.id;
    const bet = bets.get(id);
    if (!bet || bet.status !== 'launched') { ignored++; continue; }
    if (event.event === 'kill') {
      Object.assign(bet, { status: 'killed', decidedAt: event.ts, reason: event.reason });
      continue;
    }
    const d = event.decision;
    bet.cycles = Number.isSafeInteger(d.cycle) ? d.cycle : bet.cycles + 1;
    bet.measured = { value: finite(d.numbers?.value) ? d.numbers.value : null, delta: finite(d.numbers?.delta) ? d.numbers.delta : null, at: event.ts };
    if (d.decision !== 'hold') Object.assign(bet, { status: d.decision, decidedAt: event.ts, reason: d.reason });
  }
  return { bets: [...bets.values()], ignored };
}

/** Signed improvement in the bet's direction; null when either side is unknown. */
export function betDelta(bet: Pick<Bet, 'baseline' | 'direction'>, value: number | null): number | null {
  if (value === null || bet.baseline === null) return null;
  return bet.direction === 'up' ? value - bet.baseline : bet.baseline - value;
}

/**
 * Kill-fast scorer for one cycle. Rules, in order:
 *   kept   when at least one bet job merged and the metric moved by more than minDelta;
 *   killed when the budget (lane-hours or cycles) is exhausted and the metric did not move;
 *   killed when the budget is exhausted, the metric moved, but nothing merged
 *          (movement cannot be attributed to the bet without a merge);
 *   hold   otherwise.
 * An unknown metric value or baseline never counts as moved. Unknown lane-hours
 * never count as over budget on their own; the cycle budget still applies.
 */
export function scoreBet(bet: Bet, obs: BetObservation): BetDecision {
  const cycle = bet.cycles + 1;
  const delta = betDelta(bet, obs.value);
  const moved = delta !== null && delta > bet.minDelta;
  const overLaneHours = obs.laneHours !== null && obs.laneHours > bet.budget.maxLaneHours;
  const overCycles = cycle >= bet.budget.maxCycles;
  const overBudget = overLaneHours || overCycles;
  const numbers = { ...obs, baseline: bet.baseline, delta, moved, overBudget, maxLaneHours: bet.budget.maxLaneHours, maxCycles: bet.budget.maxCycles };
  const fmt = (n: number | null) => n === null ? 'unknown' : String(Math.round(n * 1000) / 1000);
  const budgetText = `lane-hours ${fmt(obs.laneHours)}/${bet.budget.maxLaneHours}, cycle ${cycle}/${bet.budget.maxCycles}`;
  const metricText = `${bet.metric} ${fmt(bet.baseline)} -> ${fmt(obs.value)} (delta ${fmt(delta)}, need > ${bet.minDelta} ${bet.direction})`;
  if (obs.merged > 0 && moved) return { id: bet.id, decision: 'kept', cycle, numbers, reason: `kept: ${obs.merged} merged and ${metricText}` };
  if (overBudget && !moved) return { id: bet.id, decision: 'killed', cycle, numbers, reason: `killed: over budget (${budgetText}) and ${metricText}` };
  if (overBudget) return { id: bet.id, decision: 'killed', cycle, numbers, reason: `killed: over budget (${budgetText}), metric moved but 0 of ${obs.jobs} jobs merged` };
  return { id: bet.id, decision: 'hold', cycle, numbers, reason: `hold: ${budgetText}; ${obs.merged} merged; ${metricText}` };
}

export interface BetsShareConfig {
  /** Fraction of free slots reserved for bet rows. Default 0.1. */
  share?: number;
  /** Reserved slots whenever at least one slot is free. Default 1. */
  minWhenFree?: number;
  /** False turns the reservation off (reserved 0). Default true. */
  enabled?: boolean;
}
export interface BetsCapacity {
  /** Slots free this cycle (cap minus running), or null when unknown. */
  freeSlots: number | null;
  /** Ready rows tagged as bets, or null when the queue was not read. */
  readyBetRows?: number | null;
}
export interface BetsShare {
  schema: typeof BETS_SHARE_SCHEMA;
  share: number;
  minWhenFree: number;
  enabled: boolean;
  freeSlots: number | null;
  /** Slots reserved for bet rows this cycle. */
  reserved: number;
  readyBetRows: number | null;
  /** Reserved slots a bet row can actually use now: min(reserved, readyBetRows) when the queue was read. */
  usable: number;
  reason: string;
}

export const DEFAULT_BETS_SHARE = 0.1;

/**
 * Reserve a share of free slots for bet rows: floor(free * share), at least
 * minWhenFree whenever any slot is free, never more than free. Unknown free
 * slots reserve nothing (fail closed: no guessed capacity).
 */
export function betsShare(capacity: BetsCapacity, config: BetsShareConfig = {}): BetsShare {
  const share = finite(config.share) && config.share >= 0 && config.share <= 1 ? config.share : DEFAULT_BETS_SHARE;
  const minWhenFree = Number.isSafeInteger(config.minWhenFree) && config.minWhenFree! >= 0 ? config.minWhenFree! : 1;
  const enabled = config.enabled !== false;
  const free = Number.isSafeInteger(capacity.freeSlots) && capacity.freeSlots! >= 0 ? capacity.freeSlots! : null;
  const ready = Number.isSafeInteger(capacity.readyBetRows) && capacity.readyBetRows! >= 0 ? capacity.readyBetRows! : null;
  const base = { schema: BETS_SHARE_SCHEMA, share, minWhenFree, enabled, freeSlots: free, readyBetRows: ready } as const;
  if (!enabled) return { ...base, reserved: 0, usable: 0, reason: 'bets share disabled' };
  if (free === null) return { ...base, reserved: 0, usable: 0, reason: 'free slots unknown: nothing reserved' };
  if (free === 0) return { ...base, reserved: 0, usable: 0, reason: 'no free slots' };
  const reserved = Math.min(free, Math.max(minWhenFree, Math.floor(free * share)));
  const usable = ready === null ? reserved : Math.min(reserved, ready);
  return { ...base, reserved, usable, reason: `${reserved} of ${free} free slots reserved (share ${share}, min ${minWhenFree})` };
}

export interface BetsCounts { launched: number; kept: number; killed: number }
/** Morning-file counts: every bet ever launched, and how many reached each terminal state. */
export function betsCounts(bets: readonly Bet[]): BetsCounts {
  return { launched: bets.length, kept: bets.filter(b => b.status === 'kept').length, killed: bets.filter(b => b.status === 'killed').length };
}
