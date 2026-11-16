/**
 * Per-request Slack trace (RQ-PHX-SLACKTRACEVERB339): for every ingested
 * journal entry that carries the ids a reply can bind to, join the durable
 * ingress receipt (journal `bus` outcome) with the send-store evidence and
 * report one outcome -- BUS-FAILED when the bus append failed, ANSWERED by a same-thread `sent` receipt, UNCERTAIN
 * when a timestamped `attempted` send could follow the request, else UNANSWERED. bus=failed rows keep their reply
 * evidence but never compete for the one-to-one successful-answer allocation. Message text, author ids and paths are
 * never read or repeated; the output is ids and timestamps only.
 */
import { readSlackJournal, type SlackJournalRead, type SlackObservation } from './slack-journal.js';
import { isSlackChannelId, isSlackTs } from './slack-network.js';
import { readSlackSendReceipts, type SlackSendReceiptRead } from './slack-send-receipts.js';
import { bindSlackReplies, type InboundRequest, type SentReceipt, type SlackReplyBinding } from './slack-reply-binding.js';

export type SlackTraceIngress = 'posted' | 'duplicate' | 'failed' | 'unknown';
export type SlackTraceOutcome = 'answered' | 'uncertain' | 'bus-failed' | 'unanswered';

export interface SlackTraceRow {
  /** ISO journal receive time. */
  at: string;
  channelId: string;
  threadTs: string;
  messageTs: string;
  /** Local bus append outcome recorded at ingress; `unknown` when the row carries none. */
  ingress: SlackTraceIngress;
  outcome: SlackTraceOutcome;
  /** Bound same-thread `sent` receipt ts; on bus failure this does not prove execution. */
  replyTs?: string;
}

export interface SlackRequestTrace {
  asOf: string;
  rows: SlackTraceRow[];
  counts: { total: number; answered: number; uncertain: number; busFailed: number; unanswered: number };
}

export interface SlackRequestTraceRead extends SlackRequestTrace {
  sources: { journal: SlackJournalRead['state']; sends: SlackSendReceiptRead['state'] };
}

export interface SlackRequestTraceOptions {
  runsDir?: string;
  stateRoot?: string;
  now?: () => Date;
  /** Restrict rows to one thread root ts. */
  thread?: string;
}

const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/**
 * Pure evidence join. Ingested entries missing channel/message/thread ids are
 * skipped (the same rule slackInboundRequests uses: they cannot be bound).
 * Rows sort oldest first by journal `at`.
 */
export function traceSlackRequests(input: {
  entries: readonly SlackObservation[];
  receipts: readonly SentReceipt[];
  now: Date;
  thread?: string;
}): SlackRequestTrace {
  const entries = Array.isArray(input.entries) ? input.entries : [];
  const receipts = Array.isArray(input.receipts) ? input.receipts : [];
  const now = input.now instanceof Date && Number.isFinite(input.now.getTime()) ? input.now : new Date(0);
  interface Pending { req: InboundRequest; ingress: SlackTraceIngress }
  const pending: Pending[] = [];
  for (const entry of entries) {
    if (entry.decision !== 'ingested' || !entry.channelId || !entry.messageTs || !entry.threadTs) continue;
    if (input.thread !== undefined && entry.threadTs !== input.thread) continue;
    pending.push({
      req: { at: entry.at, channelId: entry.channelId, messageTs: entry.messageTs, threadTs: entry.threadTs },
      ingress: entry.bus ?? 'unknown',
    });
  }
  // bus=failed rows never enter the successful-answer allocation: a failed
  // append must not consume the one receipt a later successful request needs.
  // They are bound separately below only to retain reply evidence.
  const bindableIndexes: number[] = [];
  const failedIndexes: number[] = [];
  pending.forEach((p, i) => (p.ingress === 'failed' ? failedIndexes : bindableIndexes).push(i));
  const binding = bindSlackReplies({
    requests: bindableIndexes.map((i) => pending[i]!.req), receipts, now,
  });
  const failedBinding = failedIndexes.length === 0 ? null : bindSlackReplies({
    requests: failedIndexes.map((i) => pending[i]!.req), receipts, now,
  });
  const nowMs = now.getTime();
  const eligible = (req: InboundRequest): boolean =>
    isSlackChannelId(req.channelId) && isSlackTs(req.messageTs) && isSlackTs(req.threadTs) &&
    Number.isFinite(Date.parse(req.at)) && Date.parse(req.at) <= nowMs;
  // The binder answers requests in compareRequests order; for journal rows
  // that share channel+thread+message ids that order reduces to `at`, so the
  // k-th oldest duplicate claims the k-th reply recorded for that key. Rows
  // the binder rejects or marks future-dated hold no rank and never answer.
  const replyTsByIndex = (
    indexes: readonly number[],
    answered: SlackReplyBinding['answered'],
  ): Map<number, string> => {
    const answersByKey = new Map<string, string[]>();
    for (const a of answered) {
      const key = `${a.channelId}:${a.threadTs}:${a.messageTs}`;
      const list = answersByKey.get(key) ?? [];
      list.push(a.replyTs);
      answersByKey.set(key, list);
    }
    const byKey = new Map<string, number[]>();
    for (const i of indexes) {
      if (!eligible(pending[i]!.req)) continue;
      const req = pending[i]!.req;
      const key = `${req.channelId}:${req.threadTs}:${req.messageTs}`;
      const list = byKey.get(key) ?? [];
      list.push(i);
      byKey.set(key, list);
    }
    const out = new Map<number, string>();
    for (const [key, group] of byKey) {
      const replies = answersByKey.get(key);
      if (replies === undefined) continue;
      group.sort((a, b) => compareText(pending[a]!.req.at, pending[b]!.req.at));
      group.forEach((i, rank) => {
        if (rank < replies.length) out.set(i, replies[rank]!);
      });
    }
    return out;
  };
  const answeredTs = replyTsByIndex(bindableIndexes, binding.answered);
  const failedTs = failedBinding === null ? new Map<number, string>()
    : replyTsByIndex(failedIndexes, failedBinding.answered);
  // An attempt has no request identity. Even with a timestamp, it only
  // establishes thread-level ambiguity, not a one-to-one association.
  // The transport normally writes attempts without ts; those cannot prove timing.
  const attempted = receipts.filter((r) => r && r.state === 'attempted' &&
    isSlackChannelId(r.channel) && isSlackTs(r.thread) && isSlackTs(r.ts));
  const hasAttempt = (req: InboundRequest): boolean => {
    if (!eligible(req)) return false;
    const receivedMs = BigInt(Date.parse(req.at));
    return attempted.some((r) => {
      if (r.channel !== req.channelId || r.thread !== req.threadTs || !r.ts) return false;
      const [seconds, fraction] = r.ts.split('.') as [string, string];
      // Compare decimal seconds exactly, including sub-millisecond precision.
      const scale = 10n ** BigInt(fraction.length);
      const attempt = BigInt(seconds) * scale + BigInt(fraction);
      return attempt * 1000n >= receivedMs * scale && attempt * 1000n <= BigInt(nowMs) * scale;
    });
  };
  const counts = { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  const rows: SlackTraceRow[] = pending.map((p, i) => {
    const { req, ingress } = p;
    const replyTs = ingress === 'failed' ? failedTs.get(i) : answeredTs.get(i);
    const row: SlackTraceRow = { ...req, ingress, outcome: 'unanswered' };
    if (replyTs !== undefined) row.replyTs = replyTs;
    if (ingress === 'failed') {
      row.outcome = 'bus-failed';
    } else if (row.replyTs !== undefined) {
      row.outcome = 'answered';
    } else if (hasAttempt(req)) {
      row.outcome = 'uncertain';
    }
    counts.total++;
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
    return row;
  });
  rows.sort((a, b) => compareText(a.at, b.at) || compareText(a.messageTs, b.messageTs) || compareText(a.channelId, b.channelId));
  return { asOf: now.toISOString(), rows, counts };
}

/** Read-only join of the on-disk journal and send store; never throws, never writes. */
export function readSlackRequestTrace(options: SlackRequestTraceOptions = {}): SlackRequestTraceRead {
  const now = options.now ?? (() => new Date());
  const journal = readSlackJournal({ ...(options.runsDir !== undefined ? { runsDir: options.runsDir } : {}), limit: 4096 });
  const sends = readSlackSendReceipts(options.stateRoot !== undefined ? { stateRoot: options.stateRoot } : {});
  const trace = traceSlackRequests({
    entries: journal.entries, receipts: sends.receipts, now: now(),
    ...(options.thread !== undefined ? { thread: options.thread } : {}),
  });
  return { ...trace, sources: { journal: journal.state, sends: sends.state } };
}
