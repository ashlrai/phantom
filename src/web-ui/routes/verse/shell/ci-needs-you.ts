import type { CiRunFactsV1 } from './fleet-ci-runs-query.js';
import { ciRunsToday } from './ci-runs-facts.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

export const CI_PLAN_COMMAND = 'ashlr fleet ci-plan --patch | git apply';

export function deriveCiNeedsYou(facts: CiRunFactsV1 | undefined, nowMs: number): FleetNeedsYouItem[] {
  const today = ciRunsToday(facts, nowMs);
  if (!today) return [];
  const { runs, failures } = today;
  return [{
    id: 'ci-runs-on-prs', severity: 'attention',
    title: `CI ran ${runs} times on PRs today; Mason's order is once a day`,
    detail: `${failures.total} reds: ${failures.bindArtifact} rebase artifacts (not code), ${failures.code} code, ${failures.unclassified} unclassified. Apply the once-a-day plan: ${CI_PLAN_COMMAND} (owner change)`,
    nextStep: 'Copy the once-a-day plan command', target: 'ops',
    open: { kind: 'copy', command: CI_PLAN_COMMAND },
  }];
}
