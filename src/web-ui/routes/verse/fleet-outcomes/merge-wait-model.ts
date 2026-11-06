import { safeHref } from '../cloud/cloud-model.js';

export interface MergeWaitRow {
  job: string;
  lane: string | null;
  number: number | null;
  repo: string | null;
  state: 'merged' | 'waiting' | 'unknown';
  waitMs: number | null;
  text: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const timestamp = (value: unknown): number | null => {
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

function prLink(value: unknown): { url: string; repo: string; number: number } | null {
  const url = safeHref(typeof value === 'string' ? value : null, 'github.com');
  if (!url) return null;
  const match = new URL(url).pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match) return null;
  const number = Number(match[3]);
  return Number.isSafeInteger(number) ? { url, repo: `${match[1]}/${match[2]}`, number } : null;
}

export const waitDuration = (ms: number): string => `${Math.floor(ms / 60_000)}m`;

export function mergeWaits(runs: unknown, nowMs: number): MergeWaitRow[] {
  const data = record(runs);
  const publishes = Array.isArray(data.publishesLastHour) ? data.publishesLastHour : [];
  const merges = record(data.mergesLastHour).items;
  const merged = new Map<string, Record<string, unknown>>();
  for (const value of Array.isArray(merges) ? merges : []) {
    const item = record(value);
    if (typeof item.repo === 'string' && typeof item.number === 'number' && Number.isSafeInteger(item.number) && item.number > 0) {
      merged.set(`${item.repo.toLowerCase()}#${item.number}`, item);
    }
  }
  const rows: MergeWaitRow[] = publishes.flatMap<MergeWaitRow>(value => {
    const item = record(value);
    if (typeof item.job !== 'string' || !item.job) return [];
    const job = item.job;
    const lane = typeof item.lane === 'string' && item.lane ? item.lane : null;
    const pr = prLink(item.url);
    if (!pr) return [{ job, lane, number: null, repo: null, state: 'unknown' as const, waitMs: null, text: 'no PR' }];
    const merge = merged.get(`${pr.repo.toLowerCase()}#${pr.number}`);
    const publishedAt = timestamp(item.at);
    if (merge) {
      const mergedAt = timestamp(merge.mergedAt);
      const waitMs = mergedAt !== null && publishedAt !== null ? Math.max(0, mergedAt - publishedAt) : null;
      return [{ job, lane, number: pr.number, repo: pr.repo, state: 'merged' as const, waitMs,
        text: waitMs === null ? 'merged' : `merged after ${waitDuration(waitMs)}` }];
    }
    const waitMs = publishedAt !== null && Number.isFinite(nowMs) ? Math.max(0, nowMs - publishedAt) : null;
    return [{ job, lane, number: pr.number, repo: pr.repo, state: 'waiting' as const, waitMs,
      text: waitMs === null ? 'waiting' : `waiting ${waitDuration(waitMs)}` }];
  });
  const order = { waiting: 0, merged: 1, unknown: 2 };
  return rows.sort((a, b) => order[a.state] - order[b.state] || (b.waitMs ?? -1) - (a.waitMs ?? -1));
}

/** Retrieve the original safe URL without adding it to the row's public shape. */
export function mergeWaitHref(runs: unknown, row: MergeWaitRow): string | null {
  const publishes = record(runs).publishesLastHour;
  if (!Array.isArray(publishes)) return null;
  for (const value of publishes) {
    const item = record(value);
    const pr = prLink(item.url);
    if (item.job === row.job && pr && pr.number === row.number && pr.repo === row.repo) return pr.url;
  }
  return null;
}

export function mergeWaitSummary(rows: MergeWaitRow[]): { merged: number; waiting: number; medianMergedMs: number | null; oldestWaitingMs: number | null } {
  const merged = rows.filter(row => row.state === 'merged');
  const waiting = rows.filter(row => row.state === 'waiting');
  const durations = merged.flatMap(row => row.waitMs === null ? [] : [row.waitMs]).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianMergedMs = durations.length === 0 ? null : durations.length % 2
    ? durations[middle]! : (durations[middle - 1]! + durations[middle]!) / 2;
  const ages = waiting.flatMap(row => row.waitMs === null ? [] : [row.waitMs]);
  return { merged: merged.length, waiting: waiting.length, medianMergedMs,
    oldestWaitingMs: ages.length ? Math.max(...ages) : null };
}
