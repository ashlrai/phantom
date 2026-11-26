/** Shared by the server reader and the Verse UI. */
export const PULSE_LANES_SCHEMA = 'fleet.pulse.lanes.v1' as const;
export const PULSE_WINDOW_H = 24;
/** measured: the ledger has this lane's jobs. idle: the ledger is readable and nothing happened anywhere, so zeros are facts.
 * no_data: the ledger is unreadable, or shows other lanes at work and nothing for this one yet. */
export type PulseLaneState = 'measured' | 'idle' | 'no_data';
export interface PulseLaneV1 {
  lane: string; state: PulseLaneState;
  running: number | null; capacity: number | null;
  merged_per_h: number | null; median_open_to_merge_s: number | null; empty_rate: number | null;
  /** The counts the rates come from; null when unknown. `empty_rate` is null when `finished` is 0 or unknown. */
  merged: number | null; finished: number | null;
  line: string;
}
/** 24 hourly values, oldest first; null where nothing could be worked out for that hour. Empty when unreadable. */
export interface PulseSeriesV1 { merged_per_h: number[]; median_open_to_merge_s: (number | null)[]; empty_rate: (number | null)[] }
export interface PulseLanesV1 {
  schema: typeof PULSE_LANES_SCHEMA; v: 1; as_of: string; window_h: number;
  headline: string;
  lanes: PulseLaneV1[];
  /** Sums run over the lanes that report a figure; null when none does. `series` has no running/capacity history, so it is not kept. */
  totals: { running: number | null; capacity: number | null; merged_per_h: number | null; median_open_to_merge_s: number | null; empty_rate: number | null;
    merged: number | null; finished: number | null; series: PulseSeriesV1 };
}
