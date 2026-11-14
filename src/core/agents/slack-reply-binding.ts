import { isSlackChannelId, isSlackTs } from './slack-network.js';

export interface InboundRequest {
  at: string;
  channelId: string;
  messageTs: string;
  threadTs: string;
}

export interface SentReceipt {
  channel: string;
  thread?: string;
  state: 'attempted' | 'sent';
  ts?: string;
}

export interface SlackReplyBinding {
  answered: Array<{ channelId: string; threadTs: string; messageTs: string; replyTs: string }>;
  unanswered: InboundRequest[];
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

/** Pure, one-to-one evidence binding; a send attempt or a top-level send is no answer. */
export function bindSlackReplies(input: {
  requests: InboundRequest[];
  receipts: SentReceipt[];
  now: Date;
}): SlackReplyBinding {
  const result: SlackReplyBinding = { answered: [], unanswered: [], rejected: 0, futureDated: 0 };
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
        !isSlackTs(row.threadTs) || typeof row.at !== 'string' || !Number.isFinite(Date.parse(row.at))) {
      result.rejected++;
    } else if (Date.parse(row.at) > now) {
      result.futureDated++;
    } else {
      // Project only evidence fields, even when callers supply additional payloads.
      validRequests.push({ channelId: row.channelId, threadTs: row.threadTs, messageTs: row.messageTs, at: row.at });
    }
  }
  const threads = new Map<string, { replies: string[]; next: number }>();
  for (const row of receipts) {
    // Attempted receipts legitimately have no ts, but malformed evidence is still rejected.
    if (!record(row) || (row.state !== 'attempted' && row.state !== 'sent') || !isSlackChannelId(row.channel) ||
        (row.ts !== undefined && !isSlackTs(row.ts)) ||
        (row.thread !== undefined && !isSlackTs(row.thread))) {
      result.rejected++;
    } else if (row.state === 'attempted') {
      continue;
    } else if (!isSlackTs(row.ts)) {
      result.rejected++;
    } else if (cutoffMs < 0 || compareTs(row.ts, cutoff) > 0) {
      result.futureDated++;
    } else if (row.thread !== undefined) {
      const key = `${row.channel}:${row.thread}`;
      const thread = threads.get(key) ?? { replies: [], next: 0 };
      thread.replies.push(row.ts);
      threads.set(key, thread);
    }
  }
  for (const thread of threads.values()) {
    // One physical reply proves at most one answer per thread: collapse replayed
    // receipts and decimal-equivalent spellings to a single evidence entry.
    const unique = new Map<string, string>();
    for (const ts of thread.replies) {
      const id = canonicalTs(ts);
      const kept = unique.get(id);
      if (kept === undefined || compareText(ts, kept) < 0) unique.set(id, ts);
    }
    thread.replies = [...unique.values()].sort((a, b) => compareTs(a, b) || compareText(a, b));
  }
  for (const request of validRequests.sort(compareRequests)) {
    const thread = threads.get(`${request.channelId}:${request.threadTs}`);
    while (thread && thread.next < thread.replies.length &&
           compareTs(thread.replies[thread.next], request.messageTs) <= 0) thread.next++;
    if (thread && thread.next < thread.replies.length) {
      result.answered.push({ channelId: request.channelId, threadTs: request.threadTs,
        messageTs: request.messageTs, replyTs: thread.replies[thread.next++] });
    } else {
      result.unanswered.push(request);
    }
  }
  return result;
}
