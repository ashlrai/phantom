import { isAbsolute, join } from 'node:path';
import { READY_BACKUP, flockReady, replaceLockedQueueFile } from '../queue/order.js';
import { appendGuarded } from '../queue/supersede.js';
import type { readFleetResourcePlan } from '../usage/resource-live/fleet-plan.js';
import { readPrivateJson } from '../usage/resource-live/store.js';
import { readResourceQueue } from './resource-queue.js';

type Plan = Awaited<ReturnType<typeof readFleetResourcePlan>>;

export async function routeExpiringCapacity(runsDir: string, plan: Plan, now: () => number = Date.now, lockReady = flockReady) {
  const at = now(), generated = Date.parse(plan.generated_at);
  if (!isAbsolute(runsDir) || !(generated <= at && at - generated <= 120_000)) return [];
  const candidates = plan.lanes.flatMap(lane => {
    const deadlines = plan.allowances.flatMap(row => row.lane === lane.lane &&
      (row.class === 'included' || row.class === 'expiring') && row.action === 'burn' &&
      row.remaining !== null && row.remaining > 0 && row.jobs_per_slot !== null && row.jobs_per_slot > 0 &&
      row.estimated_quota_per_job !== null && row.deadline_at !== null
      ? [{ deadline: row.deadline_at, reason: 'expiring_included_quota' }] : []);
    if (lane.lane === 'codex-personal' && plan.reset_proposal) {
      deadlines.push({ deadline: plan.reset_proposal.grant.expires_at, reason: 'expiring_reset_bank' });
    }
    const first = deadlines.filter(row => Date.parse(row.deadline) > at)
      .sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline))[0];
    return first && lane.running !== null && lane.target_concurrency !== null
      ? [{ ...first, lane: lane.lane, running: lane.running, target: lane.target_concurrency }] : [];
  }).sort((a, b) => Date.parse(a.deadline) - Date.parse(b.deadline) || a.lane.localeCompare(b.lane));
  if (!candidates.some(row => row.target > row.running)) return [];

  const queueDir = join(runsDir, 'queue');
  const lock = await lockReady(queueDir);
  try {
    if (!lock.quiet) return [];
    const tickAt = now();
    const status = await readPrivateJson(join(queueDir, 'status.json'), 1024 * 1024);
    const queue = await readResourceQueue(runsDir, tickAt, status);
    if (!queue || queue.tick > generated) return [];
    const { lines, rows } = queue;
    const receipts = [];
    const allocated = new Set<number>();
    const rank = new Map(candidates.map((row, index) => [row.lane, index]));
    for (const [order, dest] of candidates.entries()) {
      const view = queue.lanes.get(dest.lane);
      if (!view || view.running !== dest.running || Date.parse(dest.deadline) <= now()) continue;
      const slots = Math.min(dest.target, view.target) - dest.running;
      if (slots <= 0) continue;
      const alreadyHinted = rows.filter(({ row, index }) => !allocated.has(index) &&
        row.hint === dest.lane && queue.eligible(row, dest.lane, true)).length;
      let needed = slots - alreadyHinted;
      for (const { index, row, spec } of rows) {
        if (needed <= 0) break;
        if (spec === null || allocated.has(index) || row.hint === dest.lane ||
          (row.hint !== null && (rank.get(row.hint) ?? Infinity) <= order) || !queue.eligible(row, dest.lane, true)) continue;
        const cells = lines[index]!.replace(/\r$/, '').split('\t');
        cells[2] = dest.lane;
        cells[5] = JSON.stringify({ ...spec, preferred_lane: dest.lane, max_cost_class: 'included' });
        if (cells[5].length > 8192) continue;
        lines[index] = cells.join('\t') + (lines[index]!.endsWith('\r') ? '\r' : '');
        allocated.add(index);
        needed--;
        receipts.push({ schema: 'work-market.v1', event: 'queue_reroute', ts: tickAt / 1000, job: row.id,
          preferred_lane: row.hint, target_lane: dest.lane, deadline_at: dest.deadline,
          running: dest.running, target: dest.target, reason_codes: ['resource_plan_under_target', dest.reason] });
      }
    }
    if (receipts.length) {
      const path = join(queueDir, 'ready.tsv');
      await replaceLockedQueueFile(join(queueDir, READY_BACKUP), queue.text);
      await replaceLockedQueueFile(path, lines.join('\n'));
      try {
        await appendGuarded(join(runsDir, 'metrics', 'work-market.jsonl'), receipts.map(row => JSON.stringify(row) + '\n').join(''));
      } catch (error) {
        await replaceLockedQueueFile(path, queue.text);
        throw error;
      }
    }
    return receipts;
  } finally {
    await lock.release();
  }
}
