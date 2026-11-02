import { getReadClientProof, reportSessionExpired } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

export interface MainHealthRepo {
  repo: string; branch: string; sha: string | null; state: 'green' | 'red' | 'unknown';
  checkedAt: string | null; failingCheck: string | null; fixJobs: string[]; nightlyRed: string | null;
}
export interface MainHealthData {
  v: 1; generatedAt: string; source: 'ok' | 'unavailable'; statusAt: string | null;
  stale: boolean; guardianOff: boolean; red: number; repos: MainHealthRepo[];
}
export type MainHealthRead = { kind: 'available'; data: MainHealthData } | { kind: 'notInBuild' };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string';

export function isMainHealthRepo(value: unknown): value is MainHealthRepo {
  return object(value) && typeof value.repo === 'string' && typeof value.branch === 'string'
    && nullableString(value.sha) && (value.state === 'green' || value.state === 'red' || value.state === 'unknown')
    && nullableString(value.checkedAt) && nullableString(value.failingCheck)
    && Array.isArray(value.fixJobs) && value.fixJobs.every((job: unknown) => typeof job === 'string')
    && nullableString(value.nightlyRed);
}

function isMainHealthData(value: unknown): value is MainHealthData {
  return object(value) && value.v === 1 && typeof value.generatedAt === 'string'
    && (value.source === 'ok' || value.source === 'unavailable') && nullableString(value.statusAt)
    && typeof value.stale === 'boolean' && typeof value.guardianOff === 'boolean'
    && typeof value.red === 'number' && Number.isSafeInteger(value.red) && value.red >= 0
    && Array.isArray(value.repos) && value.repos.every(isMainHealthRepo);
}

export const mainHealthQuery: QueryDef<MainHealthRead> = {
  key: 'verse-runs-history-main-health',
  async fetch(signal) {
    const remote = isRemoteMobileMode();
    try {
      const response = await fetch('/api/verse/runs-history/main-health', {
        method: 'GET', credentials: 'same-origin', signal,
        ...(remote ? { cache: 'no-store', redirect: 'manual' } : { headers: { 'x-ashlr-read-client': getReadClientProof() } }),
      });
      if (response.status === 401 || remote && (response.type === 'opaqueredirect'
        || response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.includes('text/html'))) {
        reportSessionExpired();
      }
      if (response.status !== 200) return { kind: 'notInBuild' };
      const data: unknown = await response.json();
      return isMainHealthData(data) ? { kind: 'available', data } : { kind: 'notInBuild' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'notInBuild' };
    }
  },
};
