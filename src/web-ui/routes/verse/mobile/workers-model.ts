import { sinceText } from './connectivity.js';

export interface FleetWorkers {
  workers: Array<{ job: string; lane: string; tier: string; ageSeconds: number | null }>;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function isFleetWorkers(value: unknown): value is FleetWorkers {
  return record(value) && Array.isArray(value.workers) && value.workers.every((worker: unknown) =>
    record(worker) && typeof worker.job === 'string' && typeof worker.lane === 'string'
    && typeof worker.tier === 'string' && (worker.ageSeconds === null
      || (typeof worker.ageSeconds === 'number' && Number.isFinite(worker.ageSeconds) && worker.ageSeconds >= 0)));
}

export function workerRows(data: FleetWorkers, nowMs: number) {
  const rows = data.workers.map(({ job, lane, tier, ageSeconds }) => {
    const ageText = ageSeconds === null ? 'unknown' : sinceText(nowMs - ageSeconds * 1_000, nowMs).replace(/^Updated /, '').replace(/ ago$/, '');
    const tone: 'ok' | 'warn' | 'bad' | 'unknown' = ageSeconds === null ? 'unknown'
      : ageSeconds < 20 * 60 ? 'ok' : ageSeconds <= 45 * 60 ? 'warn' : 'bad';
    return { job, lane, tier, ageSeconds, ageText, tone };
  }).sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1));
  const oldest = rows[0];
  return { rows, summary: oldest ? `${rows.length} running · oldest ${oldest.job} ${oldest.ageText}` : 'No workers running' };
}
