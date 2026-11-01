import type { OpsReleasesV1 } from '../../../../core/verse/ops-types.js';
import { apiGet, apiPost, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isOpsReleases } from './fleet-releases-model.js';

export interface ReleasePrMergeResult { ok: true; sha: string | null }

export function postReleasePrMerge(repo: string, number: number, token: string): Promise<ReleasePrMergeResult> {
  return apiPost<ReleasePrMergeResult>('/api/verse/release-pr/merge', { repo, number }, token);
}

export const opsReleasesQuery: QueryDef<OpsReleasesV1 | null> = {
  key: 'verse-ops-releases',
  async fetch(signal) {
    try {
      const value = await apiGet<unknown>('/api/verse/ops/releases', signal);
      if (value === null) return null;
      if (!isOpsReleases(value)) throw new Error('Invalid releases response.');
      return value;
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
  },
};
