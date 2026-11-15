/**
 * core/fleet/autopilot.ts — one bounded fleet autopilot planning cycle
 * (RQ-SWE3-AUTOPILOT-1). Reads queue/slots/admission state, computes lane
 * utilization against targets, picks the single highest-leverage gap and
 * emits exactly one proposed action. READ-ONLY: this module never writes,
 * launches, holds or merges anything; the proposal is advisory for the
 * leader loop to review. `phm fleet autopilot --once --json` is the verb.
 *
 * Sources, all local and bounded: queue/status.json (admission + per-lane
 * running/target/queued/held via explainFleetAdmission), queue/ready.tsv
 * plus metrics/jobs.jsonl (ready/parked supply and parked dependency rows
 * via readFleetQueue with depDetail), and queue/slots.json (lane targets,
 * floors, ceilings and holds via readLaneTargets). An optional --repo pass
 * adds the read-only `gh pr list` rebase-coverage read so uncovered
 * conflicting bridge PRs can outrank local gaps; without --repo that gap
 * class is simply unmeasured, never guessed.
 *
 * Gap severity order (highest leverage first): uncovered-conflicts
 * (finished work blocked at the last mile), starved-lane (queued work that
 * cannot get slots), stale-parked-deps (met gates never unparked), then
 * missing-restock (free slots with no ready supply). The planner emits the
 * full ranked gap list plus exactly one action for the top gap — even when
 * the honest answer is no-op (capacity-bound, dispatch-stall).
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { explainFleetAdmission, type FleetAdmissionReport } from '../../cli/fleet-admission.js';
import { readFleetQueue, type FleetQueueV1, type Source } from './runs-parked-queue.js';
import { readLaneTargets, type LaneTargetsV1 } from './runs-lane-targets.js';
import { readRebaseStatus } from './rebase-status.js';

export const FLEET_AUTOPILOT_SCHEMA = 'fleet.autopilot.v1';
/** A lane is over-deep (holdable at the cap) when its READY depth exceeds target × this factor. */
export const AUTOPILOT_OVER_DEEP_FACTOR = 3;
/** Proposed rebase jobs per cycle are capped so a huge backlog stays reviewable. */
export const AUTOPILOT_MAX_PROPOSED = 20;

export type RebaseSource = 'unconfigured' | 'ok' | 'partial' | 'degraded';
export interface AutopilotSources { status: Source; queue: Source; slots: Source; rebase: RebaseSource }

/** Per-repo rebase coverage, reduced from readRebaseStatus to what the planner needs. */
export interface AutopilotRebaseRepo {
  repo: string;
  source: 'ok' | 'truncated' | 'unavailable';
  /** Open conflicting bridge PRs; null when the repo read was unavailable. */
  conflicting: number | null;
  /** Conflicting PRs with no rebase job for the current head — enqueue this many. */
  uncovered: number | null;
  /** Conflicting PRs whose only rebase jobs target a stale head — rebase is due again. */
  staleHeadOnly: number | null;
}

export interface FleetAutopilotState {
  generatedAt: string;
  sources: AutopilotSources;
  admission: FleetAdmissionReport | null;
  queue: FleetQueueV1 | null;
  slots: LaneTargetsV1 | null;
  /** Null when no --repo was passed. */
  rebase: AutopilotRebaseRepo[] | null;
}

export interface AutopilotReadDeps {
  /** Returns queue/status.json text; rejects ENOENT for a missing file. */
  statusText?: (path: string) => Promise<string>;
  queue?: (opts: { runsDir: string; depDetail: boolean }) => Promise<FleetQueueV1>;
  slots?: (opts: { runsDir: string }) => Promise<LaneTargetsV1>;
  rebase?: typeof readRebaseStatus;
  now?: () => Date;
}

/** Assemble every local input; each source degrades independently, never throws. */
export async function readFleetAutopilotState(
  opts: { runsDir?: string; repos?: string[] } & AutopilotReadDeps = {},
): Promise<FleetAutopilotState> {
  const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
  const now = opts.now ?? (() => new Date());
  const [status, queue, slots, rebase] = await Promise.all([
    (async (): Promise<{ source: Source; report: FleetAdmissionReport | null }> => {
      try {
        const text = await (opts.statusText ?? ((path) => readFile(path, 'utf8')))(join(runsDir, 'queue', 'status.json'));
        return { source: 'healthy', report: explainFleetAdmission(JSON.parse(text)) };
      } catch (error) {
        return { source: (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'missing' : 'degraded', report: null };
      }
    })(),
    (opts.queue ?? ((o) => readFleetQueue(o)))({ runsDir, depDetail: true })
      // The planner consumes the ready/parked supply; the precheck-skip tail is
      // auxiliary and never downgrades the queue source here.
      .then((view): { source: Source; view: FleetQueueV1 | null } => ({
        source: view.sources.ready, view,
      }))
      .catch((): { source: Source; view: FleetQueueV1 | null } => ({ source: 'degraded', view: null })),
    (opts.slots ?? ((o) => readLaneTargets(o)))({ runsDir })
      .then((view): { source: Source; view: LaneTargetsV1 } => ({ source: view.sourceState, view }))
      .catch((): { source: Source; view: LaneTargetsV1 | null } => ({ source: 'degraded', view: null })),
    (async (): Promise<{ source: RebaseSource; repos: AutopilotRebaseRepo[] | null }> => {
      const repos = opts.repos ?? [];
      if (repos.length === 0) return { source: 'unconfigured', repos: null };
      try {
        const report = await (opts.rebase ?? readRebaseStatus)(repos, runsDir, now());
        const rows: AutopilotRebaseRepo[] = report.repos.map((row) => ({
          repo: row.repo,
          source: row.source === 'ok' || row.source === 'truncated' ? row.source : 'unavailable',
          conflicting: row.summary?.conflicting ?? null,
          uncovered: row.summary === null ? null : (row.summary.coverage?.uncovered ?? null),
          staleHeadOnly: row.summary === null ? null : (row.summary.coverage?.staleHeadOnly ?? null),
        }));
        const ok = rows.filter((row) => row.source === 'ok').length;
        return { source: ok === rows.length ? 'ok' : ok === 0 ? 'degraded' : 'partial', repos: rows };
      } catch {
        return { source: 'degraded', repos: null };
      }
    })(),
  ]);
  return {
    generatedAt: now().toISOString(),
    sources: { status: status.source, queue: queue.source, slots: slots.source, rebase: rebase.source },
    admission: status.report, queue: queue.view, slots: slots.view, rebase: rebase.repos,
  };
}

// ---------------------------------------------------------------------------
// Planner — pure, no I/O, no clock.
// ---------------------------------------------------------------------------

export type AutopilotGapKind = 'uncovered-conflicts' | 'starved-lane' | 'stale-parked-deps' | 'missing-restock';
/** Leverage order between equal severities: finished work blocked, then idle capacity, stale parks, then supply. */
const GAP_KIND_ORDER: Record<AutopilotGapKind, number> = {
  'uncovered-conflicts': 0, 'starved-lane': 1, 'stale-parked-deps': 2, 'missing-restock': 3,
};
export type AutopilotNoopReason = 'fleet-healthy' | 'capacity-bound' | 'dispatch-stall' | 'state-unreadable';
export type AutopilotEnqueueType = 'rebase' | 'restock' | 'unpark';

export interface AutopilotGap {
  kind: AutopilotGapKind;
  lane: string | null;
  severity: number;
  detail: string;
  /** Bounded, path-free evidence for the proposal reviewer. */
  evidence: Record<string, unknown>;
}

export type AutopilotAction =
  | { kind: 'enqueue'; type: AutopilotEnqueueType; count: number; lane: string | null; repos?: string[]; detail: string }
  | { kind: 'hold-lane'; lane: string; detail: string }
  | { kind: 'no-op'; reason: AutopilotNoopReason; detail: string };

export interface AutopilotLane {
  lane: string;
  running: number | null;
  target: number | null;
  /** queued as reported by status.json (may include parked rows). */
  queued: number | null;
  /** Launchable READY rows from ready.tsv; null when the queue read is not healthy. */
  ready: number | null;
  parked: number | null;
  /** Dependency-parked rows still waiting on merges, when measured. */
  depWaiting: number | null;
  held: boolean;
  /** target - running when both are known and the lane is not held; null otherwise. */
  freeSlots: number | null;
  /** running / target when both are known and target > 0; null otherwise. */
  utilization: number | null;
  /** Admission reason from status.json, when the lane has a row there. */
  reason: string | null;
}

export interface AutopilotReport {
  schema: typeof FLEET_AUTOPILOT_SCHEMA;
  readOnly: true;
  /** ok when every measured source is healthy; degraded when some read is partial; unreadable when nothing local was usable. */
  status: 'ok' | 'degraded' | 'unreadable';
  generatedAt: string;
  sources: AutopilotSources;
  global: { cap: number | null; running: number | null; atCap: boolean | null; admitReason: string | null };
  lanes: AutopilotLane[];
  /** Every measured gap, highest severity first. */
  gaps: AutopilotGap[];
  /** The single highest-leverage gap the action answers; null on a healthy or unreadable fleet. */
  topGap: AutopilotGap | null;
  action: AutopilotAction;
}

/** Lane ids are untrusted queue/status text: bound length and strip control characters. */
function cleanLane(value: string): string {
  return Array.from(value.slice(0, 64), (char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029 ? ' ' : char;
  }).join('').trim();
}

/** Lane utilization joined across admission (status.json), the ready queue and slots.json. */
export function autopilotLanes(state: FleetAutopilotState): AutopilotLane[] {
  const queueOk = state.queue !== null && state.sources.queue === 'healthy';
  const readyByLane = new Map((state.queue?.byLane ?? []).map((row) => [row.lane, row]));
  const depWaiting = new Map<string, number>();
  for (const row of state.queue?.unmetDeps ?? []) {
    const lane = row.lane ?? '';
    depWaiting.set(lane, (depWaiting.get(lane) ?? 0) + 1);
  }
  const holds = new Map((state.slots?.lanes ?? []).map((row) => [row.lane, row.held || row.heldReason !== null]));
  const names = new Set<string>([
    ...(state.admission?.lanes ?? []).map((row) => row.lane),
    ...(state.slots?.lanes ?? []).map((row) => row.lane),
    ...(state.queue?.byLane ?? []).map((row) => row.lane),
  ]);
  return [...names].sort((a, b) => a.localeCompare(b)).map((raw): AutopilotLane => {
    const lane = cleanLane(raw) || raw;
    const admit = state.admission?.lanes.find((row) => row.lane === lane) ?? null;
    const queuedRow = queueOk ? readyByLane.get(raw) ?? null : null;
    const running = admit?.running ?? null;
    const target = admit?.target ?? state.slots?.lanes.find((row) => row.lane === lane)?.target ?? null;
    const held = admit?.held ?? holds.get(raw) ?? holds.get(lane) ?? false;
    const free = held || running === null || target === null ? null : Math.max(0, target - running);
    return {
      lane,
      running, target,
      queued: admit?.queued ?? null,
      ready: queuedRow?.ready ?? (queueOk ? 0 : null),
      parked: queuedRow?.parked ?? (queueOk ? 0 : null),
      depWaiting: depWaiting.get(raw) ?? depWaiting.get(lane) ?? (queueOk ? 0 : null),
      held, freeSlots: free,
      utilization: running !== null && target !== null && target > 0 ? running / target : null,
      reason: admit?.reason ?? null,
    };
  });
}

function starvedAction(lane: AutopilotLane, lanes: AutopilotLane[], atCap: boolean): AutopilotAction {
  if (atCap) {
    // Free the cap for the starved lane: hold the running lane whose READY
    // depth can most afford a pause (over-deep queues outlive one pause).
    const holdable = lanes
      .filter((row) => row.lane !== lane.lane && !row.held && (row.running ?? 0) > 0 &&
        (row.target ?? 0) > 0 && (row.ready ?? 0) > (row.target ?? 0) * AUTOPILOT_OVER_DEEP_FACTOR)
      .sort((a, b) => (b.ready ?? 0) / (b.target || 1) - (a.ready ?? 0) / (a.target || 1) || a.lane.localeCompare(b.lane));
    if (holdable.length > 0) {
      const target = holdable[0]!;
      return {
        kind: 'hold-lane', lane: target.lane,
        detail: `Hold '${target.lane}' (ready ${target.ready} > ${AUTOPILOT_OVER_DEEP_FACTOR}x target ${target.target}) so '${lane.lane}' queued work can reach the freed cap.`,
      };
    }
    return { kind: 'no-op', reason: 'capacity-bound', detail: `'${lane.lane}' has queued work under target but the global cap is full; no over-deep lane is safe to hold.` };
  }
  return { kind: 'no-op', reason: 'dispatch-stall', detail: `'${lane.lane}' has launchable work and free slots under the cap but is not running to target — the dispatcher should be launching.` };
}

/** One planning cycle over an assembled state. Deterministic; never throws on partial input. */
export function planFleetAutopilot(state: FleetAutopilotState): AutopilotReport {
  const gaps: AutopilotGap[] = [];
  const lanes = autopilotLanes(state);
  const admission = state.admission;
  const atCap = admission?.global.at_cap ?? null;

  // uncovered-conflicts: conflicting bridge PRs with no current rebase job.
  for (const repo of state.rebase ?? []) {
    if (repo.uncovered === null && repo.staleHeadOnly === null) continue;
    const due = (repo.uncovered ?? 0) + (repo.staleHeadOnly ?? 0);
    if (due <= 0) continue;
    gaps.push({
      kind: 'uncovered-conflicts', lane: null,
      severity: 90 + Math.min(due, 10),
      detail: `${repo.repo}: ${due} conflicting bridge PR${due === 1 ? '' : 's'} with no current rebase job (of ${repo.conflicting ?? due} conflicting).`,
      evidence: { repo: repo.repo, conflicting: repo.conflicting, uncovered: repo.uncovered, staleHeadOnly: repo.staleHeadOnly, source: repo.source },
    });
  }

  // starved-lane: launchable work queued while running under target (not held).
  for (const lane of lanes) {
    const waiting = lane.ready ?? lane.queued;
    if (lane.held || lane.running === null || lane.target === null || lane.running >= lane.target || !waiting || waiting <= 0) continue;
    gaps.push({
      kind: 'starved-lane', lane: lane.lane,
      severity: 80 + Math.min(waiting, 15) + (lane.running === 0 ? 5 : 0),
      detail: `'${lane.lane}' runs ${lane.running} of target ${lane.target} with ${waiting} launchable job${waiting === 1 ? '' : 's'} waiting${atCap ? ' while the fleet sits at the cap' : ' under the cap'}.`,
      evidence: { running: lane.running, target: lane.target, waiting, ready: lane.ready, queued: lane.queued, atCap },
    });
  }

  // stale-parked-deps: PARKED-DEP rows whose gate ids all merged but were never unparked.
  const met = state.queue?.metDeps ?? [];
  if (met.length > 0) {
    const byLane = new Map<string, number>();
    for (const row of met) byLane.set(row.lane ?? '', (byLane.get(row.lane ?? '') ?? 0) + 1);
    const modal = [...byLane.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    gaps.push({
      kind: 'stale-parked-deps', lane: modal[0] || null,
      severity: 60 + Math.min(met.length, 10),
      detail: `${met.length} parked DEP row${met.length === 1 ? '' : 's'} (${met.slice(0, 3).map((row) => row.job).join(', ')}${met.length > 3 ? ', …' : ''}) ${met.length === 1 ? 'has' : 'have'} all gates merged but ${met.length === 1 ? 'was' : 'were'} never unparked.`,
      evidence: { count: met.length, jobs: met.slice(0, 10).map((row) => row.job), byLane: Object.fromEntries(byLane) },
    });
  }

  // missing-restock: free slots with no launchable supply at all.
  for (const lane of lanes) {
    const waiting = lane.ready ?? lane.queued;
    if (lane.held || lane.freeSlots === null || lane.freeSlots <= 0 || waiting === null || waiting > 0) continue;
    gaps.push({
      kind: 'missing-restock', lane: lane.lane,
      severity: 50 + Math.min(lane.freeSlots * 2, 20),
      detail: `'${lane.lane}' has ${lane.freeSlots} free slot${lane.freeSlots === 1 ? '' : 's'} and no launchable work queued.`,
      evidence: { freeSlots: lane.freeSlots, running: lane.running, target: lane.target, parked: lane.parked, depWaiting: lane.depWaiting },
    });
  }

  gaps.sort((a, b) => b.severity - a.severity || GAP_KIND_ORDER[a.kind] - GAP_KIND_ORDER[b.kind] || (a.lane ?? '').localeCompare(b.lane ?? ''));
  const topGap = gaps[0] ?? null;

  const localUsable = admission !== null || state.sources.queue === 'healthy' || state.sources.slots === 'healthy';
  let action: AutopilotAction;
  if (!localUsable) {
    action = { kind: 'no-op', reason: 'state-unreadable', detail: 'No local queue, slots or admission source was readable; nothing safe to propose.' };
  } else if (topGap === null) {
    action = { kind: 'no-op', reason: 'fleet-healthy', detail: 'No gap measured: every lane is held, at target, or fed to its queue.' };
  } else {
    switch (topGap.kind) {
      case 'uncovered-conflicts': {
        const due = Math.min((topGap.evidence.uncovered as number ?? 0) + (topGap.evidence.staleHeadOnly as number ?? 0), AUTOPILOT_MAX_PROPOSED);
        action = {
          kind: 'enqueue', type: 'rebase', count: due, lane: null, repos: [topGap.evidence.repo as string],
          detail: `Enqueue ${due} rebase job${due === 1 ? '' : 's'} for ${topGap.evidence.repo}: conflicting bridge PRs have no current rebase coverage.`,
        };
        break;
      }
      case 'starved-lane':
        action = starvedAction(lanes.find((row) => row.lane === topGap.lane)!, lanes, atCap === true);
        break;
      case 'stale-parked-deps':
        action = {
          kind: 'enqueue', type: 'unpark', count: met.length, lane: topGap.lane,
          detail: `Enqueue an unpark sweep: ${met.length} parked DEP row${met.length === 1 ? ' sits' : 's sit'} stale with every gate merged.`,
        };
        break;
      case 'missing-restock': {
        const lane = lanes.find((row) => row.lane === topGap.lane)!;
        action = {
          kind: 'enqueue', type: 'restock', count: lane.freeSlots ?? 1, lane: lane.lane,
          detail: `Enqueue ${lane.freeSlots} restock job${lane.freeSlots === 1 ? '' : 's'} for '${lane.lane}': free slots but an empty ready queue.`,
        };
        break;
      }
    }
  }

  const degraded = !localUsable ? false
    : [state.sources.status, state.sources.queue, state.sources.slots].some((source) => source !== 'healthy')
      || ['degraded', 'partial'].includes(state.sources.rebase);
  return {
    schema: FLEET_AUTOPILOT_SCHEMA,
    readOnly: true,
    status: !localUsable ? 'unreadable' : degraded ? 'degraded' : 'ok',
    generatedAt: state.generatedAt,
    sources: state.sources,
    global: {
      cap: admission?.global.cap ?? null,
      running: admission?.global.running ?? null,
      atCap: admission?.global.at_cap ?? null,
      admitReason: admission?.global.admit_reason ?? null,
    },
    lanes,
    gaps,
    topGap,
    action,
  };
}
