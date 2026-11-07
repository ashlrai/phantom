import { getReadClientProof, reportSessionExpired } from '../../../data/auth-store.js';
import type { QueryDef } from '../../../data/queries.js';
import { isRemoteMobileMode } from '../../../data/remote-mode.js';

export interface LaneStreak {
  lane: string; launches: number; ended: number; empties: number; published: number; running: number;
  medianMinutes: number | null; verdict: 'burning' | 'ok' | 'quiet';
  lastEmptyJob: string | null; lastEmptyAt: string | null;
}
export interface LaneStreaksData {
  v: 1; generatedAt: string; source: 'ok' | 'unavailable'; windowMinutes: number; lanes: LaneStreak[];
}
export type LaneStreaksRead = { kind: 'available'; data: LaneStreaksData } | { kind: 'notInBuild' };

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const duration = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const laneName = /^[A-Za-z0-9_.-]{1,80}$/;
const jobId = /^[A-Za-z0-9_-]{1,80}$/;

export function isLaneStreak(value: unknown): value is LaneStreak {
  return object(value) && typeof value.lane === 'string' && laneName.test(value.lane)
    && count(value.launches) && count(value.ended) && count(value.empties) && count(value.published) && count(value.running)
    && (value.medianMinutes === null || duration(value.medianMinutes))
    && (value.verdict === 'burning' || value.verdict === 'ok' || value.verdict === 'quiet')
    && (value.lastEmptyJob === null || typeof value.lastEmptyJob === 'string' && jobId.test(value.lastEmptyJob))
    && (value.lastEmptyAt === null || typeof value.lastEmptyAt === 'string');
}

function readLaneStreaks(value: unknown): LaneStreaksData | null {
  if (!object(value) || value.v !== 1 || typeof value.generatedAt !== 'string'
    || (value.source !== 'ok' && value.source !== 'unavailable') || !duration(value.windowMinutes)
    || !Array.isArray(value.lanes)) return null;
  return { v: 1, generatedAt: value.generatedAt, source: value.source, windowMinutes: value.windowMinutes,
    lanes: value.lanes.filter(isLaneStreak) };
}

export const laneStreaksQuery: QueryDef<LaneStreaksRead> = {
  key: 'verse-runs-history-lane-streaks',
  async fetch(signal) {
    const path = '/api/verse/runs-history/lane-streaks';
    const remote = isRemoteMobileMode();
    try {
      const response = await fetch(path, {
        method: 'GET', credentials: 'same-origin', signal,
        ...(remote ? { cache: 'no-store', redirect: 'manual' } : { headers: { 'x-ashlr-read-client': getReadClientProof() } }),
      });
      if (response.status === 401 || remote && (response.type === 'opaqueredirect'
        || response.status >= 300 && response.status < 400 || response.headers.get('content-type')?.includes('text/html'))) {
        reportSessionExpired();
      }
      if (response.status !== 200) return { kind: 'notInBuild' };
      const data = readLaneStreaks(await response.json() as unknown);
      return data ? { kind: 'available', data } : { kind: 'notInBuild' };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { kind: 'notInBuild' };
    }
  },
};
