/**
 * core/fleet/orders-reply.ts: the paste-ready thread answer to an owner's
 * short "orders" ask — the per-order view behind "Orders 24h: 2 VERIFIED, 1
 * ASSIGNED". Each of the newest orders (up to ORDER_LIMIT) gets one line:
 * time, source, work state under the Nov12 22:29 ET reporting contract
 * (orderEvidence + classifyWorkItem), the owner job + lane that actually
 * proves the state (the evidence's claimReceipt, not a stopped sibling) and
 * the PR number — the same owner/PR binding the fleet order-state API
 * applies — then what the order is still missing, and on a BLOCKED line the
 * held-lane dependency it is waiting on. Order text bodies are never in the
 * trace and never reach the reply.
 *
 * Pure: no I/O, no clock reads — the caller passes `nowIso`, the already-read
 * order trace, one live-worker snapshot (the only evidence that can prove
 * RUNNING) and one lane-targets read (the only evidence that can prove
 * BLOCKED). Honesty bounds mirror recheck-orders-line.ts: an unreadable
 * inbox says "unknown", never "none", and an unavailable live or lanes read
 * is named, not silently dropped to ASSIGNED.
 *
 * Every interpolated value is sanitized here, not trusted from upstream —
 * the same scrub the recheck reply applies to formatOrdersLine's values:
 * /Users|/home/<name> shapes become '~', IPs are dropped and the
 * contract-banned verbs ('routed', 'dispatched') become '[verb]'.
 */
import { classifyWorkItem, type WorkItemEvidence } from '../comms/work-item-state.js';
import { classifyOrder, mostAdvancedJob, orderEvidence, pullRequest, type LiveJobIds, type TraceOrder } from './order-work-state.js';
import type { OrderTraceV1 } from './order-trace.js';
import type { LaneTargetsV1 } from './runs-lane-targets.js';
import { sanitizeIdentityText } from './runtime-identity.js';

/** Hard cap on the whole reply, including the trailing ellipsis when clipped. */
const REPLY_MAX = 1500;
/** One line per order for the newest orders; older orders are dropped first. */
const ORDER_LIMIT = 8;
/** Owner job id and lane validation, identical to fleet-order-state-api.ts:
 * the reply never names an owner that is not a plain RQ id. */
const OWNER_JOB = /^RQ-[A-Z0-9][A-Z0-9-]{0,79}$/;
const OWNER_LANE = /^[a-z0-9][a-z0-9-]{0,31}$/;
/** Home-dir shape from any user — /Users/<name>, /home/<name> → '~'. */
const HOME_PATH = /\/(?:Users|home)\/[^/\s;,)]+/g;
/** The reply contract forbids these words even inside an evidence string. */
const FORBIDDEN_WORDS = /\b(?:routed|dispatched)\b/gi;

/** Redact home paths, IP addresses and contract-banned words from one value. */
function scrub(value: string): string {
  return sanitizeIdentityText(value.replace(HOME_PATH, '~'), '').replace(FORBIDDEN_WORDS, '[verb]');
}

export interface OrdersReplyInput {
  /** The already-read order trace; the reply is built from it alone. */
  trace: OrderTraceV1;
  /** The reply clock as an ISO timestamp; drives the heading and freshness. */
  nowIso: string;
  /** Live-worker membership for RUNNING proof; absent when unproven. */
  live?: LiveJobIds;
  /** Whether the live read itself reported; 'unavailable' is named in a line. */
  liveState: 'healthy' | 'unavailable';
  /** Lane targets from one slots.json read — the only evidence that can prove
   * BLOCKED; used only when `lanesState` is 'healthy'. */
  lanes?: LaneTargetsV1;
  /** Whether the lane-holds read itself reported; 'unavailable' is named in a
   * line. Omitted by callers predating lane evidence: the reply then behaves
   * exactly as it did before lanes existed. */
  lanesState?: 'healthy' | 'unavailable';
}

const etClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/** `owner RQ-… (lane)` for the job the evidence names: with `evidence` the
 * durable `claimReceipt` job and its owner lane — the same binding the
 * order-state API applies, so a stopped sibling is never named; without it,
 * or while the order still has no claim, the most advanced job as before. An
 * owner that is not a plain RQ id reads `no owner`; a lane that fails the
 * API's lane check reads `unknown`. */
function ownerPart(order: TraceOrder, evidence?: WorkItemEvidence): string {
  const job = evidence !== undefined && evidence.claimReceipt !== undefined
    ? { id: evidence.claimReceipt, lane: evidence.owner ?? null }
    : mostAdvancedJob(order);
  if (job === undefined || !OWNER_JOB.test(job.id)) return 'no owner';
  const lane = job.lane !== null && OWNER_LANE.test(job.lane) ? job.lane : 'unknown';
  return `owner ${scrub(job.id)} (${scrub(lane)})`;
}

/** `PR #N` for the evidence's verified artifact when it carries a pr number,
 * else a github pull URL on the most advanced job, else `no PR`. */
function prPart(order: TraceOrder, evidence?: WorkItemEvidence): string {
  if (evidence?.verified?.pr !== undefined) return `PR #${evidence.verified.pr}`;
  const pull = pullRequest(mostAdvancedJob(order)?.url ?? null);
  return pull === null ? 'no PR' : `PR #${pull.pr}`;
}

/** Format the order trace as one paste-ready thread reply: a heading, one
 * line per newest order, then the honesty lines. Oldest order lines are
 * dropped first under the char cap; the heading and honesty lines never are. */
export function formatOrdersReply(input: OrdersReplyInput): string {
  const trace = input.trace;
  const generatedAt = typeof trace?.generatedAt === 'string' ? trace.generatedAt : input.nowIso;
  const orders = [...(trace?.orders ?? [])].sort((a, b) => b.at.localeCompare(a.at)).slice(0, ORDER_LIMIT);
  const live = input.liveState === 'healthy' ? input.live : undefined;
  const lanes = input.lanesState === 'healthy' ? input.lanes : undefined;
  const lines = orders.map(o => {
    // lanesState unset (callers predating lane evidence) keeps the reply
    // byte-identical: no blocker evidence, no evidence-bound owner or PR.
    if (input.lanesState === undefined) {
      const c = classifyOrder(o, generatedAt, input.nowIso, live);
      const missing = c.missing.length === 0 ? 'none' : c.missing.map(scrub).join(', ');
      return `${scrub(o.at)} · ${scrub(o.source)} · ${c.state} · ${ownerPart(o)} · ${prPart(o)} · missing: ${missing}`;
    }
    const evidence = orderEvidence(o, generatedAt, live, lanes);
    const c = classifyWorkItem(evidence, input.nowIso);
    const missing = c.missing.length === 0 ? 'none' : c.missing.map(scrub).join(', ');
    // The blocker dependency already names lanes + held-until only (never
    // hold reasons or changedBy); it is still scrubbed like every value here.
    const waiting = c.state === 'BLOCKED' && evidence.blocker !== undefined ? ` · waiting on: ${scrub(evidence.blocker.dependency)}` : '';
    return `${scrub(o.at)} · ${scrub(o.source)} · ${c.state} · ${ownerPart(o, evidence)} · ${prPart(o, evidence)} · missing: ${missing}${waiting}`;
  });
  const notes: string[] = [];
  const inbox = trace?.sources?.inbox ?? 'unknown';
  if (inbox !== 'healthy') notes.push(`Orders: unknown (inbox ${scrub(inbox)})`);
  else if (orders.length === 0) notes.push('Orders: none');
  if (input.liveState === 'unavailable') notes.push('RUNNING not checked (live workers unavailable)');
  if (input.lanesState === 'unavailable') notes.push('BLOCKED not checked (lane holds unavailable)');
  const ms = Date.parse(input.nowIso);
  const clock = Number.isFinite(ms) ? `${etClock.format(new Date(ms))} ET` : 'unknown';
  const heading = `Phantom orders, as of ${clock} (order-trace)`;
  const assemble = (orderLines: string[]): string => [heading, ...orderLines, ...notes].join('\n');
  while (lines.length > 0 && assemble(lines).length > REPLY_MAX) lines.pop();
  const text = assemble(lines);
  return text.length <= REPLY_MAX ? text : `${text.slice(0, REPLY_MAX - 1)}…`;
}
