/** Shared by the server reader and the Verse UI. */
export const PULSE_ALERTS_SCHEMA = 'fleet.pulse.alerts.v1' as const;
export const PULSE_ALERT_KINDS = ['stalled', 'starved', 'wasting', 'pool_waste', 'release_stale', 'build-stale', 'skipped'] as const;
export type PulseAlertKind = (typeof PULSE_ALERT_KINDS)[number];
export interface PulseAlertV1 {
  kind: PulseAlertKind;
  /** The lane, or the pool for pool_waste, or the repo for release_stale, or the short running commit for build-stale; `fleet` for stalled. */
  lane: string;
  /** ISO time the trouble began; null when it is a projection with no start (pool_waste). */
  since: string | null;
  detail: string;
  fix_hint: string;
}
export interface PulseAlertsV1 {
  schema: typeof PULSE_ALERTS_SCHEMA; v: 1; as_of: string;
  alerts: PulseAlertV1[];
  /** Plain-words checks that could not be made. An alert may be missing for each of these. */
  unknown: string[];
}
/** Every reader's output as it returned it; null when that reader failed. */
