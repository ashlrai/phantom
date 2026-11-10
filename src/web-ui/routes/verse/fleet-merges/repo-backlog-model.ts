export type RepoBacklogState = 'ok' | 'not-enrolled' | 'unavailable';

/** One enrolled repo's backlog. Counts are meaningful only when state is 'ok'. */
export interface RepoBacklog {
  repo: string;
  state: RepoBacklogState;
  open: number;
  dirty: number;
  behind: number;
  clean: number;
  /** Earliest update time among DIRTY PRs (the read carries no creation time), or null. */
  oldestDirtyAt: string | null;
}

export interface RepoBacklogRow {
  repo: string;
  state: RepoBacklogState;
  /** Null when the repo could not be read: unknown is never shown as 0. */
  open: number | null;
  dirty: number | null;
  behind: number | null;
  oldestDirtyText: string;
}

/** "5 min", "3 h", "2 d"; "—" when there is no DIRTY PR or the time is unusable. */
export function ageText(at: string | null, nowMs: number): string {
  const ms = at === null ? NaN : Date.parse(at);
  if (!Number.isFinite(ms)) return '—';
  const minutes = Math.max(0, Math.floor((nowMs - ms) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Most DIRTY first, then most open PRs; repos that could not be read sort last. */
export function repoBacklogView(repos: readonly RepoBacklog[], nowMs: number) {
  const ok = repos.filter(item => item.state === 'ok');
  const unavailable = repos.filter(item => item.state === 'unavailable').length;
  const notEnrolled = repos.filter(item => item.state === 'not-enrolled').length;
  const rank = (item: RepoBacklog) => (item.state === 'ok' ? 0 : item.state === 'unavailable' ? 1 : 2);
  const sorted = [...repos].sort((a, b) => rank(a) - rank(b)
    || (a.state === 'ok' ? b.dirty - a.dirty || b.open - a.open : 0)
    || a.repo.localeCompare(b.repo));
  const parts = [
    plural(ok.length, 'repo', 'repos'),
    `${ok.reduce((sum, item) => sum + item.open, 0)} open PRs`,
    `${ok.reduce((sum, item) => sum + item.dirty, 0)} DIRTY`,
  ];
  if (unavailable > 0) parts.push(`${plural(unavailable, 'repo', 'repos')} unavailable`);
  if (notEnrolled > 0) parts.push(`${notEnrolled} not enrolled`);
  return {
    headline: parts.join(' · '),
    rows: sorted.map((item): RepoBacklogRow => {
      const live = item.state === 'ok';
      return { repo: item.repo, state: item.state, open: live ? item.open : null, dirty: live ? item.dirty : null,
        behind: live ? item.behind : null, oldestDirtyText: live ? ageText(item.oldestDirtyAt, nowMs) : '—' };
    }),
  };
}
