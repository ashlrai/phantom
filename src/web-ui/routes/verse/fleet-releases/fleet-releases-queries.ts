import type { OpsReleasesV1 } from '../../../../core/verse/ops-types.js';
import { apiGet, apiPost, ApiError } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { isOpsReleases } from './fleet-releases-model.js';

export interface ReleasePrMergeResult { ok: true; sha: string | null }

// The CI facts endpoint is being introduced separately; keep this contract in
// sync with its producer when it lands.
export interface CiRunFactsV1 {
  v: 1; generatedAt: string; repo: string | null; windowHours: number; available: boolean; reason: string | null; total: number;
  byEvent: { pull_request: number; push: number; schedule: number; merge_group: number; workflow_dispatch: number; other: number };
  byWorkflow: Array<{ name: string; total: number; failed: number }>;
  failures: { total: number; bindArtifact: number; code: number; unclassified: number };
  daily: { runId: number; conclusion: string | null; createdAt: string; failedJobs: string[]; url: string } | null;
  recent: Array<{ runId: number; workflow: string; event: string; headBranch: string; prNumber: number | null; conclusion: string | null; status: string; failureClass: 'bind-artifact' | 'code' | null; createdAt: string; url: string }>;
}

export const ciRunsQuery: QueryDef<CiRunFactsV1 | undefined> = {
  key: 'verse-fleet-ci-runs-48',
  async fetch(signal) {
    try {
      return await apiGet<CiRunFactsV1>('/api/verse/fleet/ci-runs?hours=48', signal);
    } catch {
      return undefined;
    }
  },
};

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
