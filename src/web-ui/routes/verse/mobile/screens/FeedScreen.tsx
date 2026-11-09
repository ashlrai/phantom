/**
 * routes/verse/mobile/screens/FeedScreen.tsx — the Feed on the phone: the same
 * newest-first stream as the desktop Feed, built by the desktop model
 * (feed/feed-model.ts `buildFeed`) from the same reads.
 *
 * Remote mode (the paired phone behind the gateway): the owner-thread and
 * update-status routes are not on the gateway's read allowlist, so they are
 * not asked for; one footnote says what is missing. Nothing here widens it.
 * Every text is untrusted and rendered as plain text.
 */
import { useMemo, useState } from 'react';
import { deriveUpdateNotifications } from '../../../../components/notifications/deriveUpdateNotifications.js';
import { readFailureReason } from '../../../../data/client.js';
import { useQuery, useRefetch } from '../../../../data/hooks.js';
import { refetchQuery } from '../../../../data/cache.js';
import { isRemoteMobileMode } from '../../../../data/remote-mode.js';
import { ago } from '../../command/ladder-model.js';
import { buildFeed, filterFeed, type FeedFilter, type FeedItem, type FeedKind } from '../../feed/feed-model.js';
import { fleetMergesQuery } from '../../fleet-merges/fleet-merges-queries.js';
import { leaderThreadQuery } from '../../leader/thread-data.js';
import { ownerThreadQuery } from '../../leader-thread/owner-thread-queries.js';
import { updateStatusQuery } from '../../sections/update-status-queries.js';
import { usePollWhileVisible } from '../../shell/section-visibility.js';
import { useMobile } from '../mobile-context.js';
import { Screen, SkeletonList } from '../ui.js';
import { Badge, EmptyState, ErrorState, Row, ui } from '../ui-parts.js';
import styles from './FeedScreen.module.css';

const FILTERS: readonly { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'leader', label: 'Leader' },
  { id: 'alert', label: 'Alerts' },
  { id: 'merge', label: 'Merges' },
  { id: 'owner', label: 'Mason' },
  { id: 'update', label: 'Updates' },
];
const KIND_LABEL: Record<FeedKind, string> = { leader: 'Leader', alert: 'Alert', merge: 'Merge', fleet: 'Fleet', owner: 'Mason', update: 'Update' };
const SHOWN_MAX = 50;
const POLL_MS = 30_000;

/** Pull-to-refresh: the stream's own reads, forced fresh. */
export function refreshFeedScreen(): Promise<unknown> {
  const remote = isRemoteMobileMode();
  const queries = [leaderThreadQuery, fleetMergesQuery, ...(remote ? [] : [ownerThreadQuery, updateStatusQuery])];
  return Promise.allSettled(queries.map((q) => refetchQuery(q.key, () => q.fetch(), true)));
}

function openHref(href: string): void {
  window.open(href, '_blank', 'noopener,noreferrer');
}

function FeedRow({ item, now }: { item: FeedItem; now: number }) {
  const href = item.href?.startsWith('https://') ? item.href : undefined;
  return (
    <Row
      title={item.title}
      subtitle={<>
        {item.body ? <span className={styles.body}>{item.body}</span> : null}
        <time className={styles.meta} dateTime={item.at} title={item.at}>{ago(item.at, now)}</time>
      </>}
      trailing={<Badge>{item.label ?? KIND_LABEL[item.kind]}</Badge>}
      onClick={href ? () => openHref(href) : undefined}
      label={href ? `${item.title}, opens in a new tab` : undefined}
    />
  );
}

export function FeedScreen() {
  const { navigate, activity } = useMobile();
  const remote = isRemoteMobileMode();
  const leader = useQuery(leaderThreadQuery);
  const runs = useQuery(fleetMergesQuery);
  const owner = useQuery(ownerThreadQuery, { enabled: !remote });
  const update = useQuery(updateStatusQuery, { enabled: !remote });
  const refetchLeader = useRefetch(leaderThreadQuery);
  const refetchRuns = useRefetch(fleetMergesQuery);
  const refetchOwner = useRefetch(ownerThreadQuery);
  const refetchUpdate = useRefetch(updateStatusQuery);
  const [, setClockTick] = useState(0);
  usePollWhileVisible(() => {
    setClockTick((tick) => tick + 1);
    refetchLeader();
    refetchRuns();
    if (!remote) { refetchOwner(); refetchUpdate(); }
  }, POLL_MS);
  const [filter, setFilter] = useState<FeedFilter>('all');

  const leaderFailed = Boolean(leader.error) || leader.data?.available === false;
  const runsFailed = Boolean(runs.error) && runs.data === undefined;
  const ownerLines = remote || owner.data?.paused ? undefined : owner.data?.lines;
  const updateItems = useMemo(
    () => (remote ? [] : deriveUpdateNotifications(update.data ?? null, Date.now())),
    [remote, update.data]);
  const feed = useMemo(() => buildFeed({
    leader: leader.data?.value?.messages,
    runs: runsFailed ? undefined : runs.data,
    needsYou: activity.data?.needsYou,
    owner: ownerLines,
    update: updateItems,
  }), [leader.data, runs.data, runsFailed, activity.data, ownerLines, updateItems]);

  const alertsFailed = !activity.data && (activity.status === 'unavailable' || Boolean(activity.error));
  const allDown = leaderFailed && runsFailed && alertsFailed && (remote || (Boolean(owner.error) && owner.data === undefined));
  const loading = !allDown && leader.data === undefined && runs.data === undefined && !activity.data && !leaderFailed && !runsFailed && !alertsFailed;
  const retry = () => { refetchLeader(); refetchRuns(); if (!remote) { refetchOwner(); refetchUpdate(); } };
  const shown = filterFeed(feed, filter).slice(0, SHOWN_MAX);
  const now = Date.now();

  let body;
  if (allDown) body = <ErrorState title="Couldn’t load the feed" reason={readFailureReason(leader.error ?? runs.error)} onRetry={retry} />;
  else if (loading) body = <SkeletonList rows={4} label="Loading the feed" />;
  else body = (
    <>
      <div className={ui.chips} role="group" aria-label="Filter the feed">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={ui.chip} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
        ))}
      </div>
      {shown.length === 0 ? <EmptyState title="Nothing new yet." /> : (
        <div className={ui.group}>
          {shown.map((item) => <FeedRow key={item.id} item={item} now={now} />)}
        </div>
      )}
      {remote ? <p className={ui.faint}>Messages from your channels and Phantom update news are not available on the phone.</p> : null}
    </>
  );

  return (
    <Screen title="Feed" onBack={() => navigate({ screen: 'more' })} backLabel="More" onRefresh={refreshFeedScreen} label="Feed">
      {body}
    </Screen>
  );
}
