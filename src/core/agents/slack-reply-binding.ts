import { isSlackChannelId, isSlackTs } from './slack-network.js';
import { isSlackRequestId, leaderReplySendKey, isSlackSendStoreKey } from './slack-reply-identity.js';

export interface InboundRequest {
  at: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
  /**
   * Leader request id journaled when the request was positively routed to the
   * Leader. Without it the request has no reply identity and is `unverified`.
   */
  requestId?: string;
}

export interface SentReceipt {
  /** Send-store key (64 hex) the transport derived from the sent envelope id. */
  key?: string;
  channel: string;
  thread?: string;
  state: 'attempted' | 'sent';
  ts?: string;
}

export type SlackReplyVerdict = 'answered' | 'unanswered' | 'uncertain' | 'unverified';

export interface SlackReplyBinding {
  /** One entry per distinct keyed request whose exact reply key has a consistent `sent` receipt. */
  answered: Array<{ channelId: string; threadTs: string; messageTs: string; replyTs: string; requestId: string; at: string }>;
  /** Keyed requests with no stored send for their reply key. */
  unanswered: InboundRequest[];
  /** Keyed requests whose reply key is only `attempted` or whose stored evidence is inconsistent. */
  uncertain: InboundRequest[];
  /** Requests without a usable reply identity (legacy, peer path, not Leader-routed). Never answered, never certified unanswered. */
  unverified: InboundRequest[];
  /** Verdict per distinct request id, shared by duplicate journal rows of that request. */
  byRequestId: Map<string, { verdict: Exclude<SlackReplyVerdict, 'unverified'>; replyTs?: string }>;
  rejected: number;
  futureDated: number;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Compare validated decimal timestamps without floating point conversion. */
function compareTs(a: string, b: string): number {
  const [aSeconds, aFraction] = a.split('.');
  const [bSeconds, bFraction] = b.split('.');
  const left = aSeconds.replace(/^0+(?=\d)/, '');
  const right = bSeconds.replace(/^0+(?=\d)/, '');
  const width = Math.max(6, aFraction.length, bFraction.length);
  return left.length - right.length || compareText(left, right) ||
    compareText(aFraction.padEnd(width, '0'), bFraction.padEnd(width, '0'));
}

/** Canonical decimal identity for a validated ts: insignificant zeros removed. */
function canonicalTs(ts: string): string {
  const dot = ts.indexOf('.');
  const whole = ts.slice(0, dot).replace(/^0+(?=\d)/, '') || '0';
  const frac = ts.slice(dot + 1).replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

function compareRequests(a: InboundRequest, b: InboundRequest): number {
  return compareText(a.channelId, b.channelId) || compareTs(a.threadTs, b.threadTs) ||
    compareText(a.threadTs, b.threadTs) || compareTs(a.messageTs, b.messageTs) ||
    compareText(a.messageTs, b.messageTs) || compareText(a.at, b.at);
}

/**
 * Pure causal binding. A request is answered only by the stored `sent` receipt
 * whose send-store key equals the key the Leader derives for that request's
 * reply. That key is correlation evidence that the send was produced for the
 * request, not proof the content answered it. No clock is compared between
 * hosts: `ts > messageTs` is only a same-Slack-clock consistency check on the
 * matched receipt. There is no time-based fallback, so a request without a
 * reply identity is `unverified`, an exact-key `attempted` send is `uncertain`,
 * and an old reply for a different request can never answer a later one.
 */
export function bindSlackReplies(input: {
  requests: InboundRequest[];
  receipts: SentReceipt[];
  now: Date;
}): SlackReplyBinding {
  const result: SlackReplyBinding = {
    answered: [], unanswered: [], uncertain: [], unverified: [], byRequestId: new Map(), rejected: 0, futureDated: 0,
  };
  if (!record(input)) return result;
  const requests: unknown[] = Array.isArray(input.requests) ? input.requests : [];
  const receipts: unknown[] = Array.isArray(input.receipts) ? input.receipts : [];
  const now = input.now instanceof Date ? input.now.getTime() : NaN;
  if (!Number.isFinite(now)) {
    result.rejected = requests.length + receipts.length;
    return result;
  }
  const cutoffMs = now + 5_000;
  const cutoff = `${Math.floor(cutoffMs / 1_000)}.${String(cutoffMs % 1_000).padStart(3, '0')}`;
  const validRequests: InboundRequest[] = [];
  for (const row of requests) {
    if (!record(row) || !isSlackChannelId(row.channelId) || !isSlackTs(row.messageTs) ||
        !isSlackTs(row.threadTs) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at)) ||
        (row.requestId !== undefined && !isSlackRequestId(row.requestId))) {
      result.rejected++;
    } else if (Date.parse(row.at) > now) {
      result.futureDated++;
    } else {
      // Project only evidence fields, even when callers supply additional payloads.
      validRequests.push({ channelId: row.channelId, threadTs: row.threadTs, messageTs: row.messageTs, at: row.at,
        ...(row.requestId !== undefined ? { requestId: row.requestId } : {}) });
    }
  }
  // Sent evidence identifies a physical message by channel + canonical ts (Slack
  // ts is unique per channel). A physical message recorded under conflicting threads (including
  // top-level) or multiple send keys proves no answer. Attempts never establish or override sent evidence.
  const physical = new Map<string, { channel: string; thread?: string; ts: string; conflicted: boolean; keys: Set<string> }>();
  const attemptedKeys = new Set<string>();
  for (const row of receipts) {
    // Attempted receipts legitimately have no ts, but malformed evidence is still rejected.
    if (!record(row) || (row.state !== 'attempted' && row.state !== 'sent') || !isSlackChannelId(row.channel) ||
        (row.ts !== undefined && !isSlackTs(row.ts)) ||
        (row.thread !== undefined && !isSlackTs(row.thread)) ||
        (row.key !== undefined && !isSlackSendStoreKey(row.key))) {
      result.rejected++;
    } else if (row.state === 'attempted') {
      if (typeof row.key === 'string') attemptedKeys.add(row.key);
    } else if (!isSlackTs(row.ts)) {
      result.rejected++;
    } else if (cutoffMs < 0 || compareTs(row.ts, cutoff) > 0) {
      result.futureDated++;
    } else {
      const id = `${row.channel}:${canonicalTs(row.ts)}`;
      const kept = physical.get(id);
      if (kept) {
        if (kept.thread === undefined ? row.thread !== undefined :
            row.thread === undefined || canonicalTs(kept.thread) !== canonicalTs(row.thread)) kept.conflicted = true;
        if (compareText(row.ts, kept.ts) < 0) kept.ts = row.ts;
        if (typeof row.key === 'string') kept.keys.add(row.key);
      } else {
        physical.set(id, { channel: row.channel, thread: row.thread, ts: row.ts, conflicted: false,
          keys: new Set(typeof row.key === 'string' ? [row.key] : []) });
      }
    }
  }
  const sentByKey = new Map<string, Array<{ channel: string; thread?: string; ts: string; conflicted: boolean; keys: Set<string> }>>();
  for (const p of physical.values()) {
    for (const key of p.keys) sentByKey.set(key, [...(sentByKey.get(key) ?? []), p]);
  }
  // One request id is one request: duplicate journal rows of it share a verdict
  // and the earliest receipt stands for it in the lists.
  const ordered = validRequests.sort(compareRequests);
  // Rows sharing a requestId must describe the same message. If they disagree
  // (different channel, thread or message ts) the evidence is inconsistent: fail
  // closed as uncertain for every such row instead of letting the first row win.
  const location = (r: InboundRequest): string => `${r.channelId}:${canonicalTs(r.threadTs)}:${canonicalTs(r.messageTs)}`;
  const seenLocation = new Map<string, string>();
  const inconsistentIds = new Set<string>();
  for (const request of ordered) {
    if (request.requestId === undefined) continue;
    const first = seenLocation.get(request.requestId);
    if (first === undefined) seenLocation.set(request.requestId, location(request));
    else if (first !== location(request)) inconsistentIds.add(request.requestId);
  }
  for (const request of ordered) {
    const id = request.requestId;
    if (id === undefined) {
      result.unverified.push(request);
      continue;
    }
    if (inconsistentIds.has(id)) {
      result.byRequestId.set(id, { verdict: 'uncertain' });
      result.uncertain.push(request);
      continue;
    }
    if (result.byRequestId.has(id)) continue;
    const key = leaderReplySendKey(id);
    const sent = sentByKey.get(key);
    let verdict: Exclude<SlackReplyVerdict, 'unverified'> = 'unanswered';
    let replyTs: string | undefined;
    if (sent !== undefined) {
      // Exactly one consistent physical message in this request's own thread,
      // after the request message on the same Slack clock.
      const ok = sent.length === 1 && !sent[0]!.conflicted && sent[0]!.keys.size === 1 && sent[0]!.channel === request.channelId &&
        sent[0]!.thread !== undefined && canonicalTs(sent[0]!.thread) === canonicalTs(request.threadTs) && compareTs(sent[0]!.ts, request.messageTs) > 0;
      if (ok) { verdict = 'answered'; replyTs = sent[0]!.ts; } else verdict = 'uncertain';
    } else if (attemptedKeys.has(key)) {
      verdict = 'uncertain';
    }
    result.byRequestId.set(id, { verdict, ...(replyTs !== undefined ? { replyTs } : {}) });
    if (verdict === 'answered') {
      result.answered.push({ channelId: request.channelId, threadTs: request.threadTs,
        messageTs: request.messageTs, replyTs: replyTs!, requestId: id, at: request.at });
    } else if (verdict === 'uncertain') result.uncertain.push(request);
    else result.unanswered.push(request);
  }
  return result;
}
