import { useState } from 'react';
import { Button, SkeletonLine, StatusBadge } from '../../../components/primitives/index.js';
import { getQuerySnapshot } from '../../../data/cache.js';
import { DispatchDisabledError, readFailureReason } from '../../../data/client.js';
import { useMutationHold, useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import { releasePrQuery, type ReleasePr } from '../fleet/release-pr-query.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { installedDesktopVersion } from '../sections/app-version.js';
import { compareReleaseTags, releaseGapText, releaseNotesUrl } from '../sections/release-gap-model.js';
import { UpdateNowButton } from '../sections/UpdateNowButton.js';
import { updateStatusQuery } from '../sections/update-status-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { orderRepos, releaseLabel, releasePrMergeBlocker, runTone, safeRepoHref } from './fleet-releases-model.js';
import { opsReleasesQuery, postReleasePrMerge } from './fleet-releases-queries.js';
import { pollingDue, postMergeLine, readyVersion, type MergeNotice } from './post-merge-update-model.js';
import { blockerLine, releasePrRows, releaseTellPrefill } from './release-pr-view-model.js';
import styles from './fleet-releases.module.css';

function installedReleaseLine(installed: string | null, tag: string | null) {
  if (installed === null) return 'Installed version unknown';
  if (tag === null) return `This Mac runs v${installed} · no release yet`;
  const view = compareReleaseTags(installed, tag);
  const status = view.state === 'latest' ? 'up to date'
    : view.state === 'behind' ? `behind by ${releaseGapText(view)}`
    : view.state === 'ahead' ? 'ahead of the newest tag (dev build)'
    : releaseGapText(view);
  return <>This Mac runs v{installed} · latest {tag} · {status} · <a href={releaseNotesUrl(tag)} target="_blank" rel="noopener noreferrer">Release notes</a></>;
}

function MergeReleasePrButton({ repo, pr, onDone }: { repo: string; pr: ReleasePr; onDone: (notice: MergeNotice) => void }) {
  const hold = useMutationHold();
  const [busy, setBusy] = useState(false);
  const blocker = releasePrMergeBlocker(pr);
  async function merge() {
    if (!hold.token || busy) return;
    setBusy(true);
    try {
      const result = await postReleasePrMerge(repo, pr.number, hold.token);
      onDone({ number: pr.number, label: result.sha ? `Merged ${result.sha.slice(0, 7)}` : `Merged PR #${pr.number}`, mergedAt: Date.now() });
    } catch (reason) {
      onDone({ number: null, label: reason instanceof DispatchDisabledError ? reason.message : readFailureReason(reason), mergedAt: null });
    } finally { setBusy(false); }
  }
  return <Button size="sm" disabled={blocker !== null || !hold.hasHold} busy={busy} title={blocker ?? undefined} onClick={() => void merge()}>{busy ? 'Merging…' : 'Merge release PR'}</Button>;
}

export function FleetReleasesPane({ visible }: PaneProps) {
  const read = useQuery(opsReleasesQuery, { enabled: visible, freshMs: 0 });
  const prRead = useQuery(releasePrQuery, { enabled: visible });
  const refetch = useRefetch(opsReleasesQuery);
  const refetchPr = useRefetch(releasePrQuery);
  const [mergeNotices, setMergeNotices] = useState<Record<string, MergeNotice>>({});
  const [now, setNow] = useState(() => Date.now());
  const phantomNotice = Object.entries(mergeNotices).find(([name]) => name === 'phantom' || name.endsWith('/phantom'))?.[1];
  const updateRead = useQuery(updateStatusQuery, { enabled: visible && pollingDue(phantomNotice, Date.now()), freshMs: 0 });
  const updateStatus = updateRead.data ?? (phantomNotice ? getQuerySnapshot<Awaited<ReturnType<typeof updateStatusQuery.fetch>>>(updateStatusQuery.key).data : undefined);
  const refetchUpdate = useRefetch(updateStatusQuery);
  usePollWhileVisible(refetch, 60_000, { enabled: visible });
  usePollWhileVisible(refetchPr, 60_000, { enabled: visible });
  usePollWhileVisible(() => {
    const current = Date.now();
    setNow(current);
    if (pollingDue(phantomNotice, current)) refetchUpdate();
  }, 60_000, { enabled: visible && pollingDue(phantomNotice, Date.now()) });

  if (read.data === null) return <p className={styles.message}>Releases not in this build</p>;
  if (read.data === undefined) return <div className={styles.root} role="status">{read.status === 'error' ? 'Releases are unavailable.' : <><span>Reading releases…</span><SkeletonLine /><SkeletonLine /></>}</div>;
  const data = read.data;
  const installed = installedDesktopVersion();
  const prRows = releasePrRows(prRead.status === 'error' ? undefined : prRead.data, Date.now());
  return <section className={styles.root} aria-label="Release train">
    <p className={styles.header}>{data.repos.length} repos · read {formatRelative(data.generatedAt)}</p>
    {data.sourceState !== 'healthy' && <p className={styles.notice} role="status">Release data may be incomplete.</p>}
    {prRead.status === 'error' && <p className={styles.notice} role="status">Release PR state is unavailable.</p>}
    {prRead.status !== 'error' && prRead.data?.kind === 'available' && prRead.data.data.sourceState === 'degraded' && <p className={styles.notice} role="status">GitHub unreachable, showing the last answer.</p>}
    {read.status === 'error' && <p className={styles.notice} role="status">Releases could not refresh. Showing the last reading.</p>}
    <ul className={styles.list} aria-label="Releases">{orderRepos(data.repos).map((repo, index) => {
      const href = safeRepoHref(repo.repo);
      const release = repo.gh?.latestRelease ? releaseLabel(repo.gh.latestRelease) : null;
      const run = repo.gh?.latestRun;
      const name = repo.repo.toLowerCase();
      const pr = prRows.get(name);
      const line = pr && 'checks' in pr ? blockerLine(pr) : null;
      const prRepoRow = prRead.data?.kind === 'available'
        ? prRead.data.data.repos.find(row => row.repo.toLowerCase() === name) : undefined;
      const releasePr = prRepoRow?.pr ?? null;
      const prNumber = releasePr?.number;
      const prNotes = pr && 'notes' in pr ? pr.notes : prRepoRow?.notes ?? [];
      const tone = run ? runTone(run) : 'neutral';
      const phantom = name === 'phantom' || name.endsWith('/phantom');
      const mergeNotice = mergeNotices[name];
      const updateLine = phantom ? postMergeLine(mergeNotice, updateStatus, now) : null;
      const candidate = readyVersion(updateStatus);
      return <li key={`${repo.repo}:${index}`} className={styles.row}>
        <div>{href ? <a href={href} target="_blank" rel="noopener noreferrer">{repo.repo}</a> : <span>{repo.repo}</span>}</div>
        <div>Version: {repo.version ?? '—'} · Tag: {repo.latestTag ?? '—'}</div>
        {phantom && <div>{installedReleaseLine(installed, repo.gh?.latestRelease?.tag ?? repo.latestTag)}</div>}
        {pr && <div className={styles.prBlock}>
          <div className={styles.headline} data-tone={pr.tone}>{'href' in pr && pr.href ? <a href={pr.href} target="_blank" rel="noopener noreferrer">{pr.headline}</a> : pr.headline}</div>
          {line && <><div role="status">{line}</div>{prNumber !== undefined && <Button size="sm" onClick={() => openInterjectDialog({ prefill: releaseTellPrefill(repo.repo, prNumber, line) })}>Tell the leaders</Button>}</>}
          {'checks' in pr && pr.checks.length > 0 && <div className={styles.checks} aria-label="Release PR checks">{pr.checks.map((check, checkIndex) => {
            const label = `${check.name} · ${check.state}`;
            const className = `${styles.chip} ${styles[check.state]}`;
            return check.href ? <a key={checkIndex} className={className} href={check.href} target="_blank" rel="noopener noreferrer">{label}</a> : <span key={checkIndex} className={className}>{label}</span>;
          })}</div>}
          {prNotes.length > 0 && <ul className={styles.notes}>{prNotes.map((note, noteIndex) => <li key={noteIndex}>{note}</li>)}</ul>}
          {releasePr && <MergeReleasePrButton repo={repo.repo} pr={releasePr} onDone={(notice) => {
            setMergeNotices(prev => ({ ...prev, [name]: notice }));
            setNow(Date.now());
            if (notice.number !== null) refetchPr();
          }} />}
          {mergeNotice && (mergeNotice.number === null || releasePr === null || releasePr.number === mergeNotice.number)
            && <div role="status">{mergeNotice.label}</div>}
        </div>}
        {updateLine && <div role="status">{updateLine}{candidate && updateLine.startsWith(`${candidate} is ready`)
          && <UpdateNowButton status={updateStatus} onDone={refetchUpdate} />}</div>}
        <div>{repo.commitsSinceTag == null ? 'Commits since tag: unknown' : `${repo.commitsSinceTag} commits since ${repo.latestTag ?? 'unknown tag'}`}</div>
        {repo.gh === null ? <div className={styles.muted}>GitHub status unknown (gh offline)</div> : <>
          <div>Release: {release ? <>{release.label}{release.badge && <> <StatusBadge status={release.badge} tone="warning" /></>} · {formatRelative(repo.gh.latestRelease?.publishedAt)}</> : '—'}</div>
          <div>Run: {run ? <>{run.workflow} · <StatusBadge status={run.status} tone={tone === 'ok' ? 'success' : tone === 'warn' ? 'warning' : tone}>{run.status}{run.conclusion ? `/${run.conclusion}` : ''}</StatusBadge> · {formatRelative(run.at)}</> : '—'}</div>
        </>}
        {repo.notes.map((note, noteIndex) => <div key={noteIndex} className={styles.muted}>{note}</div>)}
      </li>;
    })}</ul>
  </section>;
}
