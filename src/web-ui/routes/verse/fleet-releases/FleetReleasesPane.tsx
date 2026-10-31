import { SkeletonLine, StatusBadge } from '../../../components/primitives/index.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { orderRepos, releaseLabel, runTone, safeRepoHref } from './fleet-releases-model.js';
import { opsReleasesQuery } from './fleet-releases-queries.js';
import styles from './fleet-releases.module.css';

export function FleetReleasesPane({ visible }: PaneProps) {
  const read = useQuery(opsReleasesQuery, { enabled: visible, freshMs: 0 });
  const refetch = useRefetch(opsReleasesQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });

  if (read.data === null) return <p className={styles.message}>Releases not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Releases are unavailable.' : <><span>Reading releases…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  const data = read.data;
  return <section className={styles.root} aria-label="Release train">
    <p className={styles.header}>{data.repos.length} repos · read {formatRelative(data.generatedAt)}</p>
    {data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Release data may be incomplete.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Releases could not refresh. Showing the last reading.</p>}
    <ul className={styles.list} aria-label="Releases">{orderRepos(data.repos).map((repo, index) => {
      const href = safeRepoHref(repo.repo);
      const release = repo.gh?.latestRelease ? releaseLabel(repo.gh.latestRelease) : null;
      const run = repo.gh?.latestRun;
      const tone = run ? runTone(run) : 'neutral';
      return <li key={`${repo.repo}:${index}`} className={styles.row}>
        <div>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{repo.repo}</a> : <span>{repo.repo}</span>}</div>
        <div>Version: {repo.version ?? '—'} · Tag: {repo.latestTag ?? '—'}</div>
        {repo.gh === null ? <div className={styles.muted}>GitHub status unknown (gh offline)</div> : <>
          <div>Release: {release ? <>{release.label}{release.badge && <> <StatusBadge status={release.badge} tone="warning" /></>} · {formatRelative(repo.gh.latestRelease?.publishedAt)}</> : '—'}</div>
          <div>Run: {run ? <>{run.workflow} · <StatusBadge status={run.status} tone={tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : tone}>{run.status}{run.conclusion ? `/${run.conclusion}` : ''}</StatusBadge> · {formatRelative(run.at)}</> : '—'}</div>
        </>}
        {repo.notes.map((note, noteIndex) => <div key={noteIndex} className={styles.muted}>{note}</div>)}
      </li>;
    })}</ul>
  </section>;
}
