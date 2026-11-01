import type { SwimlaneItem, SwimlaneLane } from '../../../components/charts/Swimlane.js';
import { JOB_ID_RE } from '../fleet-job-log/worker-log-model.js';
import type { BusEvent } from '../fleet/bus-feed-queries.js';
import { parseHeldReason } from '../fleet/held-reason.js';
import { ageText, type FleetRuns } from '../ops/ops-runs-model.js';

const HOUR = 3_600_000;
const LANE_LABEL_MAX = 80;
const heldStamp = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
type Worker = FleetRuns['workers'][number];
export type LaneGroup = {
  lane: string; rows: Worker[];
  counts: { total: number; slow: number; stuck: number; unknown: number };
  medianAgeSeconds: number | null;
};

function workerStatus(age: number | null): 'running' | 'slow' | 'stuck' | 'unknown' {
  return age === null ? 'unknown' : age <= 20 * 60 ? 'running' : age <= 45 * 60 ? 'slow' : 'stuck';
}

export function stuckWorkers(rows: Worker[]): Array<{ job: string; lane: string; ageSeconds: number }> {
  return rows.flatMap(({ job, lane, ageSeconds }) =>
    ageSeconds !== null && ageSeconds > 45 * 60 && JOB_ID_RE.test(job)
      ? [{ job, lane, ageSeconds }] : [],
  ).sort((a, b) => b.ageSeconds - a.ageSeconds);
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

export function isMasonItem(item: SwimlaneItem): boolean {
  return item.id.startsWith('inbox:');
}

export function masonLane(events: BusEvent[], from: number, to: number): SwimlaneLane | null {
  const items = events.flatMap((event): SwimlaneItem[] => {
    const at = Date.parse(event.at);
    if (event.kind !== 'inbox' || !Number.isFinite(at) || at < from || at > to) return [];
    const label = event.text.trim().replace(/^INBOX\b\s*[:-]?\s*/i, '').replace(/^Mason,\s*/i, '').trim().slice(0, 80);
    return [{ id: `inbox:${event.at}`, label, detail: label, start: at, end: at, status: 'interjection' }];
  }).sort((a, b) => a.start - b.start);
  return items.length ? { id: 'mason', label: 'Mason', items } : null;
}

/** `Nov 1 01:22` in the viewer's local zone (formatToParts keeps no comma). */
function heldStampText(ms: number): string {
  const parts = heldStamp.formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('month')} ${part('day')} ${part('hour')}:${part('minute')}`;
}

/** Lane header for the timeline: `codex-cmp 0/30`, plus `· held: <reason>`
 *  when the lane is held so an empty lane reads as held, not idle. */
export function laneLabel(
  lane: { lane: string; running: number; target: number; held: boolean; heldReason: string | null },
  nowMs: number,
): string {
  let label = `${lane.lane} ${lane.running}/${lane.target}`;
  if (lane.held) {
    const parsed = parseHeldReason(lane.heldReason);
    label += ' · held';
    if (parsed?.label) label += `: ${parsed.label.toLowerCase()}`;
    const at = parsed?.at ? Date.parse(parsed.at) : NaN;
    if (Number.isFinite(at)) label += parsed?.until && at > nowMs ? ` until ${heldStampText(at)}` : ` since ${heldStampText(at)}`;
  }
  return label.length > LANE_LABEL_MAX ? `${label.slice(0, LANE_LABEL_MAX - 1)}…` : label;
}

export function timelineLanes(runs: FleetRuns, nowMs: number): {
  lanes: SwimlaneLane[];
  from: number;
  to: number;
  longest: { job: string; lane: string; ageSeconds: number } | null;
  unknownAge: number;
} {
  const lanes: SwimlaneLane[] = runs.lanes.map((lane, index) => ({
    id: `lane-${index}`, label: laneLabel(lane, nowMs), items: [],
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
