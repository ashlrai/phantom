/**
 * RQ-MERGEQ-BATCH-1: merged PRs per UTC day per repo, measured from the
 * default branch's first-parent history (no network, no provider counts).
 *
 * A first-parent commit counts as a merged PR when its subject carries the
 * GitHub squash suffix `(#N)` or the merge-commit prefix
 * `Merge pull request #N`. A row is `verified` only when all of these hold:
 *
 *  - complete: the ref tip was committed at or after the end of the day, so
 *    no later merge can still land inside it (the default branch only moves
 *    forward and queue/squash merges stamp the committer date at merge time);
 *  - ordered: committer dates along the walked first-parent range never
 *    increase going back in history, so the day window is a contiguous slice;
 *  - unique: no PR number appears twice in the day.
 *
 * Anything else still yields a row, with `verified: false` and the failed
 * checks named, so an unverified number is never mistaken for a measured one.
 */

const MERGED_PER_DAY_SCHEMA = 'fleet.merged-per-day.v1' as const;
const DAY_MS = 24 * 60 * 60 * 1000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface FirstParentCommit {
  sha: string;
  /** Committer date, ISO-8601. */
  committedAt: string;
  subject: string;
}

export interface MergedPerDayRow {
  v: 1;
  schema: 'fleet.merged-per-day.v1';
  repo: string;
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  merged: number;
  /** First-parent commits in the day that name no PR (direct pushes). */
  direct: number;
  verified: boolean;
  /** Names of failed verification checks; empty when verified. */
  unverifiedBecause: string[];
  source: 'git-first-parent';
  ref: string;
  tipSha: string;
  tipCommittedAt: string;
  /** Lowest and highest PR number merged that day, for spot checks. */
  prRange: [number, number] | null;
  measuredAt: string;
}

/** PR number a first-parent subject names, or null for a direct commit. */
export function mergedPrNumber(subject: string): number | null {
  const squash = /\(#([1-9]\d{0,9})\)\s*$/.exec(subject);
  const merge = /^Merge pull request #([1-9]\d{0,9}) /.exec(subject);
  const raw = squash?.[1] ?? merge?.[1];
  return raw === undefined ? null : Number(raw);
}

export function dayBounds(day: string): { start: number; end: number } {
  const start = Date.parse(`${day}T00:00:00Z`);
  if (!DAY.test(day) || !Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== day) {
    throw new Error('day must be a real YYYY-MM-DD date');
  }
  return { start, end: start + DAY_MS };
}

/** Latest UTC day the tip proves complete: the day before the tip's own day. */
export function latestCompleteDay(tipCommittedAt: string): string {
  const at = Date.parse(tipCommittedAt);
  if (!Number.isFinite(at)) throw new Error('tip date is not a date');
  return new Date(at - DAY_MS).toISOString().slice(0, 10);
}

/**
 * Count one day. `commits` is first-parent order from the tip backwards and
 * must reach past the start of the day (the caller asks git for one extra day).
 */
export function measureMergedPerDay(input: {
  repo: string;
  ref: string;
  day: string;
  commits: readonly FirstParentCommit[];
  measuredAt: string;
}): MergedPerDayRow {
  const { start, end } = dayBounds(input.day);
  const tip = input.commits[0];
  if (tip === undefined) throw new Error('no commits on ref');
  const reasons: string[] = [];
  const tipAt = Date.parse(tip.committedAt);
  if (!(tipAt >= end)) reasons.push('day-incomplete');

  const prs = new Set<number>();
  let duplicate = false;
  let direct = 0;
  let previous = Number.POSITIVE_INFINITY;
  let ordered = true;
  let reachedStart = false;
  for (const commit of input.commits) {
    const at = Date.parse(commit.committedAt);
    if (!Number.isFinite(at) || at > previous) ordered = false;
    previous = Number.isFinite(at) ? at : previous;
    if (at < start) { reachedStart = true; break; }
    if (at >= end) continue;
    const number = mergedPrNumber(commit.subject);
    if (number === null) direct++;
    else if (prs.has(number)) duplicate = true;
    else prs.add(number);
  }
  if (!ordered) reasons.push('dates-not-monotonic');
  if (duplicate) reasons.push('duplicate-pr');
  if (!reachedStart) reasons.push('history-short');
  const numbers = [...prs].sort((a, b) => a - b);
  return {
    v: 1,
    schema: MERGED_PER_DAY_SCHEMA,
    repo: input.repo,
    day: input.day,
    merged: prs.size,
    direct,
    verified: reasons.length === 0,
    unverifiedBecause: reasons,
    source: 'git-first-parent',
    ref: input.ref,
    tipSha: tip.sha,
    tipCommittedAt: tip.committedAt,
    prRange: numbers.length === 0 ? null : [numbers[0]!, numbers[numbers.length - 1]!],
    measuredAt: input.measuredAt,
  };
}

/**
 * Lines to append to the metrics JSONL. A (repo, day) pair that already has a
 * verified row is never written again; an unverified row may be superseded by
 * a verified one later (readers take the last verified row per pair).
 * Malformed existing lines throw: the file is append-only evidence.
 */
export function metricsAppend(existing: string, rows: readonly MergedPerDayRow[]): string[] {
  const verified = new Set<string>();
  for (const line of existing.split('\n')) {
    if (!line.trim()) continue;
    let row: Partial<MergedPerDayRow>;
    try { row = JSON.parse(line) as Partial<MergedPerDayRow>; } catch { throw new Error('metrics line is not JSON'); }
    if (row.schema === MERGED_PER_DAY_SCHEMA && row.verified === true) verified.add(`${row.repo}@${row.day}`);
  }
  const out: string[] = [];
  for (const row of rows) {
    const key = `${row.repo}@${row.day}`;
    if (verified.has(key)) continue;
    if (row.verified) verified.add(key);
    out.push(`${JSON.stringify(row)}\n`);
  }
  return out;
}
