/**
 * Which queue lane may take the next job. Pure: reads a lane-targets snapshot
 * (runs-lane-targets.ts) and usage windows, and answers with one lane plus a
 * plain reason for every lane it skipped. It never writes slots.json, never
 * changes a target, and never touches billing settings.
 *
 * A lane is skipped when:
 *   - the snapshot is not healthy (fail closed: unknown is not permission),
 *   - it is held and the hold has not expired (a hold with no end stays),
 *   - its target is 0, or it already runs its target (no room),
 *   - it is a zero-paid lane (Grok, Cursor) without a fresh flat-rate
 *     reading: paid, credit, stale or missing readings all count as paid,
 *   - the job needs a capability the lane is declared to lack (for example
 *     gh on claude). A gh context pack covers a read-only gh need.
 * A lane whose recent finished jobs mostly ended empty (`verdicts`, "low-yield")
 * is skipped with a plain reason, unless the job names that lane.
 * Yield: when `yields` is given, a row bigger than "sm" prefers lanes whose
 * recent yield for that size is at least 0.5 and that have room; an unknown
 * lane (too few jobs) is neutral and comes next; a known low-yield lane comes
 * last. A small row keeps the room order. A chosen low-yield lane sets
 * `testOnly`: give it a small, test-only row.
 * A target outside the lane's own floor..ceiling is stale; it is clamped
 * before room is counted, so an old number cannot over-admit a lane.
 */
import { ZERO_PAID_LANES, type ThroughputWindow } from '../daemon/count-preferences.js';
import { laneLacks, routeSkipCode, type CapabilityNeed, type LaneCapabilityOverrides, type RouteSkipCode } from './lane-capabilities.js';
import { laneYieldFor, YIELD_HIGH, type LaneYieldRow } from './lane-yield-weight.js';
import { lowYieldReason, type LaneYieldStats } from './lane-yield-verdict.js';
import type { LaneTargetRow, LaneTargetsV1 } from './runs-lane-targets.js';

export type LaneSkipKind = 'snapshot' | 'held' | 'no-target' | 'full' | 'paid-unproven' | 'excluded' | 'lacks-capability' | 'low-yield';

/** `code` is set only for `lacks-capability`, e.g. "route_skip: lane lacks gh". */
export interface LaneSkip { lane: string; kind: LaneSkipKind; reason: string; code?: RouteSkipCode }

export interface LaneRouteInput {
  targets: LaneTargetsV1;
  /** Running jobs per lane. Missing means 0. */
  live?: Readonly<Record<string, number>>;
  /** Usage readings. Only a fresh window with `paid === false` clears a zero-paid lane. */
  windows?: readonly ThroughputWindow[];
  /** Lanes the caller already rules out (e.g. the lane a job just failed on). */
  exclude?: readonly string[];
  /** Tie-break order when lanes have equal room; unlisted lanes follow alphabetically. */
  prefer?: readonly string[];
  /** What the job needs (inferRequiredCapabilities). A lane declared to lack one is skipped. */
  needs?: readonly CapabilityNeed[];
  /** A gh context pack is attached, which covers read-only gh needs. */
  pack?: boolean;
  capabilities?: LaneCapabilityOverrides;
  now?: Date;
  /** Size of the row being routed ("sm", "md", ...); absent counts as small and reads each lane's overall yield. */
  size?: string;
  /** Recent yield rows (computeLaneYield). Absent means every lane is neutral. */
  yields?: readonly LaneYieldRow[];
  /** Per-lane finished-job stats (laneYield). A "low-yield" lane is skipped unless it is `named`. */
  verdicts?: Readonly<Record<string, LaneYieldStats>>;
  /** The lane the job explicitly asks for; it is never skipped as low-yield. */
  named?: string;
}

export interface LaneRouteDecision {
  lane: string | null;
  skipped: LaneSkip[];
  /** The chosen lane's recent yield is low: give it a small, test-only row. */
  testOnly: boolean;
}

/** A hold counts until its end. No end, or an end we cannot read, keeps it held. */
export function laneHoldActive(row: Pick<LaneTargetRow, 'held' | 'heldUntil'>, now: Date): boolean {
  if (!row.held) return false;
  if (row.heldUntil === null) return true;
  const until = Date.parse(row.heldUntil);
  return !Number.isFinite(until) || until > now.getTime();
}

/** The target after clamping to the lane's own bounds. */
export function effectiveLaneTarget(row: Pick<LaneTargetRow, 'target' | 'floor' | 'ceiling'>): number {
  return Math.max(row.floor, Math.min(row.ceiling ?? Number.POSITIVE_INFINITY, row.target));
}

function paidProven(lane: string, windows: readonly ThroughputWindow[]): boolean {
  return windows.some((w) => w.lane === lane && w.status === 'fresh' && w.paid === false);
}

export function routeToEligibleLane(input: LaneRouteInput): LaneRouteDecision {
  const now = input.now ?? new Date();
  const skipped: LaneSkip[] = [];
  if (input.targets.sourceState !== 'healthy') {
    return { lane: null, skipped: [{ lane: '*', kind: 'snapshot', reason: `Lane targets are ${input.targets.sourceState}, so no lane is chosen.` }], testOnly: false };
  }
  const prefer = input.prefer ?? [];
  const rank = (lane: string): number => { const i = prefer.indexOf(lane); return i < 0 ? prefer.length : i; };
  const open: Array<{ lane: string; room: number }> = [];
  for (const row of input.targets.lanes) {
    const skip = (kind: LaneSkipKind, reason: string): void => { skipped.push({ lane: row.lane, kind, reason }); };
    if (input.exclude?.includes(row.lane)) { skip('excluded', 'The caller ruled this lane out.'); continue; }
    const stats = input.verdicts?.[row.lane];
    if (stats?.verdict === 'low-yield' && input.named !== row.lane) { skip('low-yield', lowYieldReason(row.lane, stats)); continue; }
    const lacks = input.needs?.length ? laneLacks(row.lane, input.needs, input.pack === true, input.capabilities) : null;
    if (lacks) { skipped.push({ lane: row.lane, kind: 'lacks-capability', code: routeSkipCode(lacks), reason: `Lane cannot use ${lacks}.` }); continue; }
    if (laneHoldActive(row, now)) { skip('held', `Lane is held${row.heldReason ? `: ${row.heldReason}` : ''}.`); continue; }
    if (ZERO_PAID_LANES.has(row.lane) && !paidProven(row.lane, input.windows ?? [])) {
      skip('paid-unproven', 'No fresh flat-rate reading, so this zero-paid lane is treated as paid.');
      continue;
    }
    const target = effectiveLaneTarget(row);
    if (target <= 0) { skip('no-target', 'Lane target is 0.'); continue; }
    const room = target - Math.max(0, input.live?.[row.lane] ?? 0);
    if (room <= 0) { skip('full', `Lane already runs its target of ${target}.`); continue; }
    open.push({ lane: row.lane, room });
  }
  const size = input.size ?? 'sm';
  const rowSize = input.size ?? 'all';
  const grade = (lane: string): 'high' | 'neutral' | 'low' => {
    const found = laneYieldFor(input.yields, lane, rowSize);
    return !found || !found.known || found.yield === null ? 'neutral' : found.yield >= YIELD_HIGH ? 'high' : 'low';
  };
  const tier = (lane: string): number => size === 'sm' ? 0 : { high: 0, neutral: 1, low: 2 }[grade(lane)];
  open.sort((a, b) => tier(a.lane) - tier(b.lane) || b.room - a.room || rank(a.lane) - rank(b.lane) || a.lane.localeCompare(b.lane));
  const lane = open[0]?.lane ?? null;
  return { lane, skipped, testOnly: lane !== null && grade(lane) === 'low' };
}
