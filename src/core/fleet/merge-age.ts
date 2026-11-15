export interface MergeAgeCheck {
  name: string;
  status: 'success' | 'pending' | 'failure' | 'missing';
  /** When the check reached this status; absent stays unknown. */
  at?: string;
}
export interface MergeAgePr {
  number: number;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
  /** GitHub's mergeStateStatus (any case): DIRTY conflicts, BEHIND is a stale branch. */
  mergeStateStatus?: string;
  /** Last update on the pull request — best evidence of when its state blockers surfaced. */
  updatedAt?: string;
  /** Head commit sha; the identity an idempotent recut is keyed on. */
  headSha?: string;
  /** Repo slug (owner/name) for the recut key; the snapshot's repo is the fallback. */
  repo?: string;
  /** Recut requests already recorded for this pull request. */
  recutRequests?: number;
  /** Head an earlier recut request already covers. */
  lastRecutHead?: string;
}
export interface MergeAgeEntry {
  number: number;
  enteredAt?: string;
  requiredChecks?: MergeAgeCheck[];
}
export interface MergeAgeInput {
  prs: MergeAgePr[];
  queue: MergeAgeEntry[];
  /** Default repo slug for recut keys when a PR row does not carry one. */
  repo?: string;
}

export interface MergeAgeCause {
  code: string;
  action: string;
  /** The earliest evidence time for this blocker; null when the snapshot carries none. */
  since: string | null;
}

/** A timestamp usable as blocker evidence; unparseable or future values stay unknown. */
const since = (value: string | undefined, now: number): string | null => {
  if (typeof value !== 'string') return null;
  const at = Date.parse(value);
  return Number.isFinite(at) && at <= now ? value : null;
};

/** A merge conflict by either GitHub signal — mergeable CONFLICTING or mergeStateStatus DIRTY. */
export const conflicted = (pr: MergeAgePr | undefined): boolean =>
  pr?.mergeable === 'CONFLICTING' || pr?.mergeStateStatus?.toUpperCase() === 'DIRTY';

/** A stale branch: the base moved ahead of the head (mergeStateStatus BEHIND). */
export const stale = (pr: MergeAgePr | undefined): boolean =>
  pr?.mergeStateStatus?.toUpperCase() === 'BEHIND';

/** Mergeability is known when either GitHub signal carries a verdict. */
const mergeabilityKnown = (pr: MergeAgePr | undefined): boolean =>
  !!pr && (pr.mergeable === 'MERGEABLE' || pr.mergeable === 'CONFLICTING'
    || (typeof pr.mergeStateStatus === 'string' && pr.mergeStateStatus !== '' && pr.mergeStateStatus.toUpperCase() !== 'UNKNOWN'));

/** Snapshot evidence only. Passing checks never authorize a merge or queue bypass. */
export function mergeAge(input: MergeAgeInput, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid observation time');
  const entries = input.queue.map(entry => {
    const matches = input.prs.filter(pr => pr.number === entry.number);
    const pr = matches.length === 1 ? matches[0] : undefined;
    const at = typeof entry.enteredAt === 'string' ? Date.parse(entry.enteredAt) : NaN;
    const ageSeconds = Number.isFinite(at) && at <= now ? (now - at) / 1000 : null;
    const entrySince = Number.isFinite(at) && at <= now ? entry.enteredAt! : null;
    const prSince = since(pr?.updatedAt, now);
    const causes: MergeAgeCause[] = [];
    if (conflicted(pr)) causes.push({ code: 'conflicts', since: prSince,
      action: 'Resolve conflicts and let required checks run again.' });
    if (stale(pr)) causes.push({ code: 'stale', since: prSince,
      action: 'Update the branch against its base; required checks run again on the new head.' });
    if (pr?.reviewDecision === 'CHANGES_REQUESTED' || pr?.reviewDecision === 'REVIEW_REQUIRED') {
      causes.push({ code: 'review', since: prSince,
        action: 'Address review feedback and obtain required approval.' });
    }
    const blocked = entry.requiredChecks?.filter(check => check.status !== 'success') ?? [];
    for (const check of blocked) causes.push({ code: `check_${check.status}`, since: since(check.at, now) ?? entrySince,
      action: check.status === 'failure'
      ? `Fix required check ${check.name}; rerun it through the merge queue.`
      : `Inspect required check ${check.name} and its merge-group workflow.` });
    const missingData = [
      ...(!pr ? ['pull_request'] : []),
      ...(!mergeabilityKnown(pr) ? ['mergeability'] : []),
      ...(!pr?.reviewDecision ? ['review'] : []),
      ...(!entry.requiredChecks ? ['required_checks'] : []),
      ...(ageSeconds === null ? ['entered_at'] : []),
      ...(input.queue.filter(row => row.number === entry.number).length > 1 ? ['unique_queue_entry'] : []),
    ];
    return { number: entry.number, ageSeconds, causes, missingData,
      requiredChecks: entry.requiredChecks?.map(check => ({ ...check })) ?? null };
  }).sort((a, b) => (b.ageSeconds ?? -1) - (a.ageSeconds ?? -1) || a.number - b.number);
  return { schema: 'fleet.merge-age.v1', readOnly: true, requiredChecksPreserved: true,
    observedAt: new Date(now).toISOString(), entries,
    oldestActionable: entries.find(entry => entry.ageSeconds !== null && !entry.missingData.includes('unique_queue_entry') && entry.causes.length) ?? null };
}
