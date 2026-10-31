import { useEffect, useSyncExternalStore } from 'react';
import { getQuerySnapshot } from '../../../data/cache.js';
import { ApiError, apiGet } from '../../../data/client.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';

export interface SelfUpdateStatus {
  v: 1;
  generatedAt: string;
  sourceState: 'healthy' | 'degraded' | 'unavailable';
  installedVersion: string | null;
  repoRoot: boolean;
  headSha: string | null; headAt: string | null; originSha: string | null; branch: string | null;
  behind: number | null; ahead: number | null; dirty: boolean | null; lastFetchAt: string | null;
  processStartedAt: string; uptimeSeconds: number; pid: number; canFastForward: boolean | null;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const nullableBoolean = (value: unknown): boolean => value === null || typeof value === 'boolean';
const count = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function readSelfUpdate(raw: unknown): SelfUpdateStatus | null {
  if (!record(raw) || raw.v !== 1 || typeof raw.generatedAt !== 'string'
    || !['healthy', 'degraded', 'unavailable'].includes(raw.sourceState as string)
    || !nullableString(raw.installedVersion) || typeof raw.repoRoot !== 'boolean'
    || !nullableString(raw.headSha) || !nullableString(raw.headAt) || !nullableString(raw.originSha)
    || !nullableString(raw.branch) || !(raw.behind === null || count(raw.behind))
    || !(raw.ahead === null || count(raw.ahead)) || !nullableBoolean(raw.dirty)
    || !nullableString(raw.lastFetchAt) || typeof raw.processStartedAt !== 'string'
    || typeof raw.uptimeSeconds !== 'number' || !Number.isFinite(raw.uptimeSeconds) || raw.uptimeSeconds < 0
    || !count(raw.pid) || !nullableBoolean(raw.canFastForward)) return null;
  return raw as unknown as SelfUpdateStatus;
}

export function updateEntryLabel(status: SelfUpdateStatus): string | null {
  if (status.sourceState === 'unavailable'
    || !(status.canFastForward === true || (status.behind !== null && status.behind > 0 && status.dirty === false))) return null;
  if (status.behind === null) return 'Update available';
  return `Update available · ${status.behind} ${status.behind === 1 ? 'commit' : 'commits'} behind`;
}

let missing: ApiError | null = null;
export const selfUpdateBadgeQuery: QueryDef<unknown> = {
  key: 'verse-self-update-badge',
  fetch: async signal => {
    if (missing) throw missing;
    try {
      return await apiGet<unknown>('/api/verse/ops/self-update', signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) missing = error;
      throw error;
    }
  },
};

const subscribeVisibility = (listener: () => void): (() => void) => {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
};
const visible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

export function useSelfUpdateBadge(): { label: string } | null {
  const isVisible = useSyncExternalStore(subscribeVisibility, visible, () => true);
  const query = useQuery(selfUpdateBadgeQuery, { enabled: isVisible });
  const refetch = useRefetch(selfUpdateBadgeQuery);
  useEffect(() => {
    if (!isVisible || missing) return;
    const timer = setInterval(() => { if (!missing) refetch(); }, 300_000);
    return () => clearInterval(timer);
  }, [isVisible, refetch, query.error]);
  const current = isVisible ? query : getQuerySnapshot<unknown>(selfUpdateBadgeQuery.key);
  const status = missing ? null : readSelfUpdate(current.data);
  const label = status ? updateEntryLabel(status) : null;
  return label ? { label } : null;
}
