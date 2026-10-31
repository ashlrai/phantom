import { workerAgeState } from '../fleet/worker-age-state.js';

export function workerAgeSummary(workers: ReadonlyArray<{ lane: string; ageSeconds: number | null }>): string | null {
  const aged = workers.filter((worker): worker is { lane: string; ageSeconds: number } =>
    worker.ageSeconds !== null && Number.isFinite(worker.ageSeconds));
  if (aged.length === 0) return null;

  const minutes = Math.floor(Math.max(...aged.map((worker) => worker.ageSeconds)) / 60);
  const age = minutes > 90 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
  const stuck = aged.filter((worker) => workerAgeState(worker.lane, worker.ageSeconds) === 'stuck').length;
  return `oldest worker ${age}${stuck ? ` · ${stuck} ${stuck === 1 ? 'looks' : 'look'} stuck` : ''}`;
}
