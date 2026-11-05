/**
 * routes/verse/feed/FeedSection.tsx: the Feed, one newest-first stream of the
 * Leader's messages and outbox answers, Needs-you alerts, merges and fleet
 * events. It reads what the Leader, Merges and Needs-you surfaces already
 * read (feed-model.ts), so it adds no route and, on a warm cache, no request.
 *
 * Each source fails on its own: the stream renders whatever did load, with a
 * note that some updates are missing. Only when every source is down does it
 * say the Feed is unavailable.
 */
import { useMemo, useState } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { useNow } from '../autonomy/use-ticker.js';
import { Card, CardNote } from '../command/Surface.js';
import { fleetMergesQuery } from '../fleet-merges/fleet-merges-queries.js';
import { leaderThreadQuery } from '../leader/thread-data.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useActivity } from '../shell/useActivity.js';
import { buildFeed, filterFeed, type FeedFilter, type FeedKind } from './feed-model.js';
import styles from './feed.module.css';

const FILTERS: readonly { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'leader', label: 'Leader' },
  { id: 'alert', label: 'Alerts' },
  { id: 'merge', label: 'Merges' },
];
const KIND_LABEL: Record<FeedKind, string> = { leader: 'Leader', alert: 'Alert', merge: 'Merge', fleet: 'Fleet' };
export const FEED_POLL_MS = 15_000;

export function FeedSection({ visible = true }: { visible?: boolean }) {
  const leader = useQuery(leaderThreadQuery, { enabled: visible, freshMs: 15_000 });
  const runs = useQuery(fleetMergesQuery, { enabled: visible, freshMs: 15_000 });
  const activity = useActivity();
  const refetchLeader = useRefetch(leaderThreadQuery);
  const refetchRuns = useRefetch(fleetMergesQuery);
  usePollWhileVisible(() => { refetchLeader(); refetchRuns(); }, FEED_POLL_MS, { enabled: visible });
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FeedFilter>('all');

  const leaderFailed = Boolean(leader.error) || leader.data?.available === false;
  const runsFailed = Boolean(runs.error) && runs.data === undefined;
  const alertsFailed = activity.status === 'unavailable' || (Boolean(activity.error) && !activity.data);
  const failed = [leaderFailed, runsFailed, alertsFailed].filter(Boolean).length;
  const loading = leader.data === undefined && !leaderFailed && runs.data === undefined && !runsFailed && !activity.data && !alertsFailed;

  const feed = useMemo(() => buildFeed({
    leader: leader.data?.value?.messages,
    runs: runsFailed ? undefined : runs.data,
    needsYou: activity.data?.needsYou,
  }), [leader.data, runs.data, runsFailed, activity.data]);
  const shown = filterFeed(feed, filter);

  return <div className={styles.root}>
    <div className={styles.filters} role="group" aria-label="Filter the feed">
      {FILTERS.map(f => <button key={f.id} type="button" className={styles.chip} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
    </div>
    {failed === 3
      ? <CardNote tone="unknown">The Feed is unavailable: none of its sources answered. It retries on its own.</CardNote>
      : failed > 0 ? <CardNote tone="unknown">Some updates could not be loaded.</CardNote> : null}
    {loading ? <CardNote>Loading the feed…</CardNote>
      : failed < 3 && shown.length === 0
        ? <CardNote>{filter === 'all' ? 'Nothing new yet. Leader messages, alerts and merges land here as they happen.' : `No ${FILTERS.find(f => f.id === filter)!.label.toLowerCase()} in the feed right now.`}</CardNote>
        : null}
    {shown.length ? <ol className={styles.list} aria-label="Feed">
      {shown.map(item => <li key={item.id} data-kind={item.kind}>
        <Card title={item.title} caption={<time dateTime={item.at} title={new Date(item.at).toLocaleString('en-US')}>{formatRelative(item.at, now)}</time>}
          actions={<span className={styles.kind} data-kind={item.kind}>{KIND_LABEL[item.kind]}</span>}>
          {item.body ? <p className={styles.body}>{item.body}</p> : null}
          {item.href ? <a className={styles.link} href={item.href} target="_blank" rel="noopener noreferrer">Open</a> : null}
        </Card>
      </li>)}
    </ol> : null}
  </div>;
}
