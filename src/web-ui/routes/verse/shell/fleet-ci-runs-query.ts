import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { FLEET_NEEDS_YOU_POLL_MS } from './fleet-needs-you-query.js';

export const FLEET_CI_RUNS_POLL_MS = FLEET_NEEDS_YOU_POLL_MS * 20;

export interface CiRunFactsV1 {
  v: 1;
  generatedAt: string;
  repo: string | null;
  windowHours: number;
  available: boolean;
  reason: string | null;
  total: number;
  byEvent: { pull_request: number; push: number; schedule: number; merge_group: number; workflow_dispatch: number; other: number };
  byWorkflow: Array<{ name: string; total: number; failed: number }>;
  failures: { total: number; bindArtifact: number; code: number; unclassified: number };
  daily: { runId: number; conclusion: string | null; createdAt: string; failedJobs: string[]; url: string } | null;
  recent: Array<{ runId: number; workflow: string; event: string; headBranch: string; prNumber: number | null;
    conclusion: string | null; status: string; failureClass: 'bind-artifact' | 'code' | null; createdAt: string; url: string }>;
}

export const fleetCiRunsQuery: QueryDef<CiRunFactsV1> = {
  key: 'verse-fleet-ci-runs-24',
  fetch: signal => apiGet<CiRunFactsV1>('/api/verse/fleet/ci-runs?hours=24', signal),
};
