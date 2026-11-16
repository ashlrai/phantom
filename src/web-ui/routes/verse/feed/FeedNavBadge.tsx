import { useMemo } from 'react';
import type { FeedReport } from '../../../../core/feed.js';
import { useDesktopUpdates } from '../../../app/desktop-updates.js';
import { deriveUpdateNotifications } from '../../../components/notifications/deriveUpdateNotifications.js';
import { apiGet } from '../../../data/client.js';
import { useQuery } from '../../../data/hooks.js';
import type { QueryDef } from '../../../data/queries.js';
import { agentBusPageQuery } from '../fleet-bus/agent-bus-queries.js';
import { COMMS_STATUS_PATH, readCommsStatus } from '../fleet-inbox/comms-status-model.js';
import { UNIFIED_INBOX_PATH, readUnifiedInboxView } from '../fleet-inbox/unified-inbox-model.js';
import { fleetMergesQuery } from '../fleet-merges/fleet-merges-queries.js';
import { ownerThreadQuery } from '../leader-thread/owner-thread-queries.js';
import { leaderThreadQuery } from '../leader/thread-data.js';
import { updateStatusQuery } from '../sections/update-status-queries.js';
import { useActivity } from '../shell/useActivity.js';
import styles from '../shell/CompactNavStrip.module.css';
import { useFeedDismissals } from './feed-dismiss-store.js';
import { buildFeed } from './feed-model.js';
import { useFeedSeen } from './feed-seen-store.js';
import { unseenCount } from './feed-unseen-count.js';
import { releaseFeedItems } from './release-feed-items.js';

const query = <T,>(key: string, path: string): QueryDef<T> => ({ key, fetch: signal => apiGet<T>(path, signal) });
const sharedQuery = query<FeedReport>('shared-feed', '/api/feed');
const inboxQuery = query<unknown>('verse-fleet-comms-unified-inbox', UNIFIED_INBOX_PATH);
const plansQuery = query<unknown>('verse-feed-gmail-archive-plan', '/api/verse/comms/gmail-triage/archive-plan');
const commsQuery = query<unknown>('verse-fleet-comms-status', COMMS_STATUS_PATH);
const releaseQuery = query<unknown>('verse-release-stages', '/api/verse/release/stages');

export function FeedNavBadge() {
  const shared = useQuery(sharedQuery, { freshMs: 15_000 });
  const leader = useQuery(leaderThreadQuery, { freshMs: 15_000 });
  const runs = useQuery(fleetMergesQuery, { freshMs: 15_000 });
  const owner = useQuery(ownerThreadQuery, { freshMs: 15_000 });
  const update = useQuery(updateStatusQuery, { freshMs: 60_000 });
  const bus = useQuery(agentBusPageQuery(0, 50), { freshMs: 15_000 });
  const teammate = useQuery(inboxQuery, { freshMs: 15_000 });
  const plans = useQuery(plansQuery, { freshMs: 300_000 });
  const commsRead = useQuery(commsQuery, { freshMs: 60_000 });
  const release = useQuery(releaseQuery, { freshMs: 300_000 });
  const native = useDesktopUpdates();
  const activity = useActivity();
  const { seenAt } = useFeedSeen();
  const { map } = useFeedDismissals();
  const count = useMemo(() => {
    const raw = teammate.data;
    const view = readUnifiedInboxView(raw);
    const data = raw && typeof raw === 'object' ? raw as { generatedAt?: unknown; items?: unknown } : null;
    const rawItems = Array.isArray(data?.items) ? data.items : [];
    const inbox = view && !view.unavailable && data ? { ...view,
      generatedAt: typeof data.generatedAt === 'string' ? data.generatedAt : undefined,
      items: view.items.map(item => {
        const original = rawItems.find((row: unknown) => row && typeof row === 'object' && 'id' in row && row.id === item.id) as { since?: unknown } | undefined;
        return typeof original?.since === 'string' ? { ...item, since: original.since } : item;
      }),
    } : view;
    const drafts = commsRead.error ? null : readCommsStatus(commsRead.data)?.drafts;
    const comms = drafts?.oldestPendingAt ? { runId: `drafts:${drafts.oldestPendingAt}`, at: drafts.oldestPendingAt, drafts } : null;
    const feed = buildFeed({ shared: shared.data, leader: leader.data?.value?.messages,
      runs: runs.error && runs.data === undefined ? undefined : runs.data, needsYou: activity.data?.needsYou,
      owner: owner.data?.paused ? undefined : owner.data?.lines,
      update: deriveUpdateNotifications(update.data ?? null, Date.now(), native), bus: bus.data,
      teammate: teammate.error ? null : inbox, comms, inboxPlans: plans.error ? undefined : plans.data });
    const items = [...feed, ...releaseFeedItems(release.data, native, new Date().toISOString())]
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 100);
    return unseenCount(items, seenAt, map);
  }, [shared.data, leader.data, runs.data, runs.error, activity.data, owner.data, update.data, native, bus.data, teammate.data, teammate.error, commsRead.data, commsRead.error, plans.data, plans.error, release.data, seenAt, map]);
  return count ? <span className={styles.count} aria-label={`Feed, ${count} unseen`}>{count > 99 ? '99+' : count}</span> : null;
}
