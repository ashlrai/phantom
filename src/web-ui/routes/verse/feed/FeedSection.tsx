/**
 * routes/verse/feed/FeedSection.tsx: the Feed, one newest-first stream of the
 * Leader's messages and outbox answers, Needs-you alerts, merges, fleet
 * events, Phantom update news, urgent (P0, P1) agent bus messages, the Comms digest and the owner thread (what came in on Telegram, Slack, email and
 * iMessage, and where the Leader's answer went). It reads what the Leader, Merges and Needs-you surfaces already
 * read (feed-model.ts), so it adds no route and, on a warm cache, no request.
 *
 * Every item opens the pane that owns it ("Open in Merges", …: feed-model.ts
 * sets `pane`), and job ids in its text open that job's worker log, the same
 * links every fleet pane gives. Text stays plain: it is untrusted.
 *
 * Each source fails on its own: the stream renders whatever did load, with a
 * note that some updates are missing. Only when every source is down does it
 * say the Feed is unavailable.
 */
import type { FeedReport } from '../../../../core/feed.js';
import { apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopUpdates } from '../../../app/desktop-updates.js';
import { deriveUpdateNotifications } from '../../../components/notifications/deriveUpdateNotifications.js';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { formatRelative } from '../autonomy/format.js';
import { useNow } from '../autonomy/use-ticker.js';
import { Card, CardNote } from '../command/Surface.js';
import { openChat } from '../command/nav.js';
import { liveLine } from '../chat/sidebar-model.js';
import { openDockPane } from '../dock/dock-store.js';
import { paneLinkUrl } from '../dock/pane-link.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { JobRefs } from '../fleet/JobRefs.js';
import type { PaneHost } from '../panes/pane-registry.js';
import { COMMS_STATUS_PATH, readCommsStatus } from '../fleet-inbox/comms-status-model.js';
import { UNIFIED_INBOX_PATH, readUnifiedInboxView } from '../fleet-inbox/unified-inbox-model.js';
import { agentBusPageQuery } from '../fleet-bus/agent-bus-queries.js';
import { fleetMergesQuery } from '../fleet-merges/fleet-merges-queries.js';
import { leaderThreadQuery } from '../leader/thread-data.js';
import { ownerThreadQuery } from '../leader-thread/owner-thread-queries.js';
import { updateStatusQuery } from '../sections/update-status-queries.js';
import { usePollWhileVisible } from '../shell/section-visibility.js';
import { useActivity } from '../shell/useActivity.js';
import { buildFeed, feedPaneLabel, filterFeed, type FeedFilter, type FeedKind } from './feed-model.js';
import { FeedAskButton } from './FeedAskButton.js';
import { releaseFeedItems } from './release-feed-items.js';
import { isDismissed, useFeedDismissals } from './feed-dismiss-store.js';
import { countNew, firstOlderIndex, useFeedSeen } from './feed-seen-store.js';
import styles from './feed.module.css';

const unifiedInboxQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-unified-inbox', fetch: signal => apiGet(UNIFIED_INBOX_PATH, signal) };
const inboxPlansQuery: QueryDef<unknown> = { key: 'verse-feed-gmail-archive-plan', fetch: signal => apiGet('/api/verse/comms/gmail-triage/archive-plan', signal) };
const releaseStagesQuery: QueryDef<unknown> = { key: 'verse-release-stages', fetch: signal => apiGet('/api/verse/release/stages', signal) };
const sharedFeedQuery: QueryDef<FeedReport> = { key: 'shared-feed', fetch: signal => apiGet<FeedReport>('/api/feed', signal) };

const FILTERS: readonly { id: FeedFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'leader', label: 'Leader' },
  { id: 'alert', label: 'Alerts' },
  { id: 'merge', label: 'Merges' },
  { id: 'owner', label: 'Channels' },
  { id: 'update', label: 'Updates' },
  { id: 'bus', label: 'Bus' },
  { id: 'teammate', label: 'Dot' },
  { id: 'comms', label: 'Comms' },
];
const KIND_LABEL: Record<FeedKind, string> = { leader: 'Leader', alert: 'Alert', merge: 'Merge', fleet: 'Fleet', owner: 'Channel', update: 'Update', bus: 'Bus', teammate: 'Dot', comms: 'Comms' };
// Same key and fetch as the Inbox pane's Comms card, so the two share one cached read.
const commsStatusQuery: QueryDef<unknown> = { key: 'verse-fleet-comms-status', fetch: s => apiGet(COMMS_STATUS_PATH, s) };
export const FEED_POLL_MS = 15_000;

/** In the dock the pane host opens panes; rendered on its own (tests, older mounts) the dock store does, as LeaderThreadPane does. */
export function FeedSection({ visible = true, host }: { visible?: boolean; host?: Pick<PaneHost, 'openPane'> }) {
  const openPane = (id: string) => { if (host) host.openPane(id); else openDockPane(id); };
  const openJob = (job: string) => { requestWorkerLogJob(job); openPane('worker-log'); };
  const shared = useQuery(sharedFeedQuery, { enabled: visible, freshMs: 15_000 });
  const leader = useQuery(leaderThreadQuery, { enabled: visible, freshMs: 15_000 });
  const runs = useQuery(fleetMergesQuery, { enabled: visible, freshMs: 15_000 });
  const owner = useQuery(ownerThreadQuery, { enabled: visible, freshMs: 15_000 });
  // The tray's own reads; a failed or missing update read just adds no update rows.
  const update = useQuery(updateStatusQuery, { enabled: visible, freshMs: 60_000 });
  // An older hub has no bus route: the query's 404 just means no bus rows, never an error note.
  const bus = useQuery(agentBusPageQuery(0, 50), { enabled: visible, freshMs: 15_000 });
  const teammate = useQuery(unifiedInboxQuery, { enabled: visible, freshMs: 15_000 });
  const inboxPlans = useQuery(inboxPlansQuery, { enabled: visible, freshMs: 300_000 });
  const refetchInboxPlans = useRefetch(inboxPlansQuery);
  usePollWhileVisible(refetchInboxPlans, 300_000, { enabled: visible });
  const commsRead = useQuery(commsStatusQuery, { enabled: visible, freshMs: 60_000 });
  const releaseStages = useQuery(releaseStagesQuery, { enabled: visible, freshMs: 300_000 });
  const nativeUpdates = useDesktopUpdates();
  const activity = useActivity();
  const refetchShared = useRefetch(sharedFeedQuery);
  const refetchLeader = useRefetch(leaderThreadQuery);
  const refetchRuns = useRefetch(fleetMergesQuery);
  const refetchOwner = useRefetch(ownerThreadQuery);
  const refetchTeammate = useRefetch(unifiedInboxQuery);
  const refetchBus = useRefetch(agentBusPageQuery(0, 50));
  usePollWhileVisible(() => { refetchShared(); refetchLeader(); refetchRuns(); refetchOwner(); refetchBus(); refetchTeammate(); }, FEED_POLL_MS, { enabled: visible });
  const now = useNow(30_000);
  const [filter, setFilter] = useState<FeedFilter>('all');
  const { map: dismissedMap, dismissItem, restoreItem } = useFeedDismissals();
  const [showDismissed, setShowDismissed] = useState(false);
  const { seenAt, markSeen } = useFeedSeen();

  const leaderFailed = Boolean(leader.error) || leader.data?.available === false;
  const runsFailed = Boolean(runs.error) && runs.data === undefined;
  const alertsFailed = activity.status === 'unavailable' || (Boolean(activity.error) && !activity.data);
  // A 404 from the owner route is "no owner lines" (the query maps it), so only a real error counts.
  const ownerFailed = Boolean(owner.error) && owner.data === undefined;
  const ownerPaused = owner.data?.paused === true;
  const ownerLines = ownerPaused ? undefined : owner.data?.lines;
  const failed = [leaderFailed, runsFailed, alertsFailed, ownerFailed].filter(Boolean).length;
  // Down means no source gave anything: the owner source only counts as up when it returned lines.
  const allDown = !shared.data && leaderFailed && runsFailed && alertsFailed && (ownerFailed || !ownerLines?.length);
  const loading = leader.data === undefined && !leaderFailed && runs.data === undefined && !runsFailed && !activity.data && !alertsFailed && owner.data === undefined && !ownerFailed;

  const updateItems = useMemo(
    () => deriveUpdateNotifications(update.data ?? null, Date.now(), nativeUpdates),
    [update.data, nativeUpdates]);

  const inboxView = useMemo(() => {
    const raw = teammate?.data;
    const view = readUnifiedInboxView(raw);
    if (!view || view.unavailable || !raw || typeof raw !== 'object') return view;
    const data = raw as { generatedAt?: unknown; items?: unknown };
    const rawItems = Array.isArray(data.items) ? data.items : [];
    return { ...view, generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : undefined,
      items: view.items.map(item => {
        const original = rawItems.find((row: unknown) => row && typeof row === 'object' && 'id' in row && row.id === item.id) as { since?: unknown } | undefined;
        return typeof original?.since === 'string' ? { ...item, since: original.since } : item;
      }) };
  }, [teammate?.data]);

  // The status route reports pending drafts only, so unread, archived and Dot stay "unknown";
  // the draft batch (keyed by its oldest draft) is the run until a run reader exists.
  const comms = useMemo(() => {
    const drafts = !commsRead || commsRead.error ? null : readCommsStatus(commsRead.data)?.drafts;
    return drafts?.oldestPendingAt ? { runId: `drafts:${drafts.oldestPendingAt}`, at: drafts.oldestPendingAt, drafts } : null;
  }, [commsRead]);

  const feed = useMemo(() => buildFeed({
    shared: shared.data,
    leader: leader.data?.value?.messages,
    runs: runsFailed ? undefined : runs.data,
    needsYou: activity.data?.needsYou,
    owner: ownerLines,
    update: updateItems,
    bus: bus.data,
    teammate: teammate?.error ? null : inboxView,
    comms,
    inboxPlans: inboxPlans.error ? undefined : inboxPlans.data,
  }), [shared.data, leader.data, runs.data, runsFailed, activity.data, ownerLines, updateItems, bus.data, inboxView, teammate?.error, comms, inboxPlans.data, inboxPlans.error]);
  const releaseItems = useMemo(() => releaseFeedItems(releaseStages.data, nativeUpdates, new Date().toISOString()), [releaseStages.data, nativeUpdates]);
  const combinedFeed = useMemo(() => [...feed, ...releaseItems].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100), [feed, releaseItems]);
  const filtered = filterFeed(combinedFeed, filter);
  const shown = filtered.filter(item => !isDismissed(item, dismissedMap));
  const dismissed = filtered.filter(item => isDismissed(item, dismissedMap));
  const newCount = countNew(shown, seenAt);
  const olderAt = firstOlderIndex(shown, seenAt);

  // Leaving the Feed (hidden, or unmounted) after it was visible marks what it showed as seen,
  // so the count stays while he reads and is gone next time.
  const newestAt = useRef<string | undefined>(undefined);
  // Only while visible: the render that hides the Feed must not replace what it last showed.
  if (visible) newestAt.current = combinedFeed.find(item => !isDismissed(item, dismissedMap))?.at;
  useEffect(() => {
    if (!visible) return undefined;
    return () => { if (newestAt.current) markSeen(newestAt.current); };
  }, [visible, markSeen]);

  return <div className={styles.root}>
    <section aria-labelledby="feed-running-title" className={styles.running}>
      <h2 id="feed-running-title">Running chats</h2>
      {activity.status === 'stale' ? <CardNote tone="unknown">Activity is stale; showing the last successful read.</CardNote> : null}
      {activity.data && activity.data.sources.chats !== 'ok' ? <CardNote tone="unknown">Chat activity could not be fully read.</CardNote> : null}
      {!activity.data ? <CardNote tone="unknown">{activity.status === 'unavailable' ? 'Running chat activity is unavailable.' : 'Loading running chats…'}</CardNote>
        : activity.data.running.length === 0 ? activity.data.sources.chats === 'ok' ? <CardNote>No chats running in the latest activity snapshot.</CardNote> : null
          : <ul className={styles.runningList}>
            {activity.data.running.map(chat => <li key={chat.sessionId}>
              <button type="button" className={styles.runningButton} onClick={() => openChat(chat.sessionId)}>
                <span>{chat.title || 'Untitled chat'}</span>
                <span className={styles.runningDetail}>{chat.engine} · {liveLine(chat.live) ?? 'Running'}</span>
              </button>
            </li>)}
          </ul>}
    </section>
    <div className={styles.filters} role="group" aria-label="Filter the feed">
      {FILTERS.map(f => <button key={f.id} type="button" className={styles.chip} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>)}
    </div>
    {allDown
      ? <CardNote tone="unknown">The Feed is unavailable: none of its sources answered. It retries on its own.</CardNote>
      : failed > 0 ? <CardNote tone="unknown">Some updates could not be loaded.</CardNote> : null}
    <CardNote tone="unknown">{shared.data ? `Unknown sources: ${Object.entries(shared.data.sources).filter(([, state]) => state === 'unknown').map(([name]) => name === 'leaderReplies' ? 'leader replies' : name).join(', ') || 'none'}.` : 'Shared feed sources are unknown.'}</CardNote>
    {ownerPaused ? <CardNote tone="unknown">Owner channels are paused; their messages are hidden.</CardNote> : null}
    {loading ? <CardNote>Loading the feed…</CardNote>
      : !allDown && shown.length === 0
        ? <CardNote>{filter === 'all' ? 'Nothing new yet. Leader messages, alerts and merges land here as they happen.' : `No ${FILTERS.find(f => f.id === filter)!.label.toLowerCase()} in the feed right now.`}</CardNote>
        : null}
    {newCount > 0 ? <div className={styles.newBar}>
      <span>{newCount} new since you last looked</span>
      <button type="button" className={styles.dismiss} onClick={() => markSeen(shown[0]!.at)}>Mark all seen</button>
    </div> : null}
    {shown.length ? <ol className={styles.list} aria-label="Feed">
      {shown.map((item, i) => <Fragment key={item.id}>
        {newCount > 0 && i === olderAt ? <li role="separator" aria-label="Earlier" className={styles.divider}>Earlier</li> : null}
        <li data-kind={item.kind}>
        <Card title={<JobRefs text={item.title} onOpenJob={openJob} />} caption={<time dateTime={item.at} title={new Date(item.at).toLocaleString('en-US')}>{formatRelative(item.at, now)}</time>}
          actions={<><FeedAskButton item={item} /><span className={styles.kind} data-kind={item.kind}>{item.label ?? KIND_LABEL[item.kind]}</span></>}>
          {item.body ? <p className={styles.body}><JobRefs text={item.body} onOpenJob={openJob} /></p> : null}
          {/* Dot's texts keep their older "Open inbox" wording; every other owned item says where it goes. */}
          {item.kind === 'teammate' && item.pane ? <button type="button" className={styles.link} onClick={() => openPane(item.pane!)}>Open inbox</button>
            : item.pane && feedPaneLabel(item.pane) ? <a className={styles.link} href={paneLinkUrl(item.pane, null, false) ?? undefined}
              aria-label={`${feedPaneLabel(item.pane)}: ${item.title}`} onClick={event => { event.preventDefault(); openPane(item.pane!); }}>{feedPaneLabel(item.pane)}</a> : null}
          {item.href ? <a className={styles.link} href={item.href} target="_blank" rel="noopener noreferrer">Open</a> : null}
          <button type="button" className={styles.dismiss} aria-label={`Dismiss ${item.title}`} onClick={() => dismissItem(item)}>Dismiss</button>
        </Card>
        </li>
      </Fragment>)}
    </ol> : null}
    {dismissed.length ? <div className={styles.dismissedBar}>
      <span>{dismissed.length} dismissed</span> · <button type="button" className={styles.dismiss} aria-expanded={showDismissed} onClick={() => setShowDismissed(v => !v)}>{showDismissed ? 'Hide' : 'Show'}</button>
    </div> : null}
    {showDismissed && dismissed.length ? <ol className={styles.list} aria-label="Dismissed">
      {dismissed.map(item => <li key={item.id} data-kind={item.kind} className={styles.dimmed}>
        <Card title={item.title} caption={<time dateTime={item.at}>{formatRelative(item.at, now)}</time>}>
          <button type="button" className={styles.dismiss} aria-label={`Restore ${item.title}`} onClick={() => restoreItem(item)}>Restore</button>
        </Card>
      </li>)}
    </ol> : null}
  </div>;
}
