/** Queued-lane lookup for the order trace. A `<id>.launch` marker names the
 * lane but flips the job to 'launched', so the routed lane of a job that is
 * only queued exists nowhere but `<root>/queue/ready.tsv`. This is a bounded,
 * never-throwing read of that file — the shared parseReadyTsv reader plus the
 * legacy five-column normalization — reduced to a job-id → lane map. Lane ids
 * only; row text never leaves the module. */
import { join } from 'node:path';
import { parseReadyTsv } from './lane-console.js';
import { normalizeLegacyRows } from './ready-supply.js';
import { readSource, type Source } from './runs-parked-queue.js';

const MAX_READY = 2 * 1024 * 1024;

export interface QueuedLanes {
  state: Source;
  /** job id → routed lane. */
  lanes: Map<string, string>;
}

/** Dotted status prefix on a pool cell ('PARKED.devin' → 'devin'), the same
 * STATUS.lane form ready-supply's own dotted-pool rule recognizes. */
const DOTTED_POOL = /^([A-Z-]+)\.(.+)$/;

/** Pure: job id → routed lane from ready.tsv text. Rows without an id are
 * skipped; a dotted status prefix on the pool cell is stripped to the lane.
 * A job whose rows disagree on the lane is ambiguous: its mapping is dropped
 * for the whole snapshot (tombstoned, so a later duplicate cannot restore
 * it) rather than letting last-row-wins fabricate a blocker. Identical
 * repeats keep the lane. One ambiguous job never marks the source degraded. */
export function queuedLanesFromText(text: string): Map<string, string> {
  const lanes = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of parseReadyTsv(normalizeLegacyRows(text)).rows) {
    if (row.id === null || ambiguous.has(row.id)) continue;
    const lane = DOTTED_POOL.exec(row.pool)?.[2] ?? row.pool;
    const prior = lanes.get(row.id);
    if (prior === undefined) lanes.set(row.id, lane);
    else if (prior !== lane) {
      lanes.delete(row.id);
      ambiguous.add(row.id);
    }
  }
  return lanes;
}

/** Bounded read of `<root>/queue/ready.tsv`. Never throws: an absent file
 * reports 'missing', any other failure 'degraded'. */
export async function readQueuedLanes(root: string): Promise<QueuedLanes> {
  try {
    const source = await readSource(join(root, 'queue', 'ready.tsv'), MAX_READY, false);
    return { state: source.state, lanes: queuedLanesFromText(source.text) };
  } catch {
    return { state: 'degraded', lanes: new Map() };
  }
}
