export interface MergeAgePr {
  number: number;
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  reviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED';
}
export interface MergeAgeEntry {
  number: number;
  enteredAt?: string;
  requiredChecks?: { name: string; status: 'success' | 'pending' | 'failure' | 'missing' }[];
}
export interface MergeAgeInput { prs: MergeAgePr[]; queue: MergeAgeEntry[] }

/** Snapshot evidence only. Passing checks never authorize a merge or queue bypass. */
export function mergeAge(input: MergeAgeInput, now = Date.now()) {
  if (!Number.isFinite(now)) throw new Error('Invalid observation time');
  const entries = input.queue.map(entry => {
    const matches = input.prs.filter(pr => pr.number === entry.number);
    const pr = matches.length === 1 ? matches[0] : undefined;
    const at = typeof entry.enteredAt === 'string' ? Date.parse(entry.enteredAt) : NaN;
    const ageSeconds = Number.isFinite(at) && at <= now ? (now - at) / 1000 : null;
    const causes: { code: string; action: string }[] = [];
    if (pr?.mergeable === 'CONFLICTING') causes.push({ code: 'conflicts', action: 'Resolve conflicts and let required checks run again.' });
    if (pr?.reviewDecision === 'CHANGES_REQUESTED' || pr?.reviewDecision === 'REVIEW_REQUIRED') {
      causes.push({ code: 'review', action: 'Address review feedback and obtain required approval.' });
    }
    const blocked = entry.requiredChecks?.filter(check => check.status !== 'success') ?? [];
    for (const check of blocked) causes.push({ code: `check_${check.status}`, action: check.status === 'failure'
      ? `Fix required check ${check.name}; rerun it through the merge queue.`
      : `Inspect required check ${check.name} and its merge-group workflow.` });
    const missingData = [
      ...(!pr ? ['pull_request'] : []),
      ...(!pr?.mergeable || pr.mergeable === 'UNKNOWN' ? ['mergeability'] : []),
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
