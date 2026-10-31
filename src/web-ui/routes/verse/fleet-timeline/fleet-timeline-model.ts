import type { SwimlaneLane } from '../../../components/charts/Swimlane.js';
import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

const HOUR = 3_600_000;

export function timelineLanes(runs: FleetRuns, nowMs: number): {
  lanes: SwimlaneLane[];
  from: number;
  to: number;
  longest: { job: string; lane: string; ageSeconds: number } | null;
  unknownAge: number;
} {
  const lanes: SwimlaneLane[] = runs.lanes.map(({ lane, running, target }, index) => ({
    id: `lane-${index}`, label: `${lane} ${running}/${target}`, items: [],
  }));
  const byName = new Map(runs.lanes.map(({ lane }, index) => [lane, lanes[index]!]));
  let other: SwimlaneLane | undefined;
  let longest: { job: string; lane: string; ageSeconds: number } | null = null;
  let unknownAge = 0;
  let earliest = nowMs;

  runs.workers.forEach((worker, index) => {
    let lane = byName.get(worker.lane);
    if (!lane) {
      if (!other) { other = { id: 'other', label: 'other', items: [] }; lanes.push(other); }
      lane = other;
    }
    if (worker.ageSeconds === null) { unknownAge++; return; }
    const age = worker.ageSeconds;
    const start = nowMs - age * 1000;
    earliest = Math.min(earliest, start);
    if (longest === null || age > longest.ageSeconds) longest = { job: worker.job, lane: worker.lane, ageSeconds: age };
    lane.items.push({
      id: `worker-${index}`, start, end: null,
      status: age <= 20 * 60 ? 'running' : age <= 45 * 60 ? 'slow' : 'stuck',
      detail: `${worker.job} · ${worker.tier} · ${ageText(age)}`,
    });
  });

  return { lanes, from: Math.max(nowMs - 2 * HOUR, Math.floor(earliest / HOUR) * HOUR), to: nowMs, longest, unknownAge };
}
