/** BLOCKED notices for `ashlr fleet order-notices`: when every job of an
 * inbox order is still queued on a held lane (heldLaneBlocker in
 * order-lane-blocker.ts), the owner hears about the blocker once per order
 * per distinct held-lane set through the same senders, ledger and lock as
 * merge notices. Pure: no I/O, no clock.
 *
 * The dedupe key hashes the sorted held-lane names only — never held-until
 * times — so a renewed hold on the same lanes does not re-notify, while a
 * job retargeted to a different held lane does. The notice text carries the
 * blocker's dependency string, which names lanes and ISO times only: hold
 * reasons and `held_by` attribution never leave slots.json. */
import { createHash } from 'node:crypto';
import { scrubSecrets } from '../util/scrub.js';
import { heldLaneBlocker } from './order-lane-blocker.js';
import { orderSourceRoute, type OrderMergeNotice } from './order-merge-notice.js';
import type { OrderTraceV1 } from './order-trace.js';
import type { LaneTargetsV1 } from './runs-lane-targets.js';

export function planOrderBlockedNotices(trace: OrderTraceV1, lanes: LaneTargetsV1 | undefined,
  sent: ReadonlySet<string>): OrderMergeNotice[] {
  if (lanes === undefined || lanes.sourceState !== 'healthy') return [];
  const seen = new Set(sent);
  const notices: OrderMergeNotice[] = [];
  for (const order of trace.orders) {
    const route = orderSourceRoute(order.source);
    if (!route || order.jobs.some((job) => job.state === 'merged')) continue;
    const blocker = heldLaneBlocker(order, lanes);
    if (blocker === undefined) continue;
    const job = order.jobs.find((candidate) => candidate.state === 'queued');
    if (job === undefined) continue;
    const held = [...new Set(order.jobs.map((entry) => entry.lane)
      .filter((lane): lane is string => lane !== null))].sort();
    const digest = createHash('sha256').update(JSON.stringify(held)).digest('hex').slice(0, 16);
    for (const channel of new Set([route.channel, ...(order.alsoChannels ?? [])])) {
      const key = `${route.entryId}:blocked:${digest}${channel === route.channel ? '' : `:${channel}`}`;
      if (seen.has(key)) continue;
      seen.add(key);
      notices.push({ ...route, channel, key, jobId: job.id,
        text: scrubSecrets(`Blocked: your ${order.key} order waits on ${blocker.dependency}.`).slice(0, 200) });
    }
  }
  return notices;
}
