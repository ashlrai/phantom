/** One reply-state read for every channel adapter and agent (the Nov12 22:29
 * ET reporting contract). Given a request id it answers with exactly one of
 * RECEIVED, ASSIGNED, RUNNING, BLOCKED or VERIFIED, computed from the durable
 * bus inbox and work-claim records through the shared `classifyWorkItem` rule,
 * never from message text. No record means RECEIVED with "no owner yet".
 *
 * One thread per work item: a later request in the same channel thread
 * resolves to the first request's id, so its replies reuse that id.
 * Read-only: takes no lock, writes nothing, never throws. */
import { inspectBusWorkClaims, type BusWorkClaimView } from '../fleet/bus-work-claims.js';
import type { BusInboxReceipt } from '../fleet/bus-inbox.js';
import { deriveBusWorkItemEvidence, readBusClaimAuthority, readBusInboxEvidence } from './work-item-bus-evidence.js';
import { classifyWorkItem, type WorkItemState } from './work-item-state.js';
import { isRequest } from './work-board.js';

export const REPLY_STATE_SCHEMA = 'phantom.channels.reply-state.v1';

export interface ReplyState {
  schema: typeof REPLY_STATE_SCHEMA;
  /** Id the caller asked about. */
  requestId: string;
  /** Id every reply must use: the first request of the thread, else requestId. */
  id: string;
  /** The first request's id when requestId was a repeat in the same thread. */
  duplicateOf: string | null;
  state: WorkItemState;
  /** Named claim owner, or null (reply says "no owner yet"). */
  owner: string | null;
  /** Durable claim receipt (the job id), or null. */
  claim: string | null;
  /** What the state rests on; null for states that need none. */
  evidence: {
    running: { source: string; at: string } | null;
    blocked: { dependency: string } | null;
    verified: { pr: number | null; head: string | null; tests: string | null; artifact: string | null } | null;
  };
  /** What is still missing for the next state, in plain words. */
  missing: string[];
  asOf: string;
  source: string;
  /** Where each record was read: found, missing or unavailable. */
  records: { inbox: 'found' | 'missing' | 'unavailable'; claims: 'available' | 'missing' | 'unavailable';
    coordination: 'missing' | 'available' | 'unavailable' };
  /** The one plain line a channel adapter posts. */
  text: string;
}

/** HH:MM (UTC) of an ISO stamp, or "unknown" when the stamp is not a time. */
function clock(asOf: string): string {
  const t = Date.parse(asOf);
  return Number.isNaN(t) ? 'unknown' : new Date(t).toISOString().slice(11, 16);
}

/** `STATE (as of HH:MM UTC, source: <file or route>)` then one line of evidence. */
function line(r: Omit<ReplyState, 'text'>): string {
  const head = `${r.state} (as of ${clock(r.asOf)}${clock(r.asOf) === 'unknown' ? '' : ' UTC'}, source: ${r.source})`;
  const who = r.owner !== null && r.claim !== null ? `owner ${r.owner}, claim ${r.claim}` : 'no owner yet';
  const dup = r.duplicateOf !== null ? `; repeat of ${r.duplicateOf}` : '';
  const e = r.evidence;
  let body: string;
  switch (r.state) {
    case 'VERIFIED': {
      const v = e.verified;
      body = v?.pr != null ? `PR ${v.pr}${v.head ? ` at ${v.head}` : ''}` : v?.tests ? `tests ${v.tests}` : `artifact ${v?.artifact ?? 'unknown'}`;
      break;
    }
    case 'BLOCKED': body = `waiting on ${e.blocked?.dependency ?? 'unknown'}`; break;
    case 'RUNNING':
    case 'ASSIGNED': body = who; break;
    default: body = `${who}${r.missing.length ? ` (missing: ${r.missing.join(', ')})` : ''}`;
  }
  return `${head}\n${body}${dup}`;
}

/** First request of the thread holding `id`, by arrival order; `id` itself when it has no thread. */
function firstInThread(id: string, receipts: readonly BusInboxReceipt[]): string {
  const own = receipts.find(row => row.envelope.id === id);
  const ref = own?.envelope.channel_ref;
  if (!own || ref === undefined || !isRequest(own)) return id;
  let first = own;
  for (const row of receipts) {
    if (row.envelope.channel_ref !== ref || !isRequest(row)) continue;
    if (row.receivedAt < first.receivedAt || (row.receivedAt === first.receivedAt && row.cursor < first.cursor)) first = row;
  }
  return first.envelope.id;
}

export function readReplyState(requestId: string, opts: { root: string; now: number }): ReplyState {
  const now = Number.isSafeInteger(opts.now) && opts.now >= 0 ? opts.now : 0;
  let receipts: BusInboxReceipt[] = [];
  let inboxOk = false;
  try {
    const read = readBusInboxEvidence(opts.root);
    inboxOk = read.status === 'ok';
    receipts = read.receipts;
  } catch { /* unavailable: reported below, state stays RECEIVED */ }
  let claims: BusWorkClaimView[] = [];
  let claimsSource: ReplyState['records']['claims'] = 'unavailable';
  try {
    const inspection = inspectBusWorkClaims(opts.root);
    claimsSource = inspection.source;
    claims = inspection.claims;
  } catch { /* unavailable */ }
  const authority = readBusClaimAuthority(opts.root, now);
  const id = firstInThread(requestId, receipts);
  const { evidence, inbox } = deriveBusWorkItemEvidence(id, receipts, claims, now, authority);
  const c = classifyWorkItem(evidence, new Date(now).toISOString());
  const v = c.state === 'VERIFIED' ? evidence.verified : undefined;
  const b = c.state === 'BLOCKED' ? evidence.blocker : undefined;
  const run = c.state === 'RUNNING' ? evidence.runningEvidence : undefined;
  const base: Omit<ReplyState, 'text'> = {
    schema: REPLY_STATE_SCHEMA, requestId, id, duplicateOf: id === requestId ? null : id,
    state: c.state, owner: evidence.owner ?? null, claim: evidence.claimReceipt ?? null,
    evidence: {
      running: run ? { source: run.source, at: run.at } : null,
      blocked: b ? { dependency: b.dependency } : null,
      verified: v ? { pr: v.pr ?? null, head: v.head ?? null, tests: v.tests ?? null, artifact: v.artifact ?? null } : null,
    },
    missing: c.missing, asOf: c.asOf, source: c.source,
    records: { inbox: inboxOk ? inbox : 'unavailable', claims: claimsSource, coordination: authority.source },
  };
  return { ...base, text: line(base) };
}
