/**
 * routes/verse/leader-thread/steer-target-outcome.ts — the follow-up line the
 * Leader thread shows under a Mason entry that aimed a steer order at one job
 * (`@RQ-...`, the steer box's own mention syntax, parsed by the #4751 export).
 * Facts come from the reads the fleet views already make — the job detail
 * projection, the live workers list, the merges read and the order trace —
 * and the line never invents a result: when nothing records an outcome it
 * says "no outcome recorded yet". Pure; the tests feed the shapes.
 */
import { targetsOf } from '../fleet/interject-target-model.js';
import { clockTime } from '../leader/thread-model.js';

export type SteerTargetStage = 'merged' | 'open-pr' | 'empty' | 'failed' | 'running' | 'unknown';

export interface SteerTargetOutcome {
  /** The job id the entry named. */
  id: string;
  stage: SteerTargetStage;
  /** The follow-up sentence, id included ("RQ-X merged as #123"). */
  text: string;
  /** PR link when the stage names one. */
  href?: string;
}

/** Facts the pane already reads, looked up for the entry's first target. */
export interface SteerTargetJobFacts {
  /** Order-trace row for the job — the read the Inbox outcome chips share. */
  trace?: { state: string; url: string | null } | null;
  /** The fleet.job.v1 detail once jobDetailQuery answers. */
  detail?: { state: string; prUrl: string | null; launchedAt: string | null } | null;
  /** Live-workers evidence while the job runs; launchedAt resolved by the pane. */
  live?: { launchedAt: string | null } | null;
  /** mergesLastHour row when the job's PR merged inside the window. */
  merged?: { number: number; href: string | null } | null;
  /** publishesLastHour row while the PR is published but not seen merged. */
  pending?: { href: string | null } | null;
}

/** The `@RQ-...` id a Mason entry aims at — the steer box's own parser. */
export function steerTargetId(entryText: string): string | null {
  return targetsOf(entryText)[0] ?? null;
}

/** An https github.com/.../pull/<n> link; credentialed or off-site urls never link. */
function prLink(url: string | null | undefined): { href: string; number: number | null } | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username || parsed.password || parsed.port) return null;
    const number = /^\/[^/]+\/[^/]+\/pull\/(\d+)\/?$/.exec(parsed.pathname)?.[1];
    return { href: parsed.href, number: number === undefined ? null : Number(number) };
  } catch { return null; }
}

/**
 * One line per entry: a live run beats recorded history, then merged, then an
 * open PR, then an ended run — anything unread stays "no outcome recorded yet".
 */
export function steerTargetOutcome(entryText: string, jobFacts: SteerTargetJobFacts | null | undefined): SteerTargetOutcome | null {
  const id = steerTargetId(entryText);
  if (id === null) return null;
  const facts = jobFacts ?? {};
  const unknown: SteerTargetOutcome = { id, stage: 'unknown', text: `${id}: no outcome recorded yet` };

  if (facts.detail?.state === 'running' || facts.live) {
    const at = facts.detail?.launchedAt ?? facts.live?.launchedAt ?? null;
    const since = at ? clockTime(at) : '';
    return { id, stage: 'running', text: since ? `${id} still running (since ${since})` : `${id} still running` };
  }

  const mergedLink = prLink(facts.merged?.href) ?? prLink(facts.trace?.url) ?? prLink(facts.detail?.prUrl);
  if (facts.merged || facts.trace?.state === 'merged') {
    const number = facts.merged?.number ?? mergedLink?.number ?? null;
    return { id, stage: 'merged', text: number === null ? `${id} merged` : `${id} merged as #${number}`, ...(mergedLink ? { href: mergedLink.href } : {}) };
  }

  const openLink = prLink(facts.pending?.href) ?? prLink(facts.detail?.prUrl) ?? prLink(facts.trace?.url);
  if (facts.pending || (facts.detail?.state === 'published' && facts.detail.prUrl !== null) || (facts.trace?.state === 'published' && facts.trace.url !== null)) {
    const number = openLink?.number ?? null;
    return { id, stage: 'open-pr', text: number === null ? `${id} finished, PR open` : `${id} finished, PR #${number} open`, ...(openLink ? { href: openLink.href } : {}) };
  }

  // 'published' left in the detail means a RESULT was written but no PR shipped.
  if (facts.detail?.state === 'published') return { id, stage: 'empty', text: `${id} ended empty` };
  // 'archived' means the run was reaped without ever writing a publish result.
  if (facts.detail?.state === 'archived') return { id, stage: 'failed', text: `${id} failed: no publish result` };
  return unknown;
}
