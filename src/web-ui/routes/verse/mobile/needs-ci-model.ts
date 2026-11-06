import type { NeedsYouItem } from '../../../../core/verse/workbench-types.js';

/** The fields of CiRunFactsV1 used by the mobile Needs-you card. */
export interface CiRunFactsV1 {
  v: 1;
  generatedAt: string;
  repo: string | null;
  available: boolean;
  byEvent: { pull_request: number };
  failures: { total: number; bindArtifact: number; code: number };
}

/** A fresh CI summary is informational and cannot be acted on from the phone. */
export function ciNeedsItem(facts: CiRunFactsV1 | undefined, nowMs: number): NeedsYouItem | null {
  if (!facts?.available || facts.byEvent.pull_request === 0) return null;
  const generated = Date.parse(facts.generatedAt);
  if (!Number.isFinite(generated) || !Number.isFinite(nowMs) || generated > nowMs || nowMs - generated > 2 * 60 * 60_000) return null;
  return {
    id: 'fleet:owner-hold:ci-runs',
    source: 'fleet',
    kind: 'owner-hold',
    severity: 'warn',
    title: `CI ran ${facts.byEvent.pull_request} times on PRs today`,
    detail: `${facts.failures.total} reds: ${facts.failures.bindArtifact} rebase artifacts (not code), ${facts.failures.code} code\nOrder: once a day. On the Mac: ashlr fleet ci-plan --patch | git apply`,
    since: facts.generatedAt,
    expiresAt: null,
    subject: { repo: facts.repo, pr: null, seatId: null, sessionId: null, engine: null },
    target: { kind: 'section', section: 'fleet', anchor: null },
    actions: [],
  };
}
