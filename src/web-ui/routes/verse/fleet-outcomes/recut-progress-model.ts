import { JOB_ID_RE, prLabel, safePrUrl } from '../fleet-job-log/worker-log-model.js';

type Recut = { id: string; queuedAtMs: number };
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
type Phase = 'waiting' | 'launched' | 'published' | 'missing';
const KEY = 'phantom.recut-progress';
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const rows = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(record) : [];
const elapsed = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} hr${minutes % 60 ? ` ${minutes % 60} min` : ''}`;
};

export function recutProgress({ id, runs, queuedAtMs, nowMs }: Recut & { runs: unknown; nowMs: number }): { phase: Phase; text: string; prUrl: string | null } {
  const data = record(runs);
  const job = `RQ-PHX-${id}`;
  const published = rows(data.publishesLastHour).find(row => row.job === job);
  if (published) {
    const url = safePrUrl(typeof published.url === 'string' ? published.url : null);
    const prUrl = url?.startsWith('https:') ? url : null;
    return { phase: 'published', text: `published → ${prUrl ? prLabel(prUrl) : 'Pull request'}`, prUrl };
  }
  const worker = rows(data.workers).find(row => row.job === job);
  const claimed = rows(data.claimed).find(row => row.job === job);
  const launched = worker ?? claimed;
  if (launched) {
    const lane = typeof launched.lane === 'string' && launched.lane ? launched.lane : 'unknown lane';
    const ageMs = worker && typeof worker.ageSeconds === 'number' && Number.isFinite(worker.ageSeconds)
      ? worker.ageSeconds * 1000
      : !worker && typeof claimed?.at === 'string' ? nowMs - Date.parse(claimed.at) : NaN;
    return { phase: 'launched', text: `launched on ${lane}${Number.isFinite(ageMs) ? ` · ${elapsed(ageMs)} ago` : ''}`, prUrl: null };
  }
  if (rows(record(data.drop).pending).some(row => row.file === `${job}.md`)) {
    return { phase: 'waiting', text: `waiting in drop · ${elapsed(nowMs - queuedAtMs)}`, prUrl: null };
  }
  if (nowMs - queuedAtMs >= 600_000) {
    return { phase: 'missing', text: `not seen for ${elapsed(nowMs - queuedAtMs)} (ingest may have rejected it)`, prUrl: null };
  }
  return { phase: 'waiting', text: 'queued · waiting for ingest', prUrl: null };
}

function stored(storage: StorageLike): Record<string, unknown> {
  try { return record(JSON.parse(storage.getItem(KEY) ?? '{}')); } catch { return {}; }
}
export function recallRecut(storage: StorageLike, prNumber: string | number): Recut | null {
  const value = record(stored(storage)[prNumber]);
  return typeof value.id === 'string' && JOB_ID_RE.test(value.id)
    && typeof value.queuedAtMs === 'number' && Number.isFinite(value.queuedAtMs)
    ? { id: value.id, queuedAtMs: value.queuedAtMs } : null;
}
export function rememberRecut(storage: StorageLike, prNumber: string | number, recut: Recut): void {
  try { storage.setItem(KEY, JSON.stringify({ ...stored(storage), [prNumber]: recut })); } catch { /* Storage can be disabled. */ }
}
