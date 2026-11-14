/** Map the real order trace (`readOrderTrace`) onto the Nov12 22:29 ET
 * reporting contract: each inbox order is classified RECEIVED / ASSIGNED /
 * RUNNING / BLOCKED / VERIFIED from structured evidence alone, never from
 * prose. Pure: no I/O, no clock — the caller passes `nowIso`.
 *
 * Honesty bounds of this source:
 * - the trace keeps no fresh per-job timestamp, so `runningEvidence` is never
 *   synthesized here and RUNNING stays unreachable;
 * - the trace carries no dependency edge, so `blocker` is never set and
 *   BLOCKED stays unreachable. */
import { parseOrderAt } from '../../cli/fleet-orders.js';
import { classifyWorkItem, type WorkItemClassification, type WorkItemEvidence } from '../comms/work-item-state.js';
import type { OrderTraceJob, OrderTraceV1 } from './order-trace.js';

export type TraceOrder = OrderTraceV1['orders'][number];

/** Rank order-trace job states by how far the work actually got. */
const RANK: Record<OrderTraceJob['state'], number> = { queued: 0, launched: 1, published: 2, merged: 3 };

/** The job that proves the most about an order; ties keep the trace's own
 * ordering so the result is stable. */
export function mostAdvancedJob(order: TraceOrder): OrderTraceJob | undefined {
  let best: OrderTraceJob | undefined;
  for (const job of order.jobs) if (best === undefined || RANK[job.state] > RANK[best.state]) best = job;
  return best;
}

const GITHUB_PULL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)\/?$/;

/** A github pull URL carries a verifiable pr number; any other url is not a
 * PR url and cannot verify an order. */
export function pullRequest(url: string | null): { url: string; pr: number } | null {
  if (url === null) return null;
  const m = GITHUB_PULL.exec(url);
  return m ? { url, pr: Number(m[1]) } : null;
}

/** Evidence for one order. A queued line is not a claim: it can name an
 * owner (the routed lane) but never a durable claim receipt. Launched or
 * published jobs are real claims (owner + job id); merged jobs additionally
 * verify the order when the trace recorded a github pull URL. */
export function orderEvidence(order: TraceOrder, traceGeneratedAt: string): WorkItemEvidence {
  const evidence: WorkItemEvidence = { id: order.key };
  const received = parseOrderAt(order.at);
  if (received !== null) evidence.receivedAt = new Date(received).toISOString();
  const job = mostAdvancedJob(order);
  if (job === undefined) return evidence;
  if (job.lane !== null) evidence.owner = job.lane;
  if (job.state === 'queued') return evidence;
  evidence.claimReceipt = job.id;
  if (job.state !== 'merged') return evidence;
  const pull = pullRequest(job.url);
  if (pull !== null) {
    evidence.verified = { pr: pull.pr, artifact: pull.url, source: 'order-trace', at: traceGeneratedAt };
  }
  return evidence;
}

export function classifyOrder(order: TraceOrder, generatedAt: string, nowIso: string): WorkItemClassification {
  return classifyWorkItem(orderEvidence(order, generatedAt), nowIso);
}
