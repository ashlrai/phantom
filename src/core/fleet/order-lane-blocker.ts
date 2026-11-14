/** BLOCKED evidence for an order from lane holds (`queue/slots.json` via
 * readLaneTargets): an order whose every dispatched job is still queued on a
 * held lane cannot advance until the hold lifts, so the held lane is the
 * order's dependency. Pure: no I/O, no clock.
 *
 * Deliberately conservative: a launched or published job may still have a
 * live worker, and a merged job is already evidence of progress, so either
 * means no blocker. Any queued job on an unheld, unknown or unnamed lane
 * could still dispatch, so it also means no blocker.
 *
 * Like lane-truth.ts, the dependency names lanes and timestamps only, never
 * hold reasons or `held_by` attribution (they can carry account metadata). */
import type { WorkItemEvidence } from '../comms/work-item-state.js';
import type { TraceOrder } from './order-work-state.js';
import type { LaneTargetsV1 } from './runs-lane-targets.js';

/** Normalize a free-form `held_until` to ISO; anything unparseable is dropped
 * rather than echoed, so slots.json text never reaches the report. */
function isoOrNull(value: string | null): string | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

export function heldLaneBlocker(order: TraceOrder, lanes: LaneTargetsV1 | undefined): WorkItemEvidence['blocker'] | undefined {
  if (lanes === undefined || lanes.sourceState !== 'healthy' || order.jobs.length === 0) return undefined;
  const rows = new Map(lanes.lanes.map((row) => [row.lane, row]));
  const held = new Map<string, string | null>();
  for (const job of order.jobs) {
    if (job.state !== 'queued' || job.lane === null) return undefined;
    const row = rows.get(job.lane);
    if (row === undefined || !row.held) return undefined;
    held.set(job.lane, isoOrNull(row.heldUntil));
  }
  const dependency = [...held.keys()].sort()
    .map((lane) => { const until = held.get(lane); return `lane ${lane} held${until ? ` until ${until}` : ''}`; })
    .join(', ');
  return { dependency, source: 'slots.json', at: lanes.generatedAt };
}

const JOB_ID = /^RQ-[A-Z0-9][A-Z0-9-]{0,79}$/;

/** BLOCKED evidence for an order whose every job is launched and ended EMPTY
 * (an `outcome` row with `empty: true` in metrics/jobs.jsonl): no worker is
 * left to advance it, so the dead jobs are its dependency. Any queued,
 * published, merged or still-unmarked launched job means no blocker, and a
 * job id outside the strict RQ shape voids the blocker rather than being
 * echoed. Pure: no I/O, no clock. `traceGeneratedAt` is unused today and kept
 * so the signature matches the other blocker sources. */
export function endedEmptyBlocker(order: TraceOrder, _traceGeneratedAt: string): WorkItemEvidence['blocker'] | undefined {
  if (order.jobs.length === 0) return undefined;
  const ids: string[] = [];
  let newest = -Infinity;
  for (const job of order.jobs) {
    if (job.state !== 'launched' || job.endedEmptyAt === undefined || !JOB_ID.test(job.id)) return undefined;
    const ms = Date.parse(job.endedEmptyAt);
    if (!Number.isFinite(ms)) return undefined;
    ids.push(job.id);
    if (ms > newest) newest = ms;
  }
  ids.sort();
  const shown = ids.slice(0, 3).map((id) => `job ${id} ended empty`);
  if (ids.length > 3) shown.push(`+${ids.length - 3} more`);
  return { dependency: shown.join(', '), source: 'metrics/jobs.jsonl', at: new Date(newest).toISOString() };
}
