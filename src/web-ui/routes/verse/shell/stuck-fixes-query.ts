import { getReadClientProof, reportSessionExpired } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

export interface StuckFix {
  job: string; repo: string | null; prUrl: string; publishedAt: string; ageMinutes: number;
}
export interface StuckFixesData {
  v: 1; generatedAt: string; known: boolean; thresholdMinutes: number; stuck: StuckFix[];
}
export type StuckFixesRead = { kind: 'available'; data: StuckFixesData } | { kind: 'notInBuild' };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonNegativeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function isStuckFix(value: unknown): value is StuckFix {
  return object(value) && typeof value.job === 'string' && (value.repo === null || typeof value.repo === 'string')
    && typeof value.prUrl === 'string' && value.prUrl.startsWith('https://github.com/')
    && typeof value.publishedAt === 'string' && nonNegativeInteger(value.ageMinutes);
}

function isStuckFixesData(value: unknown): value is StuckFixesData {
  return object(value) && value.v === 1 && typeof value.generatedAt === 'string'
    && typeof value.known === 'boolean' && nonNegativeInteger(value.thresholdMinutes)
    && Array.isArray(value.stuck) && value.stuck.every(isStuckFix);
}

export const stuckFixesQuery: QueryDef<StuckFixesRead> = {
  key: 'verse-runs-history-stuck-fixes',
  async fetch(signal) {
    const remote = isRemoteMobileMode();
    try {
      const response = await fetch('/api/verse/runs-history/stuck-fixes', {
        method: 'GET', credentials: 'same-origin', signal,
        ...(remote ? { cache: 'no-store', redirect: 'manual' } : { headers: { 'x-ashlr-read-client': getReadClientProof() } }),
      });
      if (response.status === 401 || remote && (response.type === 'opaqueredirect'
        || response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.includes('text/html'))) {
        reportSessionExpired();
      }
      if (response.status !== 200) return { kind: 'notInBuild' };
      const data: unknown = await response.json();
      return isStuckFixesData(data) ? { kind: 'available', data } : { kind: 'notInBuild' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'notInBuild' };
    }
  },
};
