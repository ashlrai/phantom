type SnapshotWorker = {
  state: 'running' | 'published' | 'claimed' | 'merged' | 'unknown';
  repo: string | null; lane: string | null; tier: string | null;
  ageText: string | null; prUrl: string | null; mergedAs: string | null;
};

const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const string = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
const entries = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(record) : [];

function prUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/pull\/[0-9]+\/?$/.test(value)) return null;
  return value;
}

function ageText(seconds: unknown): string | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return null;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
}

/** Read each optional snapshot field independently; older producers may omit any of them. */
export function workerFromSnapshot(runs: unknown, job: string, nowMs: number): SnapshotWorker | null {
  if (!record(runs) || !job) return null;
  const worker = entries(runs['workers']).find(entry => entry['job'] === job);
  const published = entries(runs['publishesLastHour']).find(entry => entry['job'] === job);
  const claimed = entries(runs['claimed']).find(entry => entry['job'] === job);
  const merges = record(runs['mergesLastHour']) ? entries(runs['mergesLastHour']['items']) : [];
  const merged = merges.find(entry => typeof entry['title'] === 'string' && entry['title'].includes(job));
  if (!worker && !published && !claimed && !merged) return null;

  const mergeRepo = string(merged?.['repo']);
  const mergeNumber = merged?.['number'];
  const mergedAs = mergeRepo && typeof mergeNumber === 'number' && Number.isSafeInteger(mergeNumber) && mergeNumber > 0
    ? `${mergeRepo} #${mergeNumber}` : null;
  const at = string(worker ? runs['generatedAt'] : published?.['at'] ?? claimed?.['at']);
  const timestamp = at ? Date.parse(at) : NaN;
  const elapsed = Number.isFinite(timestamp) && Number.isFinite(nowMs) ? Math.max(0, (nowMs - timestamp) / 1000) : 0;
  const seconds = worker ? worker['ageSeconds'] : Number.isFinite(timestamp) && Number.isFinite(nowMs) ? elapsed : null;
  const age = typeof seconds === 'number' && worker && Number.isFinite(seconds) && seconds >= 0 ? seconds + elapsed : seconds;
  return {
    state: merged ? (mergedAs ? 'merged' : 'unknown') : published ? 'published' : worker ? 'running' : claimed ? 'claimed' : 'unknown',
    repo: string(worker?.['repo']) ?? mergeRepo,
    lane: string(worker?.['lane']) ?? string(published?.['lane']) ?? string(claimed?.['lane']),
    tier: string(worker?.['tier']) ?? string(claimed?.['tier']),
    ageText: ageText(age), prUrl: prUrl(published?.['url']), mergedAs,
  };
}
