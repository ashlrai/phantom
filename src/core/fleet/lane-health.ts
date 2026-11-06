/**
 * Lane health: the four numbers every lane card shows (calls, error rate,
 * latency, deployed commit) over one stated window, plus a "stuck" verdict
 * with phase age for runs past their phase timeout.
 *
 * Pure and browser-safe: `phm lanes health --json` and the Fleet screen both
 * derive it from the same FleetLiveSnapshotV1, so they cannot disagree. A
 * figure that cannot be measured is `null` (shown as "unknown"), never 0.
 */
import type { FleetEngine, FleetLiveRun, FleetLiveSnapshotV1, FleetPhase } from './fleet-types.js';

export const LANE_HEALTH_SCHEMA = 'lanes.health.v1';
/** The snapshot keeps live runs plus the last 12 h; the window never claims more. */
export const LANE_HEALTH_WINDOW_HOURS = 12;

const MINUTE_MS = 60_000;

/**
 * How long a run may sit in one phase before it is called stuck. `watching`
 * and `parked` wait on the world by design, so they have no timeout (null).
 */
export const PHASE_TIMEOUT_MS: Readonly<Record<FleetPhase, number | null>> = {
  queued: 30 * MINUTE_MS,
  parked: null,
  producing: 45 * MINUTE_MS,
  verifying: 20 * MINUTE_MS,
  judging: 10 * MINUTE_MS,
  landing: 10 * MINUTE_MS,
  watching: null,
  reverting: 10 * MINUTE_MS,
};

export interface StuckRun {
  runId: string;
  repo: string;
  phase: FleetPhase;
  /** How long the run has been in `phase`. */
  phaseAgeMs: number;
  timeoutMs: number;
}

export interface LaneHealth {
  lane: FleetEngine;
  /** Runs started in the window. */
  calls: number;
  /** failed ÷ finished, 0..1; null until a run in the window has finished. */
  errorRate: number | null;
  /** Start-to-end of finished runs, in ms; null until one has finished. */
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Commit of the build that is running the fleet; null = unknown. */
  commit: string | null;
  stuck: StuckRun[];
}

export interface LaneHealthV1 {
  schema: typeof LANE_HEALTH_SCHEMA;
  generatedAt: string;
  window: { hours: number; since: string; until: string };
  commit: string | null;
  lanes: LaneHealth[];
}

function percentile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
}

function ms(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** The run's stuck verdict, or null. A run with no readable phase start is not judged. */
export function stuckRun(run: FleetLiveRun, nowMs: number): StuckRun | null {
  const timeoutMs = PHASE_TIMEOUT_MS[run.phase];
  if (run.endedAt || timeoutMs === null) return null;
  const since = ms(run.phaseStartedAt) ?? ms(run.startedAt);
  if (since === null) return null;
  const phaseAgeMs = Math.max(0, nowMs - since);
  return phaseAgeMs > timeoutMs ? { runId: run.id, repo: run.repo, phase: run.phase, phaseAgeMs, timeoutMs } : null;
}

export function computeLaneHealth(live: FleetLiveSnapshotV1, nowMs: number = Date.parse(live.generatedAt)): LaneHealthV1 {
  const untilMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const sinceMs = untilMs - LANE_HEALTH_WINDOW_HOURS * 3_600_000;
  const commit = live.commit ?? null;
  const lanes = live.lanes.map((state): LaneHealth => {
    const runs = live.runs.filter((r) => r.lane === state.lane);
    const inWindow = runs.filter((r) => {
      const started = ms(r.startedAt);
      return started !== null && started >= sinceMs;
    });
    const finished = inWindow.filter((r) => r.outcome !== null && r.endedAt !== null);
    const latencies = finished
      .map((r) => ms(r.endedAt)! - ms(r.startedAt)!)
      .filter((d) => d >= 0)
      .sort((a, b) => a - b);
    const failed = finished.filter((r) => r.outcome === 'failed').length;
    return {
      lane: state.lane,
      calls: inWindow.length,
      errorRate: finished.length === 0 ? null : failed / finished.length,
      latencyP50Ms: percentile(latencies, 0.5),
      latencyP95Ms: percentile(latencies, 0.95),
      commit,
      stuck: runs.flatMap((r) => stuckRun(r, untilMs) ?? []),
    };
  });
  return {
    schema: LANE_HEALTH_SCHEMA,
    generatedAt: live.generatedAt,
    window: { hours: LANE_HEALTH_WINDOW_HOURS, since: new Date(sinceMs).toISOString(), until: new Date(untilMs).toISOString() },
    commit,
    lanes,
  };
}

/** "47m", "2h 5m", "30s" — a duration a person reads at a glance. */
export function formatAge(msValue: number): string {
  const s = Math.round(msValue / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** The four numbers as plain text; unknown stays "unknown". */
export function laneHealthLine(h: LaneHealth): string {
  const err = h.errorRate === null ? 'unknown' : `${Math.round(h.errorRate * 100)}%`;
  const lat = h.latencyP50Ms === null ? 'unknown' : formatAge(h.latencyP50Ms);
  return `${h.calls} ${h.calls === 1 ? 'call' : 'calls'} · ${err} errors · ${lat} p50 · commit ${h.commit ?? 'unknown'}`;
}

export function stuckBadge(h: LaneHealth): string | null {
  const worst = [...h.stuck].sort((a, b) => b.phaseAgeMs - a.phaseAgeMs)[0];
  if (!worst) return null;
  return `stuck · ${worst.phase} ${formatAge(worst.phaseAgeMs)}${h.stuck.length > 1 ? ` (+${h.stuck.length - 1})` : ''}`;
}
