import type { MergeBacklogReadV1 } from '../../../../core/fleet/merge-backlog-read.js';

export function backlogView(read: MergeBacklogReadV1, nowMs: number) {
  const complete = read.coverage?.complete === true;
  const dirty = read.counts.mergeState.DIRTY ?? 0;
  const hot = (read.hotFiles ?? []).filter(file => file.dirtyPrs >= 2);
  const age = (at: string | null) => {
    const ms = at === null ? NaN : Date.parse(at);
    return Number.isFinite(ms) ? ms : Infinity;
  };
  return {
    complete,
    coverageLine: complete ? null : read.coverage
      ? `Read ${read.coverage.scanned} of up to ${read.coverage.limit} records${read.coverage.discarded ? `; skipped ${read.coverage.discarded} unreadable` : ''}. Total open PRs unknown.`
      : 'This server did not report coverage. Total open PRs unknown.',
    countsLine: `${read.items.length} ${complete ? 'open PRs' : 'sampled PRs'} · ${dirty} DIRTY · ${read.counts.mergeState.BEHIND ?? 0} BEHIND · ${read.counts.mergeState.CLEAN ?? 0} CLEAN`,
    hotFilesLine: hot.length ? `Hot files: ${hot.map((file, i) => `${file.path.split('/').pop()} in ${file.dirtyPrs}${i === 0 ? ` of ${dirty} DIRTY PRs` : ''}`).join(' · ')}` : null,
    danger: complete && hot.length > 0 && hot[0]!.dirtyPrs * 2 >= dirty,
    rows: [...read.items].sort((a, b) => Number(b.mergeStateStatus === 'DIRTY') - Number(a.mergeStateStatus === 'DIRTY') || age(a.updatedAt) - age(b.updatedAt) || a.number - b.number).map(item => {
      const updated = age(item.updatedAt);
      const minutes = Number.isFinite(updated) ? Math.max(0, Math.floor((nowMs - updated) / 60_000)) : NaN;
      return { number: item.number, job: item.job, state: item.mergeStateStatus, action: item.suggestedAction,
        ageText: !Number.isFinite(minutes) ? 'age unknown' : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`,
        hotFile: item.files?.find(path => read.hotFiles?.some(file => file.path === path)) ?? null };
    }),
  };
}
