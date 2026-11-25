import { hostname } from 'node:os';
import type { NodeCapacity } from './capacity.js';
import type { NodeCapacitySample } from './state.js';

/**
 * `held` reasons the `phm node beat --capacity` sample can store (isNodeCapacity).
 * cpu-* and host-slots-* holds omit the sample instead, so the pool reads the
 * node's capacity as unknown rather than wrongly ready or wrongly held.
 */
const REPORTABLE_HELD: ReadonlySet<string> = new Set([
  'memory-unmeasured', 'memory-pressure', 'disk-unmeasured', 'disk-pressure',
]);

/** The physical-host id a capacity sample carries; one transform for worker and manual beats. */
export function nodeSampleHostId(host: () => string = hostname): string {
  return host().replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 100);
}

export interface BeatCapacityReport {
  /** Ready to pass as `phm node beat --capacity`; null when the beat must omit the flag. */
  readonly sample: NodeCapacitySample | null;
  /** 'unreportable-held' when the measured hold is one the sample schema cannot express. */
  readonly omit: 'unreportable-held' | null;
  /** The measured hold, echoed for the operator; null when the node measured ready. */
  readonly held: NodeCapacity['held'];
}

/**
 * Map a measured NodeCapacity to the beat --capacity sample. Capacity is always
 * measured, never asserted: an unmeasurable or held node reports what it
 * measured, and a hold the schema cannot express omits the sample exactly as
 * the pool worker does. The beat parser stays the schema gate.
 */
export function nodeBeatCapacity(capacity: NodeCapacity, opts: { host?: () => string; now?: () => number } = {}): BeatCapacityReport {
  const held = capacity.held;
  if (held !== null && !REPORTABLE_HELD.has(held)) return { sample: null, omit: 'unreportable-held', held };
  const sample: NodeCapacitySample = { hostId: nodeSampleHostId(opts.host), ramBytes: capacity.ramBytes,
    slots: held === null ? capacity.slots : 0, held, sampledAtMs: (opts.now ?? Date.now)() };
  return { sample, omit: null, held };
}
