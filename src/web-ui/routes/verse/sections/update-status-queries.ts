import { apiGet, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';

export interface UpdateServerStatus {
  v: 1; sourceState: 'healthy' | 'degraded' | 'unavailable';
  installedVersion: string | null; headSha: string | null; headAt: string | null;
  originSha: string | null; branch: string | null; behind: number | null; ahead: number | null;
  dirty: boolean | null; lastFetchAt: string | null; processStartedAt: string | null;
  uptimeSeconds: number | null; canFastForward: boolean | null;
}
export type ServerObservation = UpdateServerStatus | { kind: 'notInBuild' } | null;
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const nullableCount = (value: unknown) => value === null || (Number.isSafeInteger(value) && (value as number) >= 0);
const sha = (value: unknown) => value === null || (typeof value === 'string' && /^[a-f0-9]{7,64}$/i.test(value));
const timestamp = (value: unknown) => value === null || (typeof value === 'string' && Number.isFinite(Date.parse(value)));

function validStatus(value: unknown): value is UpdateServerStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return v['v'] === 1 && typeof v['sourceState'] === 'string' && ['healthy', 'degraded', 'unavailable'].includes(v['sourceState'])
    && nullableString(v['installedVersion']) && sha(v['headSha']) && timestamp(v['headAt'])
    && sha(v['originSha']) && nullableString(v['branch']) && nullableCount(v['behind']) && nullableCount(v['ahead'])
    && (v['dirty'] === null || typeof v['dirty'] === 'boolean') && timestamp(v['lastFetchAt'])
    && timestamp(v['processStartedAt']) && (v['uptimeSeconds'] === null || (typeof v['uptimeSeconds'] === 'number' && Number.isFinite(v['uptimeSeconds']) && v['uptimeSeconds'] >= 0))
    && (v['canFastForward'] === null || typeof v['canFastForward'] === 'boolean');
}

export const updateStatusQuery: QueryDef<Exclude<ServerObservation, null>> = {
  key: 'verse-self-update-status',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/ops/self-update', signal);
      if (!validStatus(value)) throw new Error('Invalid update status');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return { kind: 'notInBuild' };
      throw error;
    }
  },
};
