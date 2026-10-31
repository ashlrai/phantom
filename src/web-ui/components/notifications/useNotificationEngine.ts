/**
 * components/notifications/useNotificationEngine.ts — the one place that
 * turns backend queries into the notification store's active list. Mount
 * this exactly once (NotificationCenter does, unconditionally, regardless
 * of whether its panel is open) — it has no UI of its own.
 *
 * The existing four queries share the authenticated SSE refresh channel.
 * Runs/inbox have direct events; daemon observations invalidate control-snapshot and
 * fleet-activity observations invalidate fleet. useQuery fetches initially
 * and subscribes to those cache updates, so a second notification poller
 * would duplicate the same expensive reads even with the panel closed.
 *
 * The self-update probe has no SSE event, so it gets one poller — the same
 * cadence (60 s) and visibility gating the Updates row itself uses — plus
 * the native updater's event-driven state, which never polls at all.
 */
import { useEffect } from 'react';
import { useDesktopUpdates } from '../../app/desktop-updates.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { controlSnapshotQuery, fleetStatusQuery, runsQuery, inboxQuery } from '../../data/queries.js';
import { updateStatusQuery } from '../../routes/verse/sections/update-status-queries.js';
import { usePollWhileVisible } from '../../routes/verse/shell/section-visibility.js';
import { deriveNotifications } from './deriveNotifications.js';
import { deriveFleetRunsNotifications } from './deriveFleetRunsNotifications.js';
import { deriveFleetMergeNotifications } from './deriveFleetMergeNotifications.js';
import { deriveUpdateNotifications } from './deriveUpdateNotifications.js';
import { fleetRunsNotifyQuery } from './fleet-runs-query.js';
import { reconcileNotifications } from './notification-store.js';

/** The Updates row polls the same probe at 60 s — never faster. */
const UPDATE_STATUS_NOTIFY_POLL_MS = 60_000;

export function useNotificationEngine(): void {
  const control = useQuery(controlSnapshotQuery);
  const fleet = useQuery(fleetStatusQuery);
  const runs = useQuery(runsQuery);
  const inbox = useQuery(inboxQuery);
  const fleetRuns = useQuery(fleetRunsNotifyQuery);
  const update = useQuery(updateStatusQuery);
  const nativeUpdates = useDesktopUpdates();
  usePollWhileVisible(useRefetch(updateStatusQuery), UPDATE_STATUS_NOTIFY_POLL_MS);

  const controlData = control.data;
  const fleetData = fleet.data;
  const runsData = runs.data;
  const inboxData = inbox.data;
  const fleetRunsData = fleetRuns.data;
  const updateData = update.data;

  useEffect(() => {
    const now = Date.now();
    reconcileNotifications(
      deriveNotifications({
        control: controlData,
        fleet: fleetData,
        runs: runsData,
        inbox: inboxData,
      }).concat(
        deriveFleetRunsNotifications(fleetRunsData, now),
        deriveFleetMergeNotifications(fleetRunsData, now),
        deriveUpdateNotifications(updateData ?? null, now, nativeUpdates),
      ),
    );
  }, [controlData, fleetData, runsData, inboxData, fleetRunsData, updateData, nativeUpdates]);
}
