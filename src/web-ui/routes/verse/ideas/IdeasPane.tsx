/**
 * routes/verse/ideas/IdeasPane.tsx: what the fleet will pick next. A
 * view of the ranked backlog (`GET /api/backlog`, via the same query the
 * Autonomy panel uses), grouped by repo, each row saying where it came from.
 * Each row can be sent to the Leader as "Do next" / "Not now" (IdeaSteer).
 * Backlog text is untrusted, so it renders as plain text only. Each idea can
 * be drafted as a job ("Draft job"), or several together ("Draft together");
 * the draft id and its collision check show beside the idea.
 */
import { Fragment, useId, useMemo, useState } from 'react';
import { openDockPane } from '../dock/dock-store.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { Card, CardNote } from '../command/Surface.js';
import { verseBacklogQuery } from '../autonomy/control-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { groupByRepo, ideasHeadline, rankIdeas, sourceCounts, type RepoGroup } from './ideas-model.js';
import { IdeaDraftChip, postIdeasDraft, type IdeaDraftState } from './IdeaDraftChip.js';
import { IdeaSteer } from './IdeaSteer.js';
import styles from './ideas.module.css';

export const IDEAS_POLL_MS = 30_000;
const PER_REPO = 5;
const DRAFT_MAX = 8;

export function IdeasPane({ visible = true }: { visible?: boolean }) {
  const backlog = useQuery(verseBacklogQuery, { enabled: visible, freshMs: IDEAS_POLL_MS });
  const refetch = useRefetch(verseBacklogQuery);
  usePollWhileVisible(() => { refetch(); }, IDEAS_POLL_MS, { enabled: visible });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, IdeaDraftState>>(new Map());
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => rankIdeas(backlog.data?.items ?? []), [backlog.data]);
  const full = useMemo(() => groupByRepo(rows, Number.MAX_SAFE_INTEGER), [rows]);
  const groups = useMemo(() => groupByRepo(rows, PER_REPO), [rows]);
  const { counts, nudge } = useMemo(() => sourceCounts(rows), [rows]);

  const toggle = (repo: string) => setOpen(prev => {
    const next = new Set(prev);
    if (!next.delete(repo)) next.add(repo);
    return next;
  });

  const togglePick = (id: string) => setPicked(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  // One request per idea set; the answer (or the error) shows beside every idea in it.
  const draft = async (ids: readonly string[], confirm = false) => {
    setBusy(true);
    let state: IdeaDraftState;
    try { state = await postIdeasDraft(ids, confirm); }
    catch (err) { state = { error: err instanceof Error ? err.message : 'Could not draft this idea.' }; }
    setDrafts(prev => new Map([...prev, ...ids.map((id): [string, IdeaDraftState] => [id, state])]));
    setBusy(false);
  };

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
      <div className={styles.actions}>
        <button type="button" className={styles.toggle} disabled={busy || picked.size < 2 || picked.size > DRAFT_MAX}
          onClick={() => { void draft([...picked]); }}>Draft together</button>
        <span className={styles.meta}>{picked.size === 0 ? `Tick 2 to ${DRAFT_MAX} ideas to draft them as one job.` : `${picked.size} selected`}</span>
      </div>
      <div className={styles.groups}>
        {groups.map((group, i) => <RepoCard key={group.repo} group={group} all={full[i]!} expanded={open.has(group.repo)} onToggle={() => toggle(group.repo)}
          picked={picked} drafts={drafts} busy={busy} onPick={togglePick} onDraft={draft} />)}
      </div>
    </>;
  }

  return <div className={styles.root} aria-label="Ideas">{body}</div>;
}

interface DraftProps {
  picked: ReadonlySet<string>;
  drafts: ReadonlyMap<string, IdeaDraftState>;
  busy: boolean;
  onPick: (id: string) => void;
  onDraft: (ids: readonly string[], confirm?: boolean) => Promise<void>;
}

function RepoCard({ group, all, expanded, onToggle, picked, drafts, busy, onPick, onDraft }:
  { group: RepoGroup; all: RepoGroup; expanded: boolean; onToggle: () => void } & DraftProps) {
  const listId = useId();
  const shown = expanded ? all.rows : group.rows;
  return (
    <Card title={group.repo} caption={`${all.rows.length} candidate${all.rows.length === 1 ? '' : 's'}`}>
      <ol className={styles.list} id={listId}>
        {shown.map(row => {
          const state = row.id === null ? undefined : drafts.get(row.id);
          // A batch result belongs to its whole set: confirming re-sends that set.
          const set = state && !('error' in state) ? [...drafts].filter(([, v]) => v === state).map(([k]) => k) : [];
          return <li key={row.key} className={styles.row}>
            <label className={styles.pick}>
              <input type="checkbox" disabled={row.id === null} checked={row.id !== null && picked.has(row.id)}
                onChange={() => row.id !== null && onPick(row.id)} aria-label={`Select ${row.title}`} />
              <span className={styles.title}>{row.title}</span>
            </label>
            <span className={styles.meta}>{row.scoreText} · {row.source}</span>
            {row.goal ? <button type="button" className={styles.toggle} onClick={() => openDockPane('goals')}>from goal: {row.goal.name}</button> : null}
            <IdeaSteer idea={row} repo={group.repo} />
            <span className={styles.actions}>
              <button type="button" className={styles.toggle} disabled={busy || row.id === null}
                onClick={() => { if (row.id !== null) void onDraft([row.id]); }}>Draft job</button>
              {state ? <IdeaDraftChip state={state} onConfirm={() => { void onDraft(set, true); }} /> : null}
            </span>
          </li>;
        })}
      </ol>
      {group.more > 0 ? <button type="button" className={styles.toggle} aria-expanded={expanded} aria-controls={listId} onClick={onToggle}>
        {expanded ? 'Show fewer' : `Show ${group.more} more`}
      </button> : null}
    </Card>
  );
}
