/**
 * routes/verse/ideas/IdeasPane.tsx: what the fleet will pick next. A
 * view of the ranked backlog (`GET /api/backlog`, via the same query the
 * Autonomy panel uses), grouped by repo, each row saying where it came from.
 * Each row can be sent to the Leader as "Do next" / "Not now" (IdeaSteer).
 * Backlog text is untrusted, so it renders as plain text only.
 */
import { openDockPane } from '../dock/dock-store.js';
import { goalChipText, ideaGoalId } from './idea-goal-link.js';
import { Fragment, useId, useMemo, useRef, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { goalsQuery, type GoalSummary } from '../../../data/queries.js';
import { openGoals } from '../goals-pane/goals-pane-model.js';
import { tagIdeas } from './ideas-goal-tag.js';
import { IdeaGoalChip } from './IdeaGoalChip.js';
import { Card, CardNote } from '../command/Surface.js';
import { verseBacklogQuery } from '../autonomy/control-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { groupByRepo, ideasHeadline, rankIdeas, sourceCounts, type IdeaRow, type IdeaRowVerdict, type RepoGroup } from './ideas-model.js';
import { verdictHidesRow, verdictNote } from './idea-verdict-model.js';
import { IdeaDraftChip, postIdeasDraft, type IdeaDraftState } from './IdeaDraftChip.js';
import { IdeaNotNow, postIdeaVerdict } from './IdeaNotNow.js';
import { IdeaSteer } from './IdeaSteer.js';
import styles from './ideas.module.css';

export const IDEAS_POLL_MS = 30_000;
const PER_REPO = 5;
const DRAFT_MAX = 8;

export function IdeasPane({ visible = true }: { visible?: boolean }) {
  const backlog = useQuery(verseBacklogQuery, { enabled: visible, freshMs: IDEAS_POLL_MS });
  const goals = useQuery(goalsQuery, { enabled: visible });
  const [goalFilter, setGoalFilter] = useState('all');
  const [onlyGoals, setOnlyGoals] = useState(() => {
    try { return localStorage.getItem('phantom.ideas.only-goals.v1') === 'true'; } catch { return false; }
  });
  const refetch = useRefetch(verseBacklogQuery);
  usePollWhileVisible(() => { refetch(); }, IDEAS_POLL_MS, { enabled: visible });
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<ReadonlyMap<string, { state: IdeaDraftState; ids: readonly string[] }>>(new Map());
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [showDismissed, setShowDismissed] = useState(false);
  // Optimistic verdicts applied before the server read catches up, keyed by item id.
  const [localVerdicts, setLocalVerdicts] = useState<ReadonlyMap<string, IdeaRowVerdict>>(new Map());
  // Post failures keyed by row key so a rolled-back row shows why it returned.
  const [verdictErrors, setVerdictErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const allRows = useMemo(() => rankIdeas(backlog.data?.items ?? []), [backlog.data]);
  const tagged = useMemo(() => {
    const items = backlog.data?.items ?? [];
    const matches = new Map(tagIdeas(items, goals.data ?? []).map(({ idea, goal }) => [idea, goal]));
    return allRows.map(idea => ({ idea, goal: matches.get(items[Number(idea.key.slice(idea.key.lastIndexOf('#') + 1))]!) ?? null }));
  }, [allRows, backlog.data, goals.data]);
  const ordered = [...tagged.filter(row => row.goal), ...tagged.filter(row => !row.goal)]
    .filter(row => (!onlyGoals || row.goal) && (goalFilter === 'all' || row.goal?.id === goalFilter));
  const rows = ordered.map(row => row.idea);
  const goalByKey = new Map(ordered.map(row => [row.idea.key, row.goal]));
  const verdictOf = (row: IdeaRow): IdeaRowVerdict | undefined =>
    (row.id !== null ? localVerdicts.get(row.id) : undefined) ?? row.verdict;
  const { visibleRows, hiddenCount } = useMemo(() => {
    const at = Date.now();
    const visible = rows.filter(r => {
      const v = (r.id !== null ? localVerdicts.get(r.id) : undefined) ?? r.verdict;
      return showDismissed || !verdictHidesRow(v, at);
    });
    return { visibleRows: visible, hiddenCount: rows.length - visible.length };
  }, [rows, showDismissed, localVerdicts]);
  const runs: typeof rows[] = [];
  for (const row of visibleRows) {
    const last = runs[runs.length - 1];
    if (last && last[0]!.repo === row.repo && Boolean(goalByKey.get(last[0]!.key)) === Boolean(goalByKey.get(row.key))) last.push(row);
    else runs.push([row]);
  }
  const grouped = (limit: number) => runs.flatMap(run => groupByRepo(run, limit));
  const full = grouped(Number.MAX_SAFE_INTEGER);
  const groups = grouped(PER_REPO);
  const { counts, nudge } = useMemo(() => sourceCounts(visibleRows), [visibleRows]);

  const dismiss = (row: IdeaRow, verdict: 'not-now' | 'never', reason: string) => {
    if (row.id === null) return;
    const id = row.id;
    const entry: IdeaRowVerdict = { verdict, reason, at: new Date().toISOString() };
    setLocalVerdicts(prev => new Map(prev).set(id, entry));
    setVerdictErrors(prev => {
      if (!prev.has(row.key)) return prev;
      const next = new Map(prev);
      next.delete(row.key);
      return next;
    });
    postIdeaVerdict(id, verdict, reason)
      .then(recorded => setLocalVerdicts(prev => new Map(prev).set(id, recorded)))
      .catch((err: unknown) => {
        setLocalVerdicts(prev => {
          if (prev.get(id) !== entry) return prev;
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        const message = err instanceof Error ? err.message : 'Could not dismiss this idea.';
        setVerdictErrors(prev => new Map(prev).set(row.key, message));
      });
  };


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
  const draft = async (ids: readonly string[], confirm = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let state: IdeaDraftState;
    try { state = await postIdeasDraft(ids, confirm); }
    catch (err) { state = { error: err instanceof Error ? err.message : 'Could not draft this idea. Try again.' }; }
    setDrafts(prev => new Map([...prev, ...ids.map((id): [string, { state: IdeaDraftState; ids: readonly string[] }] => [id, { state, ids }])]));
    inFlight.current = false;
    setBusy(false);
  };

  let body;
  if (backlog.data === undefined && backlog.status === 'error') {
    body = <CardNote tone="danger">{backlog.error?.message ?? 'Could not read the backlog.'}</CardNote>;
  } else if (backlog.data === undefined) {
    body = <CardNote>Loading ideas…</CardNote>;
  } else if (backlog.data.absent) {
    body = <CardNote>No backlog has been built yet. Run <code>ashlr backlog</code> or one tick from Controls.</CardNote>;
  } else if (allRows.length === 0) {
    body = <CardNote>The backlog is empty, so a tick idles. Enroll another repository in Scope, or add a goal, to give it work.</CardNote>;
  } else if (rows.length === 0) {
    body = <CardNote>No ideas for this goal.</CardNote>;
  } else if (visibleRows.length === 0) {
    body = <CardNote>Every idea here is dismissed. Turn on Show dismissed to see {hiddenCount === 1 ? 'it' : 'them'} again.</CardNote>;
  } else {
    body = <>
      <p className={styles.headline}>{ideasHeadline(visibleRows)}</p>
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
        {groups.map((group, i) => <RepoCard key={`${group.repo}-${i}`} group={group} all={full[i]!} goals={goals.data ?? []} goalByKey={goalByKey} expanded={open.has(group.repo)} onToggle={() => toggle(group.repo)} picked={picked} drafts={drafts} busy={busy} onPick={togglePick} onDraft={draft} verdictOf={verdictOf} verdictError={key => verdictErrors.get(key)} onDismiss={dismiss} />)}

      </div>
    </>;
  }

  return <div className={styles.root} aria-label="Ideas">
    <label>Goal: <select value={goalFilter} onChange={event => setGoalFilter(event.target.value)}>
      <option value="all">All</option>
      {openGoals(goals.data ?? []).map(goal => <option key={goal.id} value={goal.id}>{goal.objective}</option>)}
    </select></label>
    <label className={styles.meta}><input type="checkbox" checked={showDismissed} onChange={event => setShowDismissed(event.target.checked)} /> Show dismissed{hiddenCount > 0 ? ` (${hiddenCount})` : ''}</label>
    <label><input type="checkbox" checked={onlyGoals} onChange={event => {
      const value = event.target.checked; setOnlyGoals(value);
      try { localStorage.setItem('phantom.ideas.only-goals.v1', String(value)); } catch { /* session only */ }
    }} /> Only ideas that serve a goal</label>

    {body}
  </div>;
}

function RepoCard({ group, all, goals, goalByKey, expanded, onToggle, picked, drafts, busy, onPick, onDraft, verdictOf, verdictError, onDismiss }: {
  group: RepoGroup; all: RepoGroup; goals: readonly GoalSummary[]; goalByKey: ReadonlyMap<string, GoalSummary | null>; expanded: boolean; onToggle: () => void;

  picked: ReadonlySet<string>; drafts: ReadonlyMap<string, { state: IdeaDraftState; ids: readonly string[] }>;
  busy: boolean; onPick: (id: string) => void; onDraft: (ids: readonly string[], confirm?: boolean) => Promise<void>;
  verdictOf: (row: IdeaRow) => IdeaRowVerdict | undefined;
  verdictError: (key: string) => string | undefined;
  onDismiss: (row: IdeaRow, verdict: 'not-now' | 'never', reason: string) => void;
}) {
  const listId = useId();
  const shown = expanded ? all.rows : group.rows;
  return (
    <Card title={group.repo} caption={`${all.rows.length} candidate${all.rows.length === 1 ? '' : 's'}`}>
      <ol className={styles.list} id={listId}>
        {shown.map(row => {
          const rowVerdict = verdictOf(row);
          return <li key={row.key} className={styles.row}>
          <label className={styles.pick}><input type="checkbox" disabled={busy || row.id === null} checked={row.id !== null && picked.has(row.id)}
            onChange={() => { if (row.id !== null) onPick(row.id); }} aria-label={`Select ${row.title}`} />
            <span className={styles.title}>{row.title}</span></label>
          <span className={styles.meta}>{row.scoreText} · {row.source}</span>
          {rowVerdict ? <span className={styles.meta}>{verdictNote(rowVerdict)}</span> : null}
          {!goalByKey.get(row.key) && ideaGoalId(row) ? <button type="button" className={styles.toggle} onClick={() => openDockPane('goals')}>{goalChipText(ideaGoalId(row), goals)}</button> : <IdeaGoalChip goal={goalByKey.get(row.key) ?? null} />}

          <IdeaSteer idea={row} repo={group.repo} />
          <span className={styles.actions}>
            <button type="button" className={styles.toggle} disabled={busy || row.id === null}
              onClick={() => { if (row.id !== null) void onDraft([row.id]); }}>Draft job</button>
            <IdeaNotNow ideaId={row.id} title={row.title} error={verdictError(row.key)}
              onVerdict={(verdict, reason) => onDismiss(row, verdict, reason)} />
            {row.id !== null && drafts.has(row.id) ? <IdeaDraftChip state={drafts.get(row.id)!.state} disabled={busy}
              onConfirm={() => { void onDraft(drafts.get(row.id!)!.ids, true); }} /> : null}
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
