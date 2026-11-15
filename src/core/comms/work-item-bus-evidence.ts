/** Build the Nov12 22:29 ET work-item evidence record for one bus message id
 * from the real durable stores: the bus inbox (`bus-inbox/messages.json`) and
 * the work-claims table (`bus-work-claims/claims.json`). Read-only: takes no
 * writer lock, writes nothing, makes no network calls and never throws.
 * Bus labels, claim owners and fencing tokens grant no authority; the claims
 * token never leaves bus-work-claims.ts and is not consulted here.
 *
 * The bounded inbox scan and claims inspection are shared helpers
 * (`readBusInboxEvidence`, `deriveBusWorkItemEvidence`) so `work-board.ts` can
 * classify every listed item from one settled inbox read plus one claims
 * inspection instead of rescanning both stores per item. Nothing is cached
 * across calls. */
import { listBusInboxAfter, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ,
  type BusInboxReceipt } from '../fleet/bus-inbox.js';
import { inspectBusWorkClaims, type BusWorkClaimView } from '../fleet/bus-work-claims.js';
import { RUNNING_FRESH_MS, type WorkItemEvidence } from './work-item-state.js';

export interface BusWorkItemSources {
  /** 'found' when the message id was read; 'missing' when a settled scan did
   * not contain it; 'unavailable' when a page could not be read. */
  inbox: 'found' | 'missing' | 'unavailable';
  /** Straight from inspectBusWorkClaims: table state, never evidence. */
  claims: 'available' | 'missing' | 'unavailable';
}
export interface BusWorkItemEvidenceResult {
  evidence: WorkItemEvidence;
  sources: BusWorkItemSources;
}

const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';

/** A reply names its request through the `inReplyTo` key that
 * bus-reply-post.ts stamps (`in_reply_to` is accepted for peer-protocol
 * bodies). Only a `verified` object carrying pr+head, tests or an artifact is
 * verification evidence under the reporting contract. */
function replyVerifiedEvidence(row: BusInboxReceipt, id: string): WorkItemEvidence['verified'] {
  const body = row.envelope.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (body['inReplyTo'] !== id && body['in_reply_to'] !== id) return undefined;
  const verified = body['verified'];
  if (verified === null || verified === undefined || typeof verified !== 'object' || Array.isArray(verified)) return undefined;
  const pr = typeof verified['pr'] === 'number' && Number.isInteger(verified['pr']) && verified['pr'] > 0 ? verified['pr'] : undefined;
  const head = nonempty(verified['head']) ? verified['head'] : undefined;
  const tests = nonempty(verified['tests']) ? verified['tests'] : undefined;
  const artifact = nonempty(verified['artifact']) ? verified['artifact'] : undefined;
  if (!((pr !== undefined && head !== undefined) || tests !== undefined || artifact !== undefined)) return undefined;
  return { pr, head, tests, artifact, source: `bus-reply:${row.envelope.id}`, at: new Date(row.receivedAt).toISOString() };
}

/** Blocker evidence from an in-reply bus reply whose body carries
 * `{"blocked":{"dependency":"<what it waits on>"}}`. Only the trimmed
 * dependency (<= 200 chars, not "unknown") is kept; reply text is untrusted. */
function replyBlockedEvidence(row: BusInboxReceipt, id: string): WorkItemEvidence['blocker'] {
  const body = row.envelope.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (body['inReplyTo'] !== id && body['in_reply_to'] !== id) return undefined;
  const blocked = body['blocked'];
  if (blocked === null || blocked === undefined || typeof blocked !== 'object' || Array.isArray(blocked)) return undefined;
  const dep = blocked['dependency'];
  if (!nonempty(dep)) return undefined;
  const dependency = dep.trim();
  if (dependency.length > 200 || dependency.toLowerCase() === 'unknown') return undefined;
  return { dependency, source: `bus-reply:${row.envelope.id}`, at: new Date(row.receivedAt).toISOString() };
}

/** Evidence for the claim bound to this receipt. The receipt coordinates
 * (id, cursor, receivedAt) must all match, so a stale claim for a re-posted
 * id cannot pass as current. */
function claimEvidence(evidence: WorkItemEvidence, claims: BusWorkClaimView[], receipt: BusInboxReceipt, now: number): void {
  const claim = claims.find(c => c.id === receipt.envelope.id && c.cursor === receipt.cursor && c.receivedAt === receipt.receivedAt);
  if (!claim) return;
  evidence.owner = claim.owner;
  evidence.claimReceipt = `bus-claim:${claim.id}:${claim.cursor}:${claim.receivedAt}`;
  if (claim.completedAt !== null) return;
  const until = new Date(claim.leaseUntil).toISOString();
  if (claim.leaseUntil > now) {
    evidence.runningEvidence = { source: `bus-work-claims lease-until ${until}`, at: new Date(now).toISOString() };
  } else if (now - claim.leaseUntil > RUNNING_FRESH_MS) {
    // A lease dead past the freshness window is stale running evidence: kept
    // so the classifier reports 'fresh running evidence' missing. A lease
    // lapsed within the window counts as no running evidence at all.
    evidence.runningEvidence = { source: `bus-work-claims lease-until ${until}`, at: until };
  }
}

export interface BusInboxEvidenceRead {
  /** 'ok' only when the bounded scan settled; 'unavailable' carries no
   * receipts, so a partial scan is never mistaken for evidence. */
  status: 'ok' | 'unavailable';
  receipts: BusInboxReceipt[];
}

/** One bounded inbox scan shared by the single-item collector and the work
 * board. Same paging as bus-work-claims.ts receipt(): a zero clock returns
 * the original TTL so retained-but-expired receipts still count as evidence.
 * Any failed or churning page fails the whole read — callers report
 * 'unavailable', never a verified partial read. */
export function readBusInboxEvidence(root: string): BusInboxEvidenceRead {
  const receipts: BusInboxReceipt[] = [];
  let after = 0, settled = false;
  for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
    const result = listBusInboxAfter(after, BUS_INBOX_MAX_READ, { root, now: () => 0 });
    if (result.status !== 'ok') break;
    receipts.push(...result.messages);
    if (result.nextCursor === after) { settled = true; break; }
    after = result.nextCursor;
  }
  return settled ? { status: 'ok', receipts } : { status: 'unavailable', receipts: [] };
}

export interface BusWorkItemDerived {
  evidence: WorkItemEvidence;
  /** 'found' when the request receipt is in the settled scan. */
  inbox: 'found' | 'missing';
}

/** Pure derivation of one item's evidence from an already-read inbox scan
 * and one claims inspection: the request receipt, every in-reply verified or
 * blocked body, and the claim bound to the exact receipt coordinates. */
export function deriveBusWorkItemEvidence(
  id: string, receipts: BusInboxReceipt[], claims: BusWorkClaimView[], now: number,
): BusWorkItemDerived {
  const evidence: WorkItemEvidence = { id };
  let request: BusInboxReceipt | undefined;
  for (const row of receipts) {
    if (row.envelope.id === id) request = row;
    const verified = replyVerifiedEvidence(row, id);
    if (verified) evidence.verified = verified;
    // Newest blocked reply wins; a later reply without `blocked` does not
    // clear it (no "unblocked" semantics yet).
    const blocker = replyBlockedEvidence(row, id);
    if (blocker) evidence.blocker = blocker;
  }
  if (request) {
    evidence.receivedAt = new Date(request.receivedAt).toISOString();
    claimEvidence(evidence, claims, request, now);
  }
  return { evidence, inbox: request ? 'found' : 'missing' };
}

export function collectBusWorkItemEvidence(id: string, opts: { root: string; now: number }): BusWorkItemEvidenceResult {
  const sources: BusWorkItemSources = { inbox: 'unavailable', claims: 'missing' };
  const now = Number.isSafeInteger(opts.now) && opts.now >= 0 ? opts.now : 0;
  let read: BusInboxEvidenceRead = { status: 'unavailable', receipts: [] };
  try { read = readBusInboxEvidence(opts.root); } catch { /* stays unavailable */ }
  let claims: BusWorkClaimView[] = [];
  try {
    const inspection = inspectBusWorkClaims(opts.root);
    sources.claims = inspection.source;
    claims = inspection.claims;
  } catch { sources.claims = 'unavailable'; }
  const derived = deriveBusWorkItemEvidence(id, read.receipts, claims, now);
  sources.inbox = read.status === 'ok' ? derived.inbox : 'unavailable';
  // Blockers come only from in-reply bus replies (replyBlockedEvidence), never invented.
  return { evidence: derived.evidence, sources };
}
