import type { CiRunFactsV1 } from './fleet-ci-runs-query.js';
import type { FleetNeedsYouItem } from './fleet-needs-you.js';

export const CI_PLAN_COMMAND = 'ashlr fleet ci-plan --patch | git apply';
const MAX_AGE_MS = 2 * 60 * 60_000;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function deriveCiNeedsYou(facts: CiRunFactsV1 | undefined, nowMs: number): FleetNeedsYouItem[] {
  if (!facts || facts.v !== 1 || !facts.available || !Number.isFinite(nowMs)) return [];
  const generatedAt = Date.parse(facts.generatedAt);
  if (!Number.isFinite(generatedAt) || nowMs - generatedAt > MAX_AGE_MS || generatedAt > nowMs) return [];
  const events = facts.byEvent;
  const failures = facts.failures;
  if (!events || !failures || !count(facts.total) || facts.total === 0 ||
      !count(events.pull_request) || !count(events.push) || !count(failures.total) ||
      !count(failures.bindArtifact) || !count(failures.code) || !count(failures.unclassified)) return [];
  const runs = events.pull_request + events.push;
  if (runs === 0) return [];
  return [{
    id: 'ci-runs-on-prs', severity: 'attention',
    title: `CI ran ${runs} times on PRs today; Mason's order is once a day`,
    detail: `${failures.total} reds: ${failures.bindArtifact} rebase artifacts (not code), ${failures.code} code, ${failures.unclassified} unclassified. Apply the once-a-day plan: ${CI_PLAN_COMMAND} (owner change)`,
    nextStep: 'Copy the once-a-day plan command', target: 'ops',
    open: { kind: 'copy', command: CI_PLAN_COMMAND },
  }];
}
