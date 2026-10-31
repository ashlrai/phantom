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
 * The self-update and release PR probes have no SSE event, so each gets a
 * visibility-gated poller at the same 60 s cadence as its own surface.
 * The resource-ledger probe has no SSE event either, so it shares the
 * Usage pane's visibility-gated ledger read and polls on the same 60 s
 * cadence as the other probes.
 * The native updater uses event-driven state and never polls.
 */
import { useEffect } from 'react';
import { useDesktopUpdates } from '../../app/desktop-updates.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { controlSnapshotQuery, fleetStatusQuery, runsQuery, inboxQuery } from '../../data/queries.js';
import { releasePrQuery } from '../../routes/verse/fleet/release-pr-query.js';
import { updateStatusQuery } from '../../routes/verse/sections/update-status-queries.js';
import { fleetLedgerQuery } from '../../routes/verse/usage/fleet-ledger-queries.js';
import { usePollWhileVisible } from '../../routes/verse/shell/section-visibility.js';
import { deriveNotifications } from './deriveNotifications.js';
import { deriveFleetRunsNotifications } from './deriveFleetRunsNotifications.js';
import { deriveFleetLedgerNotifications } from './deriveFleetLedgerNotifications.js';
import { deriveFleetMergeNotifications } from './deriveFleetMergeNotifications.js';
import { deriveReleasePrNotifications } from './deriveReleasePrNotifications.js';
import { deriveUpdateNotifications } from './deriveUpdateNotifications.js';
import { fleetRunsNotifyQuery } from './fleet-runs-query.js';
import { reconcileNotifications } from './notification-store.js';

/** Match the Updates and Releases surfaces; never poll faster. */
const NOTIFY_POLL_MS = 60_000;

export function useNotificationEngine(): void {
  const control = useQuery(controlSnapshotQuery);
  const fleet = useQuery(fleetStatusQuery);
  const runs = useQuery(runsQuery);
  const inbox = useQuery(inboxQuery);
  const fleetRuns = useQuery(fleetRunsNotifyQuery);
  const update = useQuery(updateStatusQuery);
  const releasePr = useQuery(releasePrQuery);
  const ledger = useQuery(fleetLedgerQuery);
  const nativeUpdates = useDesktopUpdates();
  usePollWhileVisible(useRefetch(updateStatusQuery), NOTIFY_POLL_MS);
  usePollWhileVisible(useRefetch(releasePrQuery), NOTIFY_POLL_MS);
  usePollWhileVisible(useRefetch(fleetLedgerQuery), NOTIFY_POLL_MS);

  const controlData = control.data;
  const fleetData = fleet.data;
  const runsData = runs.data;
  const inboxData = inbox.data;
  const fleetRunsData = fleetRuns.data;
  const updateData = update.data;
  const releasePrData = releasePr.data;
  const ledgerData = ledger.data;

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
        deriveFleetLedgerNotifications(ledgerData, now),
        deriveUpdateNotifications(updateData ?? null, now, nativeUpdates),
        deriveReleasePrNotifications(releasePrData, now),
      ),
    );
  }, [controlData, fleetData, runsData, inboxData, fleetRunsData, updateData, releasePrData, ledgerData, nativeUpdates]);
}
