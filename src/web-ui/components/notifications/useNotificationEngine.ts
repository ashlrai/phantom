/**
 * components/notifications/useNotificationEngine.ts — the one place that
 * turns backend queries into the notification store's active list. Mount
 * this exactly once (NotificationCenter does, unconditionally, regardless
 * of whether its panel is open) — it has no UI of its own.
 *
 * The original four queries share the authenticated SSE refresh channel.
 * Runs/inbox have direct events; daemon observations invalidate control-snapshot and
 * fleet-activity observations invalidate fleet. useQuery fetches initially
 * and subscribes to those cache updates, so a second notification poller
 * would duplicate the same expensive reads even with the panel closed.
 *
 * Fleet runs and lane targets are refreshed together to observe releases.
 * The self-update and release PR probes have no SSE event, so each gets a
 * visibility-gated poller at the same 60 s cadence as its own surface.
 * The resource-ledger probe has no SSE event either, so it shares the
 * Usage pane's visibility-gated ledger read and polls on the same 60 s
 * cadence as the other probes.
 * The native updater uses event-driven state and never polls.
 */
import { useEffect, useRef } from 'react';
import { refetchQuery } from '../../data/cache.js';
import { laneTargetsQuery } from '../../routes/verse/ops/lane-targets-queries.js';
import type { LaneTargetsV1 } from '../../routes/verse/ops/lane-targets-model.js';
import type { AppNotification } from './types.js';
import { useDesktopUpdates } from '../../app/desktop-updates.js';
import { useQuery, useRefetch } from '../../data/hooks.js';
import { controlSnapshotQuery, fleetStatusQuery, runsQuery, inboxQuery } from '../../data/queries.js';
import { releasePrQuery } from '../../routes/verse/fleet/release-pr-query.js';
import { updateStatusQuery } from '../../routes/verse/sections/update-status-queries.js';
import { fleetLedgerQuery } from '../../routes/verse/usage/fleet-ledger-queries.js';
import { usePollWhileVisible } from '../../routes/verse/shell/section-visibility.js';
import { deriveNotifications } from './deriveNotifications.js';
import { deriveFleetLaneReleases, deriveFleetRunsNotifications } from './deriveFleetRunsNotifications.js';
import { deriveFleetLedgerNotifications } from './deriveFleetLedgerNotifications.js';
import { deriveFleetMergeNotifications } from './deriveFleetMergeNotifications.js';
import { deriveMeterWatchNotifications } from './deriveMeterWatchNotifications.js';
import { recordMeterSample, type MeterWatchLog } from './meter-watch-model.js';
import { loadMeterWatchLog, saveMeterWatchLog } from './meter-watch-store.js';
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
  const laneTargets = useQuery(laneTargetsQuery);
  const previous = useRef<{ runs: unknown; targets: LaneTargetsV1 | null | undefined }>({ runs: undefined, targets: undefined });
  const releases = useRef<AppNotification[]>([]);
  const update = useQuery(updateStatusQuery);
  const releasePr = useQuery(releasePrQuery);
  const ledger = useQuery(fleetLedgerQuery);
  const nativeUpdates = useDesktopUpdates();
  usePollWhileVisible(() => {
    void refetchQuery(laneTargetsQuery.key, () => laneTargetsQuery.fetch()).then(() =>
      refetchQuery(fleetRunsNotifyQuery.key, () => fleetRunsNotifyQuery.fetch()));
  }, NOTIFY_POLL_MS);
  usePollWhileVisible(useRefetch(updateStatusQuery), NOTIFY_POLL_MS);
  usePollWhileVisible(useRefetch(releasePrQuery), NOTIFY_POLL_MS);
  usePollWhileVisible(useRefetch(fleetLedgerQuery), NOTIFY_POLL_MS);

  const controlData = control.data;
  const fleetData = fleet.data;
  const runsData = runs.data;
  const inboxData = inbox.data;
  const fleetRunsData = fleetRuns.data;
  const laneTargetsData = laneTargets.data;
  const updateData = update.data;
  const releasePrData = releasePr.data;
  const ledgerData = ledger.data;

  useEffect(() => {
    const now = Date.now();
    if (fleetRunsData !== previous.current.runs) {
      const found = deriveFleetLaneReleases(fleetRunsData, previous.current.runs, laneTargetsData, previous.current.targets, now);
      releases.current = [...releases.current, ...found.filter((item) => !releases.current.some((old) => old.id === item.id))].slice(-50);
      previous.current = { runs: fleetRunsData, targets: laneTargetsData };
    } else if (laneTargetsData) {
      const old = previous.current.targets;
      previous.current.targets = { ...laneTargetsData, lanes: laneTargetsData.lanes.map((lane) =>
        lane.held ? lane : old?.lanes.find((row) => row.lane === lane.lane && row.held) ?? lane) };
    }
    // The ledger is a snapshot; the watch log is Phantom's memory of it.
    // Record before deriving so this poll's reading joins the evidence.
    let meterLog: MeterWatchLog = {};
    if (ledgerData) {
      meterLog = recordMeterSample(loadMeterWatchLog(), ledgerData, now);
      saveMeterWatchLog(meterLog);
    }
    reconcileNotifications(
      deriveNotifications({
        control: controlData,
        fleet: fleetData,
        runs: runsData,
        inbox: inboxData,
      }).concat(
        deriveFleetRunsNotifications(fleetRunsData, now),
        releases.current,
        deriveFleetMergeNotifications(fleetRunsData, now),
        deriveFleetLedgerNotifications(ledgerData, now),
        deriveMeterWatchNotifications(meterLog, ledgerData, now),
        deriveUpdateNotifications(updateData ?? null, now, nativeUpdates),
        deriveReleasePrNotifications(releasePrData, now),
      ),
    );
  }, [controlData, fleetData, runsData, inboxData, fleetRunsData, laneTargetsData, updateData, releasePrData, ledgerData, nativeUpdates]);
}
