import type { CiRunFactsV1 } from './fleet-ci-runs-query.js';

const MAX_AGE_MS = 2 * 60 * 60_000;
const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * The validated PR/push run counts behind the once-a-day CI Needs-you item, or
 * null when the facts are absent, stale, malformed or show no runs. Its own
 * module so the rail's badge count (VerseApp, first paint) can ask without the
 * item's copy and builder (ci-needs-you.ts) riding along.
 */
export function ciRunsToday(facts: CiRunFactsV1 | undefined, nowMs: number): { runs: number; failures: CiRunFactsV1['failures'] } | null {
  if (!facts || facts.v !== 1 || !facts.available || !Number.isFinite(nowMs)) return null;
  const generatedAt = Date.parse(facts.generatedAt);
  if (!Number.isFinite(generatedAt) || nowMs - generatedAt > MAX_AGE_MS || generatedAt > nowMs) return null;
  const events = facts.byEvent;
  const failures = facts.failures;
  if (!events || !failures || !count(facts.total) || facts.total === 0 ||
      !count(events.pull_request) || !count(events.push) || !count(failures.total) ||
      !count(failures.bindArtifact) || !count(failures.code) || !count(failures.unclassified)) return null;
  const runs = events.pull_request + events.push;
  return runs === 0 ? null : { runs, failures };
}

/** How many Needs-you items the CI facts raise: 0 or 1 (the item itself is ci-needs-you.ts). */
export function ciNeedsYouCount(facts: CiRunFactsV1 | undefined, nowMs: number): number {
  return ciRunsToday(facts, nowMs) ? 1 : 0;
}
