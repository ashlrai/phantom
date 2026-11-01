import type { FleetRunsDirState } from './runs-dir-state.js';
import type { LiveWorkersSnapshot } from './runs-live-workers.js';

// A status tick or observation older than five minutes cannot prove a current launch.
const MAX_AGE_MS = 5 * 60_000;
const FUTURE_TOLERANCE_MS = 30_000;
const LIMIT = 'Launch wrappers are process evidence, not proof that a provider is consuming tokens.';

function fresh(at: string | null | undefined, now: number): boolean {
  const time = Date.parse(at ?? '');
  return Number.isFinite(now) && Number.isFinite(time) && now - time <= MAX_AGE_MS && time - now <= FUTURE_TOLERANCE_MS;
}

/** Compare one status snapshot with one process-table observation; neither claims nor queue entries prove a launch. */
export function launchProofCheck(state: FleetRunsDirState | null, workers: LiveWorkersSnapshot | null, now: number, laneFilter?: string) {
  const reasons: string[] = [];
  if (!state || !state.runsDirPresent || state.sources.status !== 'healthy') reasons.push('status_unavailable');
  if (state && (!fresh(state.generatedAt, now) || !fresh(state.lastTick, now))) reasons.push('status_stale_or_invalid');
  if (!workers || workers.sourceState !== 'healthy') reasons.push('workers_unavailable');
  if (workers && !fresh(workers.generatedAt, now)) reasons.push('workers_stale_or_invalid');
  if (state && state.paused === null) reasons.push('pause_unknown');
  const selected = state?.lanes.filter(lane => laneFilter === undefined || lane.lane === laneFilter) ?? [];
  if (state && selected.length === 0) reasons.push(laneFilter ? 'lane_not_found' : 'no_lanes');
  const statusKnown = !!state && state.runsDirPresent && state.sources.status === 'healthy' &&
    fresh(state.generatedAt, now) && fresh(state.lastTick, now) && state.paused !== null;
  const workersKnown = !!workers && workers.sourceState === 'healthy' && fresh(workers.generatedAt, now);
  const lanes = selected.map(lane => {
    const observedWorkerJobs = workersKnown ? new Set((workers?.workers ?? []).filter(worker => worker.lane === lane.lane).map(worker => worker.job)).size : null;
    const discrepancies: string[] = [];
    if (observedWorkerJobs !== null && lane.running !== observedWorkerJobs) discrepancies.push('reported_running_differs_from_observed_workers');
    if (statusKnown && observedWorkerJobs !== null && !lane.held && state?.paused === false && lane.target > 0 && lane.queued > 0 && observedWorkerJobs === 0) {
      discrepancies.push('queued_eligible_lane_has_no_observed_workers');
    }
    const assessment = !statusKnown || !workersKnown ? 'unknown' : discrepancies.length ? 'failure'
      : lane.held ? 'held' : state?.paused ? 'paused' : lane.target === 0 ? 'disabled' : 'observed';
    return { lane: lane.lane, reportedRunning: lane.running, observedWorkerJobs, queued: lane.queued,
      target: lane.target, held: lane.held, heldReason: lane.heldReason, assessment, discrepancies,
      evidenceTime: { status: state?.lastTick ?? null, workers: workers?.generatedAt ?? null } };
  });
  const ok = reasons.length === 0 && lanes.every(lane => lane.assessment !== 'failure' && lane.assessment !== 'unknown');
  return { ok, reasons, laneFilter: laneFilter ?? null, paused: state?.paused ?? null,
    evidence: { statusSource: state?.sources.status ?? 'unavailable', statusSnapshotAt: state?.generatedAt ?? null,
      statusTickAt: state?.lastTick ?? null, workersSource: workers?.sourceState ?? 'unavailable', workersAt: workers?.generatedAt ?? null,
      maxAgeMs: MAX_AGE_MS, futureToleranceMs: FUTURE_TOLERANCE_MS },
    lanes, limitation: LIMIT };
}
