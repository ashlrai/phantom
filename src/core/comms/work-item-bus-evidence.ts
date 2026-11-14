/** Build the Nov12 22:29 ET work-item evidence record for one bus message id
 * from the real durable stores: the bus inbox (`bus-inbox/messages.json`) and
 * the work-claims table (`bus-work-claims/claims.json`). Read-only: takes no
 * writer lock, writes nothing, makes no network calls and never throws.
 * Bus labels, claim owners and fencing tokens grant no authority; the claims
 * token never leaves bus-work-claims.ts and is not consulted here. */
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

export function collectBusWorkItemEvidence(id: string, opts: { root: string; now: number }): BusWorkItemEvidenceResult {
  const evidence: WorkItemEvidence = { id };
  const sources: BusWorkItemSources = { inbox: 'missing', claims: 'missing' };
  const now = Number.isSafeInteger(opts.now) && opts.now >= 0 ? opts.now : 0;
  let request: BusInboxReceipt | undefined;
  try {
    let after = 0, settled = false;
    // Same bounded scan as bus-work-claims.ts receipt(): a zero clock returns
    // the original TTL so retained-but-expired receipts still count as evidence.
    for (let page = 0; page <= Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ); page++) {
      const result = listBusInboxAfter(after, BUS_INBOX_MAX_READ, { root: opts.root, now: () => 0 });
      if (result.status !== 'ok') break;
      for (const row of result.messages) {
        if (row.envelope.id === id) request = row;
        const verified = replyVerifiedEvidence(row, id);
        if (verified) evidence.verified = verified;
        // Newest blocked reply wins; a later reply without `blocked` does not
        // clear it (no "unblocked" semantics yet).
        const blocker = replyBlockedEvidence(row, id);
        if (blocker) evidence.blocker = blocker;
      }
      if (result.nextCursor === after) { settled = true; break; }
      after = result.nextCursor;
    }
    sources.inbox = settled ? (request ? 'found' : 'missing') : 'unavailable';
    if (request) evidence.receivedAt = new Date(request.receivedAt).toISOString();
  } catch { sources.inbox = 'unavailable'; }
  try {
    const inspection = inspectBusWorkClaims(opts.root);
    sources.claims = inspection.source;
    if (request) claimEvidence(evidence, inspection.claims, request, now);
  } catch { sources.claims = 'unavailable'; }
  // Blockers come only from in-reply bus replies (replyBlockedEvidence), never invented.
  return { evidence, sources };
}
