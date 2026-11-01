import type { CiRunFactsV1 } from './fleet-ci-runs-query.js';

export const CI_NOW = Date.parse('2026-11-01T12:00:00Z');
export const ciFacts: CiRunFactsV1 = {
  v: 1, generatedAt: '2026-11-01T12:00:00Z', repo: 'example/repo', windowHours: 24,
  available: true, reason: null, total: 11,
  byEvent: { pull_request: 7, push: 3, schedule: 1, merge_group: 0, workflow_dispatch: 0, other: 0 },
  byWorkflow: [{ name: 'CI', total: 10, failed: 4 }, { name: 'Daily', total: 1, failed: 0 }],
  failures: { total: 4, bindArtifact: 2, code: 1, unclassified: 1 }, daily: null, recent: [],
};
