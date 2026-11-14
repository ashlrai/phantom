/**
 * Read-only `fleet-usage.v1` feed behind GET /api/app/fleet-usage: one row per
 * dispatchd lane, in the exact wire shape the Resources > Lane usage panel
 * parses (src/web-ui/routes/resources/fleet-usage-model.ts).
 *
 * Recut of #3250 (RQ-RESOURCES-1-FEED). That PR re-read queue/status.json and
 * guessed Z.ai / Gemini pacer formats that no producer writes. This version
 * composes the two readers master already trusts instead:
 *   - readResourceLedger: quota readings (status budget, native Claude and
 *     personal Codex observations) with their captured timestamps;
 *   - readFleetRunsDirState: slot counts (running, target, ceiling, queued,
 *     held, held reason).
 *
 * Unknown stays unknown: a percentage is only reported for a weekly window,
 * never for a window whose reset already passed, and a reading without a
 * capture time is flagged stale rather than presented as current. Nothing here
 * writes, shells out or opens the network.
 */
import { readResourceLedger, type ResourceLaneRow, type ResourceLedgerV1 } from '../fleet/runs-resource-ledger.js';
import { readFleetRunsDirState, type FleetRunsDirState, type FleetRunsLane } from '../fleet/runs-dir-state.js';

export const FLEET_USAGE_SCHEMA = 'fleet-usage.v1';
export const VERSE_APP_FLEET_USAGE_PATH = '/api/app/fleet-usage';

/** Mirrors the panel's FleetUsageLane; test/recut-usage-3250.test.ts round-trips it through the panel parser. */
export interface FleetUsageFeedLane {
  lane: string;
  window: 'weekly' | 'credits' | 'none';
  usedPct: number | null;
  resetAt: string | null;
  burnPctPerHour: number | null;
  running: number | null;
  target: number | null;
  ceiling: number | null;
  queued: number | null;
  held: boolean;
  heldReason: string | null;
  /** Age of the quota reading when known, else of the controller tick that reported the lane. */
  sourceAgeSec: number | null;
  stale: boolean;
}
export interface FleetUsageFeedV1 {
  schema: typeof FLEET_USAGE_SCHEMA;
  generatedAt: string;
  lanes: FleetUsageFeedLane[];
}
export interface FleetUsageFeedOptions {
  runsDir?: string;
  now?: () => number;
  personalCodexHome?: string;
}

const ageSec = (at: string | null | undefined, now: number): number | null => {
  const ms = at ? Date.parse(at) : NaN;
  return Number.isFinite(ms) && ms <= now ? Math.round((now - ms) / 1000) : null;
};

function feedLane(lane: string, row: ResourceLaneRow | undefined, slots: FleetRunsLane | undefined, tickAt: string | null, now: number): FleetUsageFeedLane {
  const evidence = row?.quotaEvidence;
  const resetMs = row?.resetAt ? Date.parse(row.resetAt) : NaN;
  const resetPassed = evidence?.reason === 'reset-passed' || (Number.isFinite(resetMs) && resetMs <= now);
  // Credits rows carry dollars, not a percentage; an expired window's counter belongs to the old window.
  const usedPct = row?.window === 'weekly' && row.usedPct !== null && row.usedPct <= 100 && !resetPassed ? row.usedPct : null;
  const observedAt = evidence?.measuredQuota?.observedAt ?? row?.observation?.asOf ?? evidence?.statusQuota?.observedAt ?? null;
  return {
    lane,
    window: row?.window ?? 'none',
    usedPct,
    resetAt: resetPassed ? null : row?.resetAt ?? null,
    burnPctPerHour: usedPct === null ? null : row?.burnPctPerHour ?? null,
    running: slots?.running ?? row?.running ?? null,
    target: slots?.target ?? row?.target ?? null,
    ceiling: slots?.ceiling ?? null,
    queued: slots?.queued ?? null,
    held: slots?.held ?? row?.held ?? false,
    heldReason: slots?.heldReason ?? null,
    sourceAgeSec: usedPct === null ? ageSec(tickAt, now) : ageSec(observedAt, now),
    stale: usedPct !== null && (observedAt === null || evidence?.state === 'refresh-needed'),
  };
}

/** Pure projection; exported so the mapping is testable without a runs directory. */
export function buildFleetUsageFeed(ledger: ResourceLedgerV1, runs: FleetRunsDirState, now: number): FleetUsageFeedV1 {
  const rows = new Map(ledger.lanes.map(row => [row.lane, row]));
  const slots = new Map(runs.lanes.map(lane => [lane.lane, lane]));
  const tickAt = runs.lastTick ?? ledger.asOf;
  const lanes = [...new Set([...slots.keys(), ...rows.keys()])].sort()
    .map(lane => feedLane(lane, rows.get(lane), slots.get(lane), tickAt, now));
  return { schema: FLEET_USAGE_SCHEMA, generatedAt: new Date(now).toISOString(), lanes };
}

/** Never throws for missing or malformed sources: both readers degrade to empty lanes. */
export async function readFleetUsageFeed(opts: FleetUsageFeedOptions = {}): Promise<FleetUsageFeedV1> {
  const at = (opts.now ?? Date.now)();
  const now = () => at;
  const [ledger, runs] = await Promise.all([
    readResourceLedger({ runsDir: opts.runsDir, now, personalCodexHome: opts.personalCodexHome }),
    readFleetRunsDirState({ runsDir: opts.runsDir, now }),
  ]);
  return buildFleetUsageFeed(ledger, runs, at);
}
