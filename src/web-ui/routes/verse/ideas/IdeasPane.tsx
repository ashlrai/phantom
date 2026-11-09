/**
 * routes/verse/ideas/IdeasPane.tsx: what the fleet will pick next. A read-only
 * view of the ranked backlog (`GET /api/backlog`, via the same query the
 * Autonomy panel uses), grouped by repo, each row saying where it came from.
 * Backlog text is untrusted, so it renders as plain text only.
 */
import { Fragment, useId, useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Card, CardNote } from '../command/Surface.js';
import { verseBacklogQuery } from '../autonomy/control-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { groupByRepo, ideasHeadline, rankIdeas, sourceCounts, type RepoGroup } from './ideas-model.js';
import styles from './ideas.module.css';

export const IDEAS_POLL_MS = 30_000;
const PER_REPO = 5;

export function IdeasPane({ visible = true }: { visible?: boolean }) {
  const backlog = useQuery(verseBacklogQuery, { enabled: visible, freshMs: IDEAS_POLL_MS });
  const refetch = useRefetch(verseBacklogQuery);
  usePollWhileVisible(() => { refetch(); }, IDEAS_POLL_MS, { enabled: visible });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => rankIdeas(backlog.data?.items ?? []), [backlog.data]);
  const full = useMemo(() => groupByRepo(rows, Number.MAX_SAFE_INTEGER), [rows]);
  const groups = useMemo(() => groupByRepo(rows, PER_REPO), [rows]);
  const { counts, nudge } = useMemo(() => sourceCounts(rows), [rows]);

  const toggle = (repo: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(repo)) next.add(repo);
    return next;
  });

  let body;
  if (backlog.data === undefined && backlog.status === 'error') {
    body = <CardNote tone="danger">{backlog.error?.message ?? 'Could not read the backlog.'}</CardNote>;
  } else if (backlog.data === undefined) {
    body = <CardNote>Loading ideas…</CardNote>;
  } else if (backlog.data.absent) {
    body = <CardNote>No backlog has been built yet. Run <code>ashlr backlog</code> or one tick from Controls.</CardNote>;
  } else if (rows.length === 0) {
    body = <CardNote>The backlog is empty, so a tick idles. Enroll another repository in Scope, or add a goal, to give it work.</CardNote>;
  } else {
    body = <>
      <p className={styles.headline}>{ideasHeadline(rows)}</p>
      {nudge ? <CardNote tone="unknown">{nudge}</CardNote> : null}
      <p className={styles.sources}>
        {counts.map(({ source, count }, i) => <Fragment key={source}>{i ? ' · ' : ''}{source} {count}</Fragment>)}
      </p>
      <div className={styles.groups}>
        {groups.map((group, i) => <RepoCard key={group.repo} group={group} all={full[i]!} expanded={open.has(group.repo)} onToggle={() => toggle(group.repo)} />)}
      </div>
    </>;
  }

  return <div className={styles.root} aria-label="Ideas">{body}</div>;
}

function RepoCard({ group, all, expanded, onToggle }: { group: RepoGroup; all: RepoGroup; expanded: boolean; onToggle: () => void }) {
  const listId = useId();
  const shown = expanded ? all.rows : group.rows;
  return (
    <Card title={group.repo} caption={`${all.rows.length} candidate${all.rows.length === 1 ? '' : 's'}`}>
      <ol className={styles.list} id={listId}>
        {shown.map(row => <li key={row.key} className={styles.row}>
          <span className={styles.title}>{row.title}</span>
          <span className={styles.meta}>{row.scoreText} · {row.source}</span>
        </li>)}
      </ol>
      {group.more > 0 ? <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
        {expanded ? 'Show fewer' : `Show ${group.more} more`}
      </button> : null}
    </Card>
  );
}
