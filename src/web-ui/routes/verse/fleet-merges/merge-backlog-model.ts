import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';

const reasons = new Map<string, string>([
  ['merge-conflict', 'GitHub reports a merge conflict.'],
  ['required-check-failed', 'The fleet reports a required check failed.'],
  ['base-moved', 'The pull request is behind its base branch.'],
  ['head-moved', 'The pull request head moved since the fleet verified it.'],
  ['draft', 'The pull request is a draft.'],
  ['checks-pending', 'Checks are still pending.'],
  ['checks-none', 'No checks were reported.'],
  ['checks-green', 'The fleet reports green checks.'],
  ['github-computing', 'GitHub has not finished computing mergeability.'],
  ['blocked-non-check', 'GitHub reports a block outside the observed checks.'],
]);
const actions = new Map<string, string>([
  ['merge', 'Review the current head in GitHub.'],
  ['recut', 'Review a conflict recut in Outcomes.'],
  ['refresh', 'Review whether the branch needs a base refresh.'],
  ['wait', 'Wait for the next check or mergeability reading.'],
  ['none', 'No action suggested.'],
]);

export function blockerEvidence(reason: unknown, action: unknown) {
  return {
    reason: typeof reason === 'string' ? reasons.get(reason) ?? 'Reason unknown in this snapshot.' : 'Reason unknown in this snapshot.',
    action: typeof action === 'string' ? actions.get(action) ?? 'Next step unknown.' : 'Next step unknown.',
  };
}

export function backlogView(read: MergeBacklogReadV1, nowMs: number) {
  const dirty = read.counts.mergeState.DIRTY ?? 0;
  const hot = (read.hotFiles ?? []).filter(file => file.dirtyPrs >= 2);
  const age = (at: string | null) => {
    const ms = at === null ? NaN : Date.parse(at);
    return Number.isFinite(ms) ? ms : Infinity;
  };
  return {
    countsLine: `${read.items.length} open PRs · ${dirty} DIRTY · ${read.counts.mergeState.BEHIND ?? 0} BEHIND · ${read.counts.mergeState.CLEAN ?? 0} CLEAN`,
    hotFilesLine: hot.length ? `Hot files: ${hot.map((file, i) => `${file.path.split('/').pop()} in ${file.dirtyPrs}${i === 0 ? ` of ${dirty} DIRTY PRs` : ''}`).join(' · ')}` : null,
    danger: hot.length > 0 && hot[0]!.dirtyPrs * 2 >= dirty,
    rows: [...read.items].sort((a, b) => Number(b.mergeStateStatus === 'DIRTY') - Number(a.mergeStateStatus === 'DIRTY') || age(a.updatedAt) - age(b.updatedAt) || a.number - b.number).map(item => {
      const updated = age(item.updatedAt);
      const minutes = Number.isFinite(updated) ? Math.max(0, Math.floor((nowMs - updated) / 60_000)) : NaN;
      return { number: item.number, job: item.job, state: item.mergeStateStatus, action: item.suggestedAction, reason: item.classification?.reason,
        ageText: !Number.isFinite(minutes) ? 'age unknown' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`,
        hotFile: item.files?.find(path => read.hotFiles?.some(file => file.path === path)) ?? null };
    }),
  };
}
