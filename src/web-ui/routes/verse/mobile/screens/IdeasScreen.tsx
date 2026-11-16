/**
 * routes/verse/mobile/screens/IdeasScreen.tsx — the Ideas pane on the phone:
 * the same ranked-backlog read (verseBacklogQuery) shaped by the same
 * ideas-model functions and the same goal link (idea-goal-link.ts).
 * Read-only: no Draft job / Not now / Do next — no mutation token flow.
 *
 * "Queued" is the one thing the backlog does not carry: an idea is queued
 * when a pending proposal already covers it — Proposal.workItemId is the
 * originating work item's id, the exact-dedup key producers write. When the
 * inbox read fails the badges are absent and a footnote says the queue state
 * is unknown, rather than guessing. Remote mode: none of these reads is on
 * the gateway's allowlist, so the screen says so. All text is untrusted.
 */
import { useMemo, useState } from 'react';
import { readFailureReason } from '../../../../data/client.js';
import { refetchQuery } from '../../../../data/cache.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import type { Proposal } from '../../../../data/api-types.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { goalsQuery, inboxListQuery, type QueryDef } from '../../../../data/queries.js';
import { verseBacklogQuery } from '../../autonomy/control-queries.js';
import { ideaGoalId, goalChipText } from '../../ideas/idea-goal-link.js';
import { groupByRepo, ideasHeadline, rankIdeas, sourceCounts } from '../../ideas/ideas-model.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { useMobile } from '../mobile-context.js';
import { Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Row, Section, ui } from '../ui-parts.js';
import styles from './IdeasScreen.module.css';

const POLL_MS = 30_000;
const PER_REPO = 5;
const PENDING = inboxListQuery({ status: 'pending' });

/** Pull-to-refresh: the screen's own reads, forced fresh. */
export function refreshIdeasScreen(): Promise<unknown> {
  const queries: QueryDef<unknown>[] = [verseBacklogQuery, goalsQuery, PENDING];
  return Promise.allSettled(queries.map((q) => refetchQuery(q.key, () => q.fetch(), true)));
}

/** Backlog ids a pending proposal already covers — the draft queue's dedup key. */
function queuedIdeaIds(proposals: readonly Proposal[] | undefined): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const p of proposals ?? []) {
    if (typeof p.workItemId === 'string' && p.workItemId !== '') ids.add(p.workItemId);
  }
  return ids;
}

export function IdeasScreen() {
  const { navigate } = useMobile();
  const remote = isRemoteMobileMode();
  const backlog = useQuery(verseBacklogQuery, { enabled: !remote, freshMs: POLL_MS });
  const goals = useQuery(goalsQuery, { enabled: !remote });
  const inbox = useQuery(PENDING, { enabled: !remote });
  const refetchBacklog = useRefetch(verseBacklogQuery);
  const refetchGoals = useRefetch(goalsQuery);
  const refetchInbox = useRefetch(PENDING);
  const retry = () => { refetchBacklog(); refetchGoals(); refetchInbox(); };
  usePollWhileVisible(retry, POLL_MS, { enabled: !remote });
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());

  const rows = useMemo(() => rankIdeas(backlog.data?.items ?? []), [backlog.data]);
  const queued = useMemo(() => queuedIdeaIds(inbox.data?.proposals), [inbox.data]);
  const full = useMemo(() => groupByRepo(rows, Number.MAX_SAFE_INTEGER), [rows]);
  const groups = useMemo(() => groupByRepo(rows, PER_REPO), [rows]);
  const { counts, nudge } = useMemo(() => sourceCounts(rows), [rows]);
  const goalsList = goals.data ?? [];
  const queueUnknown = Boolean(inbox.error) && inbox.data === undefined;

  const toggle = (repo: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(repo)) next.add(repo);
    return next;
  });

  let body;
  if (remote) {
    body = <EmptyState title="Ideas are not available on the phone." body="The gateway this phone pairs through does not allow that read. Open Phantom on your Mac's network." />;
  } else if (backlog.data === undefined && backlog.status === 'error') {
    body = <ErrorState title="Couldn’t load ideas" reason={readFailureReason(backlog.error)} onRetry={retry} />;
  } else if (backlog.data === undefined) {
    body = <SkeletonList rows={4} label="Loading ideas" />;
  } else if (backlog.data.absent) {
    body = <EmptyState title="No backlog has been built yet." body={'Run `ashlr backlog` or one tick from Controls.'} />;
  } else if (rows.length === 0) {
    body = <EmptyState title="The backlog is empty, so a tick idles." body="Enroll another repository in Scope, or add a goal, to give it work." />;
  } else {
    body = (
      <>
        <p className={styles.headline}>{ideasHeadline(rows)}</p>
        {nudge ? <p className={styles.meta}>{nudge}</p> : null}
        <p className={styles.meta}>{counts.map(({ source, count }) => `${source} ${count}`).join(' · ')}</p>
        {groups.map((group, i) => {
          const expanded = open.has(group.repo);
          const shown = expanded ? full[i]!.rows : group.rows;
          const more = full[i]!.rows.length - shown.length;
          return (
            <Section key={group.repo} title={group.repo} trailing={`${full[i]!.rows.length} candidate${full[i]!.rows.length === 1 ? '' : 's'}`}
              footer={more > 0 || expanded ? (
                <button type="button" className={styles.toggle} aria-expanded={expanded} onClick={() => toggle(group.repo)}>
                  {expanded ? 'Show fewer' : `Show ${more} more`}
                </button>
              ) : undefined}>
              {shown.map((row) => {
                const goalText = goalChipText(ideaGoalId(row), goalsList);
                return (
                  <Row
                    key={row.key}
                    title={row.title}
                    subtitle={<>
                      <span className={styles.meta}>{row.scoreText} · {row.source}</span>
                      {goalText ? <span className={styles.meta}>{goalText}</span> : null}
                    </>}
                    trailing={row.id !== null && queued.has(row.id) ? <Badge tone="info">Queued</Badge> : undefined}
                  />
                );
              })}
            </Section>
          );
        })}
        {queueUnknown ? <p className={ui.faint}>Whether an idea is queued is unknown right now.</p> : null}
      </>
    );
  }

  return (
    <Screen title="Ideas" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={remote ? undefined : refreshIdeasScreen} label="Ideas">
      {body}
    </Screen>
  );
}
