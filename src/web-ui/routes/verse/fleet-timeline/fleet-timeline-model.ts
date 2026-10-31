import type { SwimlaneItem, SwimlaneLane } from '../../../components/charts/Swimlane.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

const HOUR = 3_600_000;
type Worker = FleetRuns['workers'][number];
export type LaneGroup = {
  lane: string; rows: Worker[];
  counts: { total: number; slow: number; stuck: number; unknown: number };
  medianAgeSeconds: number | null;
};

function workerStatus(age: number | null): 'running' | 'slow' | 'stuck' | 'unknown' {
  return age === null ? 'unknown' : age <= 20 * 60 ? 'running' : age <= 45 * 60 ? 'slow' : 'stuck';
}

export function groupByLane(rows: Worker[], _nowMs: number): LaneGroup[] {
  const groups = new Map<string, Worker[]>();
  for (const row of rows) {
    const group = groups.get(row.lane);
    if (group) group.push(row); else groups.set(row.lane, [row]);
  }
  return [...groups].map(([lane, workers]) => {
    const counts = { total: workers.length, slow: 0, stuck: 0, unknown: 0 };
    const ages: number[] = [];
    for (const worker of workers) {
      const status = workerStatus(worker.ageSeconds);
      if (status !== 'running') counts[status]++;
      if (worker.ageSeconds !== null) ages.push(worker.ageSeconds);
    }
    ages.sort((a, b) => a - b);
    const middle = Math.floor(ages.length / 2);
    const medianAgeSeconds = !ages.length ? null : ages.length % 2 ? ages[middle]! : (ages[middle - 1]! + ages[middle]!) / 2;
    return { lane, rows: workers, counts, medianAgeSeconds };
  }).sort((a, b) => b.counts.total - a.counts.total || a.lane.localeCompare(b.lane));
}

export function laneGroupHeadline(group: LaneGroup): string {
  const { total, slow, stuck, unknown } = group.counts;
  const parts = [group.lane, `${total} worker${total === 1 ? '' : 's'}`];
  if (slow) parts.push(`${slow} slow`);
  if (stuck) parts.push(`${stuck} stuck`);
  if (unknown) parts.push(`${unknown} unknown`);
  parts.push(`median ${group.medianAgeSeconds === null ? '—' : `${Math.round(group.medianAgeSeconds / 60)} m`}`);
  return parts.join(' · ');
}

export function jobFromItem(item: SwimlaneItem): string | null {
  return JOB_ID_RE.test(item.id) ? item.id : null;
}

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

  runs.workers.forEach((worker) => {
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
      id: worker.job, label: worker.job, start, end: null,
      status: workerStatus(age),
      detail: `${worker.job} · ${worker.tier} · ${ageText(age)}`,
    });
  });

  return { lanes, from: Math.max(nowMs - 2 * HOUR, Math.floor(earliest / HOUR) * HOUR), to: nowMs, longest, unknownAge };
}
