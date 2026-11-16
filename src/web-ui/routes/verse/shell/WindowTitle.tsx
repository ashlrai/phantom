import { useEffect, useMemo } from 'react';
import { useQuery, useRefetch } from '../../../data/hooks.js';
import { isDismissed, useFeedDismissals } from '../feed/feed-dismiss-store.js';
import { buildFeed } from '../feed/feed-model.js';
import { leaderThreadQuery } from '../leader/thread-data.js';
import { fleetMergesQuery } from '../fleet-merges/fleet-merges-queries.js';
import { ownerThreadLines } from '../leader-thread/owner-thread-lines.js';
import { NO_OWNER_THREAD, ownerThreadQuery } from '../leader-thread/owner-thread-queries.js';
import { fleetInbox, fleetOutbox, mergeThread } from '../leader-thread/thread-merge-model.js';
import { useMarkSeenWhileViewing, useLastSeen, type SeenView } from './last-seen-store.js';
import { usePollWhileVisible } from './section-visibility.js';
import { unreadCounts, type UnreadCounts } from './unread-counts.js';
import { useActivity } from './useActivity.js';
import { useWindowTitle } from './window-title.js';

/**
 * The window title follows the fleet (shell/fleet-runs-badge.ts), which first
 * paint does not need: PhantomApp mounts this lazily so the badge's query and
 * model stay out of the chat's critical JS.
 */
export default function WindowTitle() {
  useWindowTitle();
  return null;
}

const UNREAD_POLL_MS = 30_000;
const NO_MESSAGES: never[] = [];

/**
 * Counts Leader lines and Feed items newer than their last-seen times and
 * reports them. Rides the Leader pane's and Feed's own queries (same keys, so
 * one cache and one request); nothing here polls faster than 30 s. Lazy for
 * the same reason as WindowTitle: the thread and feed models stay out of first
 * paint. `viewing` is the home view in front of the operator, if any.
 */
export function HomeUnread({ viewing, onCounts }: { viewing: SeenView | null; onCounts: (counts: UnreadCounts) => void }) {
  const thread = useQuery(leaderThreadQuery, { freshMs: UNREAD_POLL_MS });
  const runs = useQuery(fleetMergesQuery, { freshMs: UNREAD_POLL_MS });
  const owner = useQuery(ownerThreadQuery, { freshMs: UNREAD_POLL_MS });
  const activity = useActivity();
  const refetchThread = useRefetch(leaderThreadQuery);
  const refetchRuns = useRefetch(fleetMergesQuery);
  const refetchOwner = useRefetch(ownerThreadQuery);
  usePollWhileVisible(() => { refetchThread(); refetchRuns(); refetchOwner(); }, UNREAD_POLL_MS);
  const seen = useLastSeen();
  const { map: dismissed } = useFeedDismissals();

  const messages = thread.data?.value?.messages ?? NO_MESSAGES;
  const ownerRead = owner.data ?? NO_OWNER_THREAD;
  const model = useMemo(() => {
    const merged = mergeThread(messages, fleetInbox(runs.data), Date.now(), runs.data, fleetOutbox(runs.data));
    const ownerLines = ownerRead.paused ? [] : ownerThreadLines(ownerRead.lines, merged.lines);
    const leaderLines = [...merged.lines, ...ownerLines];
    const feedItems = buildFeed({ leader: messages, runs: runs.data, needsYou: activity.data?.needsYou, owner: ownerRead.paused ? undefined : ownerRead.lines });
    return { leaderLines, feedItems };
  }, [messages, runs.data, ownerRead, activity.data?.needsYou]);
  // A dismissed item is dealt with, so it is not unread.
  const unreadFeed = useMemo(() => model.feedItems.filter(i => !isDismissed(i, dismissed)), [model.feedItems, dismissed]);

  // Looking at a view means everything in it up to now (or its newest item) is seen.
  const newest = useMemo(() => {
    if (viewing === 'leader') return model.leaderLines.reduce((m, l) => Number.isFinite(l.at) && l.at > m ? l.at : m, 0);
    if (viewing === 'feed') return model.feedItems.length ? Date.parse(model.feedItems[0]!.at) : 0;
    return 0;
  }, [viewing, model]);
  useMarkSeenWhileViewing(viewing, newest);

  const counts = useMemo(() => unreadCounts({ leaderLines: model.leaderLines, feedItems: unreadFeed, seen }), [model.leaderLines, unreadFeed, seen]);
  useEffect(() => { onCounts(counts); }, [counts, onCounts]);
  return null;
}
