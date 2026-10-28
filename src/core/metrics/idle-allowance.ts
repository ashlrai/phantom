/** Read-only idle estimates from timestamped router observations. */
export interface IdleLane { lane: string; running: number; target: number; pausedReason?: string | null }
export interface IdleSnapshot { timestamp: string; lanes: IdleLane[] }
export interface IdleJob { id: string; lane: string; status: string; startedAt: string; finishedAt?: string }

function time(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value)) throw new Error('Invalid timestamp');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('Invalid timestamp');
  return result;
}

/** Intervals use the preceding observation; the final snapshot is only a boundary. */
export function computeIdleAllowance(snapshots: IdleSnapshot[], jobs: IdleJob[]) {
  if (snapshots.length < 2) throw new Error('At least two snapshots are required');
  const ordered = snapshots.map(snapshot => ({ ...snapshot, at: time(snapshot.timestamp) })).sort((a, b) => a.at - b.at);
  const lanes = new Map<string, { lane: string; idleSlotMinutes: number; pausedSlotMinutes: number; pausedReasons: Record<string, number> }>();
  for (let i = 0; i < ordered.length; i++) {
    const snapshot = ordered[i]!;
    if (!Array.isArray(snapshot.lanes)) throw new Error('Invalid snapshot lanes');
    if (i && snapshot.at === ordered[i - 1]!.at) throw new Error('Duplicate snapshot timestamp');
    const seen = new Set<string>();
    for (const lane of snapshot.lanes) {
      if (!lane || typeof lane.lane !== 'string' || !/^[\w.-]{1,128}$/.test(lane.lane) || seen.has(lane.lane) ||
          !Number.isSafeInteger(lane.running) || lane.running < 0 || !Number.isSafeInteger(lane.target) || lane.target < 0 ||
          (lane.pausedReason != null && (typeof lane.pausedReason !== 'string' || !/^[\w .-]{1,128}$/.test(lane.pausedReason)))) throw new Error('Invalid snapshot lane');
      seen.add(lane.lane);
      const result = lanes.get(lane.lane) ?? { lane: lane.lane, idleSlotMinutes: 0, pausedSlotMinutes: 0, pausedReasons: Object.create(null) as Record<string, number> };
      lanes.set(lane.lane, result);
      const minutes = i + 1 < ordered.length ? (ordered[i + 1]!.at - snapshot.at) / 60000 : 0;
      const idle = Math.max(0, lane.target - lane.running) * minutes;
      result.idleSlotMinutes += idle;
      if (lane.pausedReason) {
        result.pausedSlotMinutes += idle;
        result.pausedReasons[lane.pausedReason] = (result.pausedReasons[lane.pausedReason] ?? 0) + idle;
      }
    }
  }
  const end = ordered[ordered.length - 1]!.at;
  const samples = new Map<string, number[]>();
  const running: { id: string; lane: string; elapsedMinutes: number }[] = [];
  for (const job of jobs) {
    if (!job || typeof job.id !== 'string' || !/^[\w.-]{1,128}$/.test(job.id) || typeof job.lane !== 'string' || !/^[\w.-]{1,128}$/.test(job.lane) || typeof job.status !== 'string') throw new Error('Invalid job');
    const start = time(job.startedAt);
    if (job.status === 'running') {
      if (start <= end) running.push({ id: job.id, lane: job.lane, elapsedMinutes: (end - start) / 60000 });
    } else if (['completed', 'done', 'finished', 'merged', 'failed', 'cancelled'].includes(job.status) && job.finishedAt !== undefined) {
      const finish = time(job.finishedAt);
      if (finish < start) throw new Error('Job finishes before it starts');
      if (finish <= end && finish > start) samples.set(job.lane, [...(samples.get(job.lane) ?? []), (finish - start) / 60000]);
    }
  }
  const medians = new Map([...samples].map(([lane, values]) => {
    values.sort((a, b) => a - b);
    const mid = Math.floor(values.length / 2);
    return [lane, values.length % 2 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2] as const;
  }));
  return { from: ordered[0]!.timestamp, to: ordered[ordered.length - 1]!.timestamp,
    lanes: [...lanes.values()].sort((a, b) => a.lane.localeCompare(b.lane)),
    stuckJobs: running.flatMap(job => { const medianWallMinutes = medians.get(job.lane); return medianWallMinutes !== undefined && job.elapsedMinutes > 2 * medianWallMinutes ? [{ ...job, medianWallMinutes }] : []; }),
    medianWallMinutesByLane: Object.fromEntries(medians) };
}
