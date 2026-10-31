/**
 * graph-live.ts — read-only live-state joiner for the graph.v1 fleet registry.
 *
 * src/core/graph/registry.ts projects the fleet INVENTORY (agents, engine
 * accounts, model catalogs, MCP identities). This module joins the LIVE
 * evidence the fleet already keeps onto those nodes:
 *
 *   capacity    — most-utilized provider window (capacity snapshot seats and
 *                 the subscription-window readings of subscription-usage.ts)
 *                 and the configured dispatch quota standing of quota.ts
 *   cost        — metered USD spent today attributed to the node's resources
 *                 (per-seat spend, plus the fleet daily-budget view)
 *   reset time  — soonest known provider-window reset, epoch ms
 *   staleness   — age of the freshest contributing reading against the same
 *                 staleness bound the headroom gate uses
 *
 * joinGraphLive() is a PURE projection: every input is passed in, the clock is
 * an explicit nowMs, nothing is read or written, and no input is mutated.
 * readGraphLive() is a thin never-throw convenience that gathers the same
 * never-throw readers the gates themselves use (readCapacitySnapshot,
 * subscriptionUsage, subscriptionAllows, loadFleetQuota) and calls the pure
 * join — the same read path the dispatch gates take, shared-ledger presence
 * publication included.
 *
 * A node state is an OBSERVATION, never a dispatch decision. The runtime gates
 * (subscriptionAllows, reserveFleetQuotaUse, the router) remain authoritative.
 *
 * Node state vocabulary, most-blocking last:
 *   untracked  — no live signal applies (mcp nodes, unbound agents, engines
 *                with no capacity/quota evidence at all)
 *   ready      — known fresh headroom under every applicable window and quota
 *   limited    — warn-level: quota warn or a fresh window at/above warnPercent
 *   unknown    — a reading was expected but none qualifies (the fail-closed
 *                class: unknown usage is not headroom)
 *   stale      — readings existed but every valid dated one exceeded the bound
 *   held       — a gate or policy refused (verdict, signed-out seat, invalid
 *                quota configuration, daily budget cap)
 *   exhausted  — provably saturated: provider limit flag, >=100% used, quota over
 */

import { HEADROOM_READING_MAX_AGE_MS, type SeatCapacity } from '../routing/headroom.js';
import { readCapacitySnapshot } from '../routing/budget-store.js';
import { engineTierOf } from '../run/sandboxed-engine.js';
import type { RegistryGraph, RegistryNode } from '../graph/types.js';
import type { AshlrConfig, EngineId } from '../types.js';
import type { FleetBudget } from './budget-view.js';
import {
  inspectConfiguredQuotaLimit,
  loadFleetQuota,
  type FleetQuotaEvent,
} from './quota.js';
import {
  isSubscriptionEngine,
  subscriptionAllows,
  subscriptionUsage,
  type SubscriptionAllowResult,
  type SubscriptionUsage,
} from './subscription-usage.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export const GRAPH_LIVE_SCHEMA = 'graph-live.v1' as const;

/** Default warn threshold, aligned with evalQuota's 80% warn band. */
export const GRAPH_LIVE_WARN_PERCENT = 80;

export type GraphLiveState =
  | 'ready'
  | 'limited'
  | 'exhausted'
  | 'held'
  | 'stale'
  | 'unknown'
  | 'untracked';

/** Rank order for worst-of joins; higher blocks more. */
const STATE_RANK: Record<GraphLiveState, number> = {
  untracked: 0,
  ready: 1,
  limited: 2,
  unknown: 3,
  stale: 4,
  held: 5,
  exhausted: 6,
};

export interface GraphLiveQuota {
  /** Dispatches counted inside the configured window; null when unread. */
  used: number | null;
  limit: number | null;
  windowLabel: string | null;
  standing: 'ok' | 'warn' | 'over' | 'unlimited' | 'unknown';
}

/** The live evidence joined onto one graph.v1 node. */
export interface GraphNodeLive {
  state: GraphLiveState;
  /** Most-utilized fresh binding signal (0-100); null when nothing measured. */
  usedPercent: number | null;
  /** Configured rolling-window dispatch quota for the node's engine. */
  quota: GraphLiveQuota | null;
  /** Soonest known future provider-window reset, epoch ms; null unknown. */
  resetsAtMs: number | null;
  /** Metered USD spent today attributed to this node's resources; null unmeasured. */
  spentTodayUsd: number | null;
  /** Age of the freshest valid dated reading (ms); null = age unknown. */
  readingAgeMs: number | null;
  /** Dated readings existed and every one exceeded the staleness bound. */
  stale: boolean;
  /** Fixed, deduplicated, sorted reasons backing the state. */
  reasons: string[];
}

export type GraphLiveNode = RegistryNode & { live: GraphNodeLive };

export type GraphLiveIssueCode =
  | 'graph-unavailable'
  | 'graph-incomplete'
  | 'seats-missing'
  | 'seat-unread'
  | 'quota-ledger-missing'
  | 'quota-limit-invalid';

export interface GraphLiveIssue {
  code: GraphLiveIssueCode;
  /** Affected graph.v1 node ids; empty when the issue is projection-wide. */
  nodeIds: string[];
}

/**
 * A bare SubscriptionUsage is a caller-supplied current snapshot. Wrappers
 * and provider seats require a finite timestamp no later than now; missing,
 * invalid, or future times have unknown age and cannot establish headroom.
 */
export type GraphLiveUsageInput =
  | SubscriptionUsage
  | { usage?: SubscriptionUsage | null; observedAtMs?: number }
  | null;

/** Every input the join consumes; gathering them is the caller's job. */
export interface GraphLiveSources {
  /** Capacity snapshot seat rows (CapacitySnapshot.seats). null = roster unread. */
  seats?: readonly SeatCapacity[] | null;
  /** Per-engine subscription-window readings, keyed by engine id. */
  usage?: Readonly<Partial<Record<string, GraphLiveUsageInput>>>;
  /** Per-engine dispatch-gate verdicts (subscriptionAllows output). */
  verdicts?: Readonly<Partial<Record<string, SubscriptionAllowResult>>>;
  /** The fleet quota ledger (loadFleetQuota output). null/undefined = unread. */
  quota?: { readonly events?: readonly FleetQuotaEvent[] } | null;
  /** Operator config; cfg.foundry.limits supplies the quota caps. */
  cfg?: AshlrConfig | null;
  /** Fleet daily-budget view (fleetBudget output). */
  budget?: FleetBudget | null;
}

export interface GraphLiveOptions {
  /** Explicit clock: required so the join stays pure and reproducible. */
  nowMs: number;
  /** Max age of a contributing reading before it counts as stale. */
  readingMaxAgeMs?: number;
  /** Window utilization percent that marks a node limited. */
  warnPercent?: number;
}

export interface GraphLiveProjection {
  schema: typeof GRAPH_LIVE_SCHEMA;
  readOnly: true;
  authority: 'observation-only';
  sampledAtMs: number;
  complete: boolean;
  /** Registry nodes in graph order, each with its joined live evidence. */
  nodes: GraphLiveNode[];
  counts: { nodes: number; byState: Record<GraphLiveState, number> };
  /** Fleet-level daily budget cost view, when supplied. */
  budget: {
    spentTodayUsd: number | null;
    dailyBudgetUsd: number;
    remainingUsd: number | null;
    capReached: boolean | null;
  } | null;
  issues: GraphLiveIssue[];
}

// ---------------------------------------------------------------------------
// Internal signal model
// ---------------------------------------------------------------------------

/** One dated-or-undated capacity reading contributing to a node. */
interface Contribution {
  /** Stable label used in reasons, e.g. a seat id or 'subscription 5h'. */
  label: string;
  usedPercent: number | null;
  resetsAtMs: number | null;
  /** Reading age in ms; null when its timestamp cannot establish an age. */
  ageMs: number | null;
  fresh: boolean;
  limitReached: boolean;
  spentTodayUsd: number | null;
  /** A non-percent live fact that fixes the state (signed out, unreachable). */
  forceState?: GraphLiveState;
}

interface LiveSignals {
  contributions: Contribution[];
  quota: GraphLiveQuota | null;
  quotaInvalid: boolean;
  verdict: SubscriptionAllowResult | undefined;
  budgetHeld: boolean;
  tracked: boolean;
}

const UNTRACKED_LIVE: GraphNodeLive = {
  state: 'untracked',
  usedPercent: null,
  quota: null,
  resetsAtMs: null,
  spentTodayUsd: null,
  readingAgeMs: null,
  stale: false,
  reasons: ['no live signal applies'],
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function dedupeSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function observationAge(observedAtMs: unknown, nowMs: number): number | null {
  const at = finiteNumber(observedAtMs);
  if (at === null || at > nowMs) return null;
  return finiteNumber(nowMs - at);
}

/** Percent is a provider reading: clamp garbage into the measured band. */
function clampPercent(value: unknown): number | null {
  const n = finiteNumber(value);
  return n === null ? null : Math.max(0, Math.min(100, n));
}

// ---------------------------------------------------------------------------
// Contribution builders — seats, subscription windows, quota, budget, verdicts
// ---------------------------------------------------------------------------

function seatContribution(
  seat: SeatCapacity,
  nowMs: number,
  maxAgeMs: number,
): Contribution {
  const label = `seat ${seat.seatId}`;
  const spent = finiteNumber(seat.spentTodayUsd);
  if (seat.free) {
    // A local seat has no provider window to age out: its roster presence is
    // the evidence, and it is always current.
    return { label, usedPercent: 0, resetsAtMs: null, ageMs: 0, fresh: true,
      limitReached: false, spentTodayUsd: spent };
  }
  const observedMs = seat.observedAt === null ? NaN : Date.parse(seat.observedAt);
  const ageMs = observationAge(observedMs, nowMs);
  if (seat.signedOut || seat.reachable === false) {
    return { label, usedPercent: null, resetsAtMs: null, ageMs,
      fresh: ageMs !== null, limitReached: false, spentTodayUsd: spent,
      forceState: 'held' };
  }
  let usedPercent: number | null = null;
  let bindingResetsAtMs: number | null = null;
  let limitReached = false;
  for (const window of seat.windows) {
    if (window.limitReached) limitReached = true;
    const pct = clampPercent(window.usedPercent);
    if (pct !== null && (usedPercent === null || pct > usedPercent)) {
      usedPercent = pct;
      bindingResetsAtMs = null;
    }
    // Reset times join from the most-utilized (binding) window only.
    const resetMs = window.resetsAt === null ? NaN : Date.parse(window.resetsAt);
    if (Number.isFinite(resetMs) && (window.limitReached || pct === usedPercent) &&
        (bindingResetsAtMs === null || resetMs < bindingResetsAtMs)) {
      bindingResetsAtMs = resetMs;
    }
  }
  return { label, usedPercent, resetsAtMs: bindingResetsAtMs, ageMs,
    fresh: ageMs !== null && ageMs <= maxAgeMs, limitReached, spentTodayUsd: spent };
}

function usageContribution(
  engine: string,
  input: GraphLiveUsageInput,
  nowMs: number,
  maxAgeMs: number,
): Contribution | null {
  if (input === null || input === undefined || typeof input !== 'object') return null;
  let usage: SubscriptionUsage | null | undefined;
  let ageMs: number | null;
  if ('usedPercent' in input) {
    usage = input;
    ageMs = 0; // Legacy direct input is explicitly a current snapshot.
  } else {
    usage = input.usage;
    ageMs = observationAge(input.observedAtMs, nowMs);
  }
  if (usage === null || usage === undefined || typeof usage !== 'object') return null;
  const usedPercent = clampPercent(usage.usedPercent);
  if (usedPercent === null) return null;
  const resetsAtMs = finiteNumber(usage.resetsAt) !== null
    ? (usage.resetsAt as number) * 1000
    : null;
  const windowLabel = typeof usage.windowLabel === 'string' && usage.windowLabel.length > 0
    ? usage.windowLabel
    : 'window';
  return {
    label: `${engine} subscription ${windowLabel}`,
    usedPercent,
    resetsAtMs,
    ageMs,
    fresh: ageMs !== null && ageMs <= maxAgeMs,
    limitReached: false,
    spentTodayUsd: null,
  };
}

interface QuotaSignal {
  quota: GraphLiveQuota | null;
  invalid: boolean;
  ledgerMissing: boolean;
}

function quotaSignal(
  engine: string,
  cfg: AshlrConfig | null | undefined,
  ledger: { readonly events?: readonly FleetQuotaEvent[] } | null | undefined,
  nowMs: number,
): QuotaSignal {
  const limit = inspectConfiguredQuotaLimit(cfg, engine as EngineId);
  if (limit === null) return { quota: null, invalid: false, ledgerMissing: false };
  const configured = cfg?.foundry?.limits?.[engine as EngineId];
  const windowLabel = typeof configured?.window === 'string' ? configured.window : null;
  if (limit === 'invalid') {
    return { quota: { used: null, limit: null, windowLabel, standing: 'unknown' },
      invalid: true, ledgerMissing: false };
  }
  if (ledger === null || ledger === undefined) {
    return { quota: { used: null, limit: limit.max, windowLabel, standing: 'unknown' },
      invalid: false, ledgerMissing: true };
  }
  const cutoff = nowMs - limit.windowMs;
  let used = 0;
  for (const event of Array.isArray(ledger.events) ? ledger.events : []) {
    if (event.backend !== engine) continue;
    const ts = Date.parse(event.ts);
    if (Number.isNaN(ts) || ts < cutoff) continue;
    used += 1;
  }
  return {
    quota: {
      used,
      limit: limit.max,
      windowLabel,
      standing: used >= limit.max ? 'over' : used >= limit.max * 0.8 ? 'warn' : 'ok',
    },
    invalid: false,
    ledgerMissing: false,
  };
}

/**
 * The fleet daily budget binds metered engines only: subscription seats are
 * flat-fee and never counted toward dailyBudgetUsd, and local-tier engines
 * spend nothing (zero-dollar producers may still run).
 */
function budgetHolds(engine: string, budget: FleetBudget | null | undefined): boolean {
  if (budget?.capReached !== true) return false;
  try {
    if (isSubscriptionEngine(engine as EngineId)) return false;
    return engineTierOf(engine as EngineId) !== 'local';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// resolveLive — the single precedence rule shared by every node kind
// ---------------------------------------------------------------------------

function resolveLive(
  signals: LiveSignals,
  opts: { nowMs: number; warnPercent: number },
): GraphNodeLive {
  const { contributions } = signals;
  const reasons: string[] = [];
  // A "qualified" reading actually measured something: a utilization percent,
  // a provider limit flag, or a non-percent fact (signed out, free runtime).
  // A fresh seat row whose windows all report no signal is unqualified — it
  // proves the collector ran, not that headroom exists.
  const qualified = contributions.filter(
    (c) => c.fresh && (c.usedPercent !== null || c.limitReached || c.forceState !== undefined),
  );
  const dated = contributions.filter((c) => c.ageMs !== null);
  const staleReadings = dated.filter((c) => !c.fresh);
  const quotaKnown = signals.quota !== null && signals.quota.standing !== 'unknown';
  const verdictDenied = signals.verdict !== undefined && !signals.verdict.allowed;
  const hasFreshEvidence = qualified.length > 0 || quotaKnown || signals.verdict !== undefined;
  const heldForced = contributions.some((c) => c.forceState === 'held');
  // An age-unknown saturation report remains a conservative blocking signal,
  // but is not a fresh measurement and cannot establish headroom or an age.
  const saturated = contributions.filter((c) =>
    (c.fresh || c.ageMs === null) && (c.limitReached || c.usedPercent === 100));

  const measured = qualified.filter((c) => c.usedPercent !== null || c.limitReached);
  const usedPercent = measured.length === 0
    ? null
    : measured.reduce((m, c) => Math.max(m, c.limitReached ? 100 : c.usedPercent ?? 0), 0);
  const resets = contributions
    .map((c) => c.resetsAtMs)
    .filter((t): t is number => t !== null && t > opts.nowMs);
  const resetsAtMs = resets.length === 0 ? null : Math.min(...resets);
  const spends = contributions.map((c) => c.spentTodayUsd).filter((s): s is number => s !== null);
  const spentTodayUsd = spends.length === 0 ? null : spends.reduce((a, b) => a + b, 0);
  const ages = dated.map((c) => c.ageMs!);
  const readingAgeMs = ages.length === 0 ? null : Math.min(...ages);
  const stale = staleReadings.length > 0 && !hasFreshEvidence;

  for (const c of contributions) {
    if (c.forceState === 'held') reasons.push(`${c.label} reports signed out or unreachable`);
    else if ((c.fresh || c.ageMs === null) && c.limitReached) reasons.push(`${c.label}: provider reported the limit reached`);
    else if ((c.fresh || c.ageMs === null) && c.usedPercent === 100) reasons.push(`${c.label}: window exhausted`);
    else if (!c.fresh && c.ageMs !== null) reasons.push(`${c.label}: reading stale`);
    if (c.ageMs === null && !c.fresh) reasons.push(`${c.label}: reading undated or timestamp invalid`);
  }
  if (signals.quota?.standing === 'over') {
    reasons.push(`dispatch quota exhausted (${signals.quota.used}/${signals.quota.limit} per ${signals.quota.windowLabel ?? 'window'})`);
  } else if (signals.quota?.standing === 'warn') {
    reasons.push(`dispatch quota near limit (${signals.quota.used}/${signals.quota.limit} per ${signals.quota.windowLabel ?? 'window'})`);
  } else if (signals.quotaInvalid) {
    reasons.push('configured dispatch quota is invalid');
  } else if (signals.quota !== null && signals.quota.standing === 'unknown' && signals.quota.limit !== null) {
    reasons.push('dispatch quota ledger unavailable');
  }
  if (verdictDenied) reasons.push(`gate: ${signals.verdict!.reason}`);
  if (signals.budgetHeld) reasons.push('daily budget cap reached');

  let state: GraphLiveState;
  if (!signals.tracked) {
    state = 'untracked';
    reasons.push('no live signal applies');
  } else if (signals.quota?.standing === 'over' || saturated.length > 0) {
    state = 'exhausted';
  } else if (verdictDenied || signals.quotaInvalid || signals.budgetHeld || heldForced) {
    state = 'held';
  } else if (!hasFreshEvidence && staleReadings.length > 0) {
    state = 'stale';
    reasons.push('every dated reading exceeds the staleness bound');
  } else if (!hasFreshEvidence) {
    state = 'unknown';
    reasons.push('no qualified live reading');
  } else if ((usedPercent ?? 0) >= opts.warnPercent || signals.quota?.standing === 'warn') {
    state = 'limited';
    if (usedPercent !== null && usedPercent >= opts.warnPercent) {
      reasons.push(`window ${Math.round(usedPercent)}% used`);
    }
  } else {
    state = 'ready';
  }

  return {
    state,
    usedPercent,
    quota: signals.quota,
    resetsAtMs,
    spentTodayUsd,
    readingAgeMs,
    stale,
    reasons: dedupeSorted(reasons),
  };
}

function liveUntracked(): GraphNodeLive {
  return { ...UNTRACKED_LIVE, reasons: [...UNTRACKED_LIVE.reasons] };
}

// ---------------------------------------------------------------------------
// joinGraphLive — the pure join
// ---------------------------------------------------------------------------

/**
 * Join live fleet evidence onto a graph.v1 registry. Pure: deterministic in
 * its inputs, no I/O, no mutation. A malformed or incomplete graph yields a
 * degraded projection, never a throw.
 */
export function joinGraphLive(
  graph: RegistryGraph,
  sources: GraphLiveSources,
  options: GraphLiveOptions,
): GraphLiveProjection {
  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : 0;
  const maxAgeMs = Number.isFinite(options.readingMaxAgeMs) && options.readingMaxAgeMs! > 0
    ? options.readingMaxAgeMs!
    : HEADROOM_READING_MAX_AGE_MS;
  const warnPercent = Number.isFinite(options.warnPercent)
    ? Math.max(0, Math.min(100, options.warnPercent!))
    : GRAPH_LIVE_WARN_PERCENT;

  const issues: GraphLiveIssue[] = [];
  const issue = (code: GraphLiveIssueCode, nodeIds: string[] = []): void => {
    if (issues.length >= 128) return;
    if (!issues.some((i) => i.code === code && i.nodeIds.join() === nodeIds.join())) {
      issues.push({ code, nodeIds: [...nodeIds].sort(compareStrings) });
    }
  };

  const empty = (code: GraphLiveIssueCode | null): GraphLiveProjection => ({
    schema: GRAPH_LIVE_SCHEMA, readOnly: true, authority: 'observation-only',
    sampledAtMs: nowMs, complete: false, nodes: [],
    counts: { nodes: 0, byState: { ready: 0, limited: 0, exhausted: 0, held: 0, stale: 0, unknown: 0, untracked: 0 } },
    budget: null, issues: code ? [{ code, nodeIds: [] }] : issues,
  });

  if (graph === null || typeof graph !== 'object' || graph.schema !== 'graph.v1' ||
      !Array.isArray(graph.nodes)) {
    return empty('graph-unavailable');
  }
  const nodes = graph.nodes.filter(
    (n): n is RegistryNode =>
      n !== null && typeof n === 'object' && typeof n.id === 'string' && typeof n.kind === 'string',
  );
  if (!graph.complete) issue('graph-incomplete');
  const edges = (Array.isArray(graph.edges) ? graph.edges : []).filter(
    (e): e is RegistryGraph['edges'][number] =>
      e !== null && typeof e === 'object' &&
      typeof e.kind === 'string' && typeof e.from === 'string' && typeof e.to === 'string',
  );

  const seats = Array.isArray(sources.seats) ? sources.seats : null;
  const seatRows = seats ?? [];
  const seatsById = new Map<string, SeatCapacity>();
  for (const seat of seatRows) {
    if (seat !== null && typeof seat === 'object' && typeof seat.seatId === 'string') {
      seatsById.set(seat.seatId, seat);
    }
  }

  // Engines seen anywhere in the graph (engine-account + model nodes).
  const engines = new Set<string>();
  const accountNodes = new Map<string, Extract<RegistryNode, { kind: 'engine-account' }>>();
  const modelNodes = new Map<string, Extract<RegistryNode, { kind: 'model' }>>();
  const agentNodes = new Map<string, Extract<RegistryNode, { kind: 'agent' }>>();
  for (const node of nodes) {
    if (node.kind === 'engine-account') { accountNodes.set(node.id, node); engines.add(node.engine); }
    else if (node.kind === 'model') { modelNodes.set(node.id, node); engines.add(node.engine); }
    else if (node.kind === 'agent') agentNodes.set(node.id, node);
  }
  for (const key of Object.keys(sources.usage ?? {})) engines.add(key);
  for (const key of Object.keys(sources.verdicts ?? {})) engines.add(key);

  // Per-engine shared signals (subscription window, quota, verdict, budget).
  const shared = new Map<string, { signals: LiveSignals; engineSubscription: boolean }>();
  const engineNodeIds = (engine: string): string[] => nodes
    .filter((n) => (n.kind === 'engine-account' || n.kind === 'model') && n.engine === engine)
    .map((n) => n.id);
  let anySubscriptionEngine = false;
  for (const engine of engines) {
    let subscription = false;
    try { subscription = isSubscriptionEngine(engine as EngineId); } catch { /* keep false */ }
    anySubscriptionEngine ||= subscription;
    const usageInput = sources.usage?.[engine];
    const usageGiven = usageInput !== undefined;
    const verdict = sources.verdicts?.[engine];
    const qs = quotaSignal(engine, sources.cfg, sources.quota, nowMs);
    const nodeIds = engineNodeIds(engine);
    if (qs.invalid && nodeIds.length > 0) issue('quota-limit-invalid', nodeIds);
    if (qs.ledgerMissing && nodeIds.length > 0) issue('quota-ledger-missing', nodeIds);
    const held = budgetHolds(engine, sources.budget);
    const seatRoster = seatRows.filter((s) => s.engine === engine);
    const contributions: Contribution[] = [];
    const usageC = usageContribution(engine, usageInput ?? null, nowMs, maxAgeMs);
    if (usageC) contributions.push(usageC);
    const tracked = subscription || usageGiven || verdict !== undefined ||
      qs.quota !== null || qs.invalid || held || seatRoster.length > 0;
    shared.set(engine, {
      signals: {
        contributions,
        quota: qs.quota,
        quotaInvalid: qs.invalid,
        verdict,
        budgetHeld: held,
        tracked,
      },
      engineSubscription: subscription,
    });
  }

  if (anySubscriptionEngine && seats === null) {
    issue('seats-missing', [...accountNodes.values()]
      .filter((n) => shared.get(n.engine)?.engineSubscription)
      .map((n) => n.id));
  }

  const liveById = new Map<string, GraphNodeLive>();

  // engine-account nodes: shared engine signals + this account's seat rows.
  const unreadSeatNodes: string[] = [];
  for (const node of accountNodes.values()) {
    const entry = shared.get(node.engine)!;
    const contributions = [...entry.signals.contributions];
    const reasonsExtra: string[] = [];
    let unread = false;
    for (const seatId of node.seatIds) {
      const seat = seatsById.get(seatId);
      if (seat === undefined) {
        if (seats !== null && entry.engineSubscription) {
          reasonsExtra.push(`seat ${seatId} has no live reading`);
          unread = true;
        }
        continue;
      }
      contributions.push(seatContribution(seat, nowMs, maxAgeMs));
    }
    if (unread) unreadSeatNodes.push(node.id);
    const signals: LiveSignals = {
      contributions,
      quota: entry.signals.quota,
      quotaInvalid: entry.signals.quotaInvalid,
      verdict: entry.signals.verdict,
      budgetHeld: entry.signals.budgetHeld,
      tracked: entry.signals.tracked || node.seatIds.some((id) => seatsById.has(id)),
    };
    const live = resolveLive(signals, { nowMs, warnPercent });
    live.reasons = dedupeSorted([...live.reasons, ...reasonsExtra]);
    liveById.set(node.id, live);
  }
  if (unreadSeatNodes.length > 0) issue('seat-unread', unreadSeatNodes);

  // model nodes: the best state across the engine accounts that serve them.
  const serving = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'routes-to' || !accountNodes.has(edge.from)) continue;
    const list = serving.get(edge.to) ?? [];
    list.push(edge.from);
    serving.set(edge.to, list);
  }
  for (const node of modelNodes.values()) {
    const servers = (serving.get(node.id) ?? [])
      .map((id) => ({ id, live: liveById.get(id) }))
      .filter((s): s is { id: string; live: GraphNodeLive } => s.live !== undefined)
      .sort((a, b) => STATE_RANK[a.live.state] - STATE_RANK[b.live.state] || compareStrings(a.id, b.id));
    if (servers.length > 0) {
      const best = servers[0]!.live;
      liveById.set(node.id, {
        ...best,
        reasons: dedupeSorted([...best.reasons, `served by ${servers.length} engine account${servers.length === 1 ? '' : 's'}`]),
      });
    } else {
      const live = resolveLive(shared.get(node.engine)!.signals, { nowMs, warnPercent });
      live.reasons = dedupeSorted([...live.reasons, 'no enrolled account lists this model']);
      liveById.set(node.id, live);
    }
  }

  // agent nodes: the worst state across the resources they route to.
  const bindings = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'routes-to' || !agentNodes.has(edge.from)) continue;
    const list = bindings.get(edge.from) ?? [];
    list.push(edge.to);
    bindings.set(edge.from, list);
  }
  for (const node of agentNodes.values()) {
    const bound = (bindings.get(node.id) ?? [])
      .map((id) => ({ id, live: liveById.get(id) }))
      .filter((s): s is { id: string; live: GraphNodeLive } => s.live !== undefined)
      .sort((a, b) => STATE_RANK[b.live.state] - STATE_RANK[a.live.state] || compareStrings(a.id, b.id));
    if (bound.length === 0) {
      liveById.set(node.id, liveUntracked());
      continue;
    }
    const worst = bound[0]!.live;
    liveById.set(node.id, {
      ...worst,
      reasons: dedupeSorted(bound.flatMap((b) => b.live.reasons)),
    });
  }

  const outNodes: GraphLiveNode[] = nodes.map((node) => {
    const live = node.kind === 'mcp' ? liveUntracked() : liveById.get(node.id) ?? liveUntracked();
    return {
      ...node,
      ...(node.kind === 'engine-account' ? { seatIds: [...node.seatIds] } : {}),
      live: { ...live, quota: live.quota === null ? null : { ...live.quota }, reasons: [...live.reasons] },
    };
  });

  const byState: Record<GraphLiveState, number> = {
    ready: 0, limited: 0, exhausted: 0, held: 0, stale: 0, unknown: 0, untracked: 0,
  };
  for (const node of outNodes) byState[node.live.state] += 1;

  issues.sort((a, b) =>
    compareStrings(a.code, b.code) || compareStrings(a.nodeIds.join(), b.nodeIds.join()));

  const budget = sources.budget === null || sources.budget === undefined
    ? null
    : {
        spentTodayUsd: finiteNumber(sources.budget.spentTodayUsd),
        dailyBudgetUsd: finiteNumber(sources.budget.dailyBudgetUsd) ?? 0,
        remainingUsd: finiteNumber(sources.budget.remainingUsd),
        capReached: sources.budget.capReached === true
          ? true
          : sources.budget.capReached === false ? false : null,
      };

  return {
    schema: GRAPH_LIVE_SCHEMA,
    readOnly: true,
    authority: 'observation-only',
    sampledAtMs: nowMs,
    complete: graph.complete === true && issues.length === 0,
    nodes: outNodes,
    counts: { nodes: outNodes.length, byState },
    budget,
    issues,
  };
}

// ---------------------------------------------------------------------------
// readGraphLive — thin never-throw wrapper over the same live readers the
// dispatch gates use. NOT pure: it reads ~/.ashlr state exactly as the gates do.
// ---------------------------------------------------------------------------

export interface ReadGraphLiveOptions {
  nowMs?: number;
  readingMaxAgeMs?: number;
  warnPercent?: number;
  /** Operator config forwarded to the subscription gate and quota caps. */
  cfg?: AshlrConfig;
  /** Source overrides; absent entries are read from the live stores. */
  seats?: readonly SeatCapacity[] | null;
  usage?: GraphLiveSources['usage'];
  verdicts?: GraphLiveSources['verdicts'];
  quota?: GraphLiveSources['quota'];
  budget?: FleetBudget | null;
}

/**
 * Gather live evidence with the same never-throw readers the gates use and
 * join it onto the registry. Snapshot/quota reads follow the fleet's read
 * path (including shared-ledger presence publication for subscriptionUsage).
 * A read failure degrades to the no-source projection, never a throw.
 */
export function readGraphLive(
  graph: RegistryGraph,
  options: ReadGraphLiveOptions = {},
): GraphLiveProjection {
  const nowMs = options.nowMs ?? Date.now();
  try {
    const seats = options.seats === undefined
      ? readCapacitySnapshot()?.seats ?? null
      : options.seats;
    const engines = new Set<string>();
    for (const node of graph?.nodes ?? []) {
      if (node?.kind === 'engine-account' || node?.kind === 'model') engines.add(node.engine);
    }
    const usage: Record<string, GraphLiveUsageInput> = {};
    const verdicts: Record<string, SubscriptionAllowResult> = {};
    for (const engine of engines) {
      if (!isSubscriptionEngine(engine as EngineId)) continue;
      if (options.usage === undefined) {
        usage[engine] = { usage: subscriptionUsage(engine as EngineId), observedAtMs: nowMs };
      }
      if (options.verdicts === undefined) {
        verdicts[engine] = subscriptionAllows(engine as EngineId, {
          cfg: options.cfg,
          nowMs,
          autonomous: true,
        });
      }
    }
    const quota = options.quota === undefined ? loadFleetQuota() : options.quota;
    return joinGraphLive(graph, {
      seats,
      usage: options.usage ?? usage,
      verdicts: options.verdicts ?? verdicts,
      quota,
      cfg: options.cfg ?? null,
      budget: options.budget ?? null,
    }, {
      nowMs,
      readingMaxAgeMs: options.readingMaxAgeMs,
      warnPercent: options.warnPercent,
    });
  } catch {
    try {
      return joinGraphLive(graph, {}, { nowMs });
    } catch {
      return {
        schema: GRAPH_LIVE_SCHEMA,
        readOnly: true,
        authority: 'observation-only',
        sampledAtMs: nowMs,
        complete: false,
        nodes: [],
        counts: { nodes: 0, byState: { ready: 0, limited: 0, exhausted: 0, held: 0, stale: 0, unknown: 0, untracked: 0 } },
        budget: null,
        issues: [{ code: 'graph-unavailable', nodeIds: [] }],
      };
    }
  }
}
