/**
 * fleet_lanes — one persisted row per fleet lane joining the slot-lane
 * control file (targets and holds), the host-runs projection (running
 * counts) and the resource ledger (usage). Read-only: no reader here mutates
 * a lane, and a failing reader degrades the whole join to an empty list
 * rather than returning a partial picture an agent could plan on.
 *
 * The dispatcher's hold attribution (slots.json held_by) is surfaced through
 * readLaneTargets' changedBy — the newest trailing-ISO attribution across
 * unheld_by / held_by / changed_by. On a held lane it is reported as heldBy:
 * "by whom" the current hold (or the most recent write on a held lane) was
 * recorded. Lanes the ledger synthesizes without a slot row (e.g.
 * codex-personal session observations) carry heldBy null.
 */
import { readLaneTargets, type LaneTargetsV1 } from '../core/fleet/runs-lane-targets.js';
import { readFleetRunsDirState, type FleetRunsDirState } from '../core/fleet/runs-dir-state.js';
import { readResourceLedger, type ResourceLedgerV1 } from '../core/fleet/runs-resource-ledger.js';
import { scrubPrivateText } from '../core/util/scrub.js';

export const MAX_FLEET_LANES = 32;

export type FleetLaneSourceState = 'healthy' | 'missing' | 'degraded';

export interface FleetLaneRow {
  lane: string;
  running: number | null;
  target: number | null;
  held: boolean | null;
  heldBy: string | null;
  heldReason: string | null;
  heldUntil: string | null;
  window: 'weekly' | 'credits' | 'none' | null;
  usedPct: number | null;
  creditsRemaining: number | null;
  resetAt: string | null;
  burnPctPerHour: number | null;
  sourceState: FleetLaneSourceState;
}

export interface FleetLanesV1 {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
  sourceState: FleetLaneSourceState;
  lanes: FleetLaneRow[];
}

export interface FleetLanesDeps {
  /** Slot-lane control read: targets, held, heldReason, heldUntil, attribution. */
  laneTargets?: () => Promise<LaneTargetsV1>;
  /** Host-runs projection: running counts (same status.json the ledger reads). */
  hostRuns?: () => Promise<FleetRunsDirState>;
  /** Resource ledger: usedPct, creditsRemaining, resetAt, burnPctPerHour, window. */
  resourceLedger?: () => Promise<ResourceLedgerV1>;
}

const text = (value: string | null | undefined): string | null =>
  typeof value === 'string' ? scrubPrivateText(value, { emails: true }) : null;

const worst = (states: readonly FleetLaneSourceState[]): FleetLaneSourceState =>
  states.includes('degraded') ? 'degraded' : states.includes('missing') ? 'missing' : 'healthy';

const envelope = (sourceState: FleetLaneSourceState, lanes: FleetLaneRow[], generatedAt: string): FleetLanesV1 =>
  ({ schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none', generatedAt, sourceState, lanes });

export async function readFleetLanes(deps: FleetLanesDeps = {}): Promise<FleetLanesV1> {
  const generatedAt = new Date().toISOString();
  let targets: LaneTargetsV1;
  let runs: FleetRunsDirState;
  let ledger: ResourceLedgerV1;
  try {
    [targets, runs, ledger] = await Promise.all([
      (deps.laneTargets ?? readLaneTargets)(),
      (deps.hostRuns ?? readFleetRunsDirState)(),
      (deps.resourceLedger ?? readResourceLedger)(),
    ]);
  } catch {
    // Source exceptions may carry config values or machine paths; the join
    // reports itself degraded with no rows instead of leaking a stack detail.
    return envelope('degraded', [], generatedAt);
  }
  const ledgerStatus = ledger.sources.status;
  const targetsByLane = new Map(targets.lanes.map(row => [row.lane, row]));
  const runsByLane = new Map(runs.lanes.map(row => [row.lane, row]));
  const ledgerByLane = new Map(ledger.lanes.map(row => [row.lane, row]));
  const names = [...new Set([...targetsByLane.keys(), ...runsByLane.keys(), ...ledgerByLane.keys()])].sort();
  const lanes = names.slice(0, MAX_FLEET_LANES).map(lane => {
    const slot = targetsByLane.get(lane);
    const run = runsByLane.get(lane);
    const budget = ledgerByLane.get(lane);
    const held = slot?.held ?? budget?.held ?? run?.held ?? null;
    const contributing: FleetLaneSourceState[] = [];
    if (slot) contributing.push(targets.sourceState);
    if (run) contributing.push(runs.sourceState);
    if (budget) contributing.push(ledgerStatus);
    return {
      lane: scrubPrivateText(lane, { emails: true }),
      running: run?.running ?? budget?.running ?? null,
      target: slot?.target ?? budget?.target ?? run?.target ?? null,
      held,
      heldBy: held === true ? text(slot?.changedBy) : null,
      heldReason: text(slot?.heldReason ?? run?.heldReason),
      heldUntil: text(slot?.heldUntil),
      window: budget?.window ?? null,
      usedPct: budget?.usedPct ?? null,
      creditsRemaining: budget?.creditsRemaining ?? null,
      resetAt: text(budget?.resetAt),
      burnPctPerHour: budget?.burnPctPerHour ?? null,
      sourceState: worst(contributing),
    };
  });
  return envelope(worst([targets.sourceState, runs.sourceState, ledgerStatus]), lanes, generatedAt);
}
