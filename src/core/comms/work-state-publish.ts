/**
 * Publish gate for fleet work-state threads (pure, no I/O, no clock).
 *
 * Decides whether a freshly computed WorkStateVerdict is worth posting to a
 * Slack/iMessage task thread compared with the verdict that was posted there
 * last. Heartbeats, asOf-only drift and reason reorderings stay quiet; state
 * transitions, blocker edits, artifact changes and staleness onset post.
 */

import type { WorkState, WorkStateVerdict } from './work-state-contract.js';

export interface PublishDecision {
  publish: boolean;
  reason: string;
}

const BLOCKED_PREFIX = 'blocked: ';

/**
 * Extracts the blocker text from a verdict's `blocked: <text>` reason entry,
 * trimmed. Undefined when the verdict carries no such entry.
 */
function blockerText(v: WorkStateVerdict): string | undefined {
  const entry = v.reasons.find((r) => r.startsWith(BLOCKED_PREFIX));
  return entry === undefined ? undefined : entry.slice(BLOCKED_PREFIX.length).trim();
}

/** The quiet verdict: nothing about the work state meaningfully moved. */
function noChange(state: WorkState): PublishDecision {
  return { publish: false, reason: `no meaningful change (${state})` };
}

export function decideWorkStatePublish(
  previous: WorkStateVerdict | undefined,
  next: WorkStateVerdict,
): PublishDecision {
  // 1. Nothing was posted to the thread yet: the first verdict always opens it.
  if (previous === undefined) {
    return { publish: true, reason: `first state ${next.state}` };
  }

  // 2. Any state transition is meaningful, including moves backwards
  //    (e.g. RUNNING -> ASSIGNED after live evidence lapsed).
  if (next.state !== previous.state) {
    return { publish: true, reason: `${previous.state} -> ${next.state}` };
  }

  // 3. Same-state BLOCKED whose blocker text changed.
  if (next.state === 'BLOCKED' && blockerText(next) !== blockerText(previous)) {
    return { publish: true, reason: 'blocker changed' };
  }

  // 4. Same-state VERIFIED pointing at a different artifact (another PR or head).
  if (next.state === 'VERIFIED' && next.reasons[0] !== previous.reasons[0]) {
    return { publish: true, reason: 'artifact changed' };
  }

  // 5. Live evidence just went stale. Recovering staleness with the same state
  //    is not news; that case falls through to the quiet verdict.
  if (next.stale && !previous.stale) {
    return { publish: true, reason: 'live evidence went stale' };
  }

  // 6. RUNNING heartbeats, asOf-only changes, reason reorderings.
  return noChange(next.state);
}
