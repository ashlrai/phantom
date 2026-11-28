/**
 * Per-request Slack trace (RQ-PHX-SLACKTRACEVERB339): for every ingested
 * journal entry that carries the ids a reply can bind to, join the durable
 * ingress receipt (journal `bus` outcome) with the send-store evidence and
 * report one outcome. Binding is causal, not temporal: a request is ANSWERED
 * only by the `sent` receipt stored under the exact key of its Leader reply
 * (journaled `requestId`), UNCERTAIN when that key is only `attempted` or its
 * stored evidence is inconsistent, UNANSWERED when no send exists for the key,
 * and BUS-FAILED when the bus append failed (reply evidence is still kept).
 * Rows with no reply identity (legacy rows, the peer path, owner requests not
 * routed to the Leader) are UNCERTAIN with `evidence: 'unverified'`: they are
 * never claimed answered and never certified unanswered, and no timestamp
 * fallback is used. A matching key is correlation evidence, not proof that the
 * content answered the request. Unknown ingress never reports a replyTs.
 * Message text, author ids, request ids and paths are never read or repeated;
 * the output is ids and timestamps only.
 */
import { readSlackJournal, type SlackJournalRead, type SlackObservation } from './slack-journal.js';
import { isSlackChannelId, isSlackTs } from './slack-network.js';
import { readSlackSendReceipts, type SlackSendReceiptRead } from './slack-send-receipts.js';
import { bindSlackReplies, type InboundRequest, type SentReceipt } from './slack-reply-binding.js';

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
  /** `sent` receipt ts bound by exact reply key; on bus failure this does not prove execution. */
  replyTs?: string;
  /** `unverified` when the row has no reply identity, so no answer can be proven or ruled out. */
  evidence?: 'unverified';
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
    pending.push({
      req: { at: entry.at, channelId: entry.channelId, messageTs: entry.messageTs, threadTs: entry.threadTs,
        ...(entry.requestId !== undefined ? { requestId: entry.requestId } : {}) },
      ingress: entry.bus ?? 'unknown',
    });
  }
  // Bind all observations before filtering output: a conflicting location in a
  // different ingress state or thread must not certify this request as answered.
  const binding = bindSlackReplies({ requests: pending.map((p) => p.req), receipts, now });
  const nowMs = now.getTime();
  const eligible = (req: InboundRequest): boolean =>
    isSlackChannelId(req.channelId) && isSlackTs(req.messageTs) && isSlackTs(req.threadTs) &&
    Number.isFinite(Date.parse(req.at)) && Date.parse(req.at) <= nowMs;
  const counts = { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  const rows: SlackTraceRow[] = pending.filter((p) => input.thread === undefined || p.req.threadTs === input.thread).map((p) => {
    const { req, ingress } = p;
    const { requestId, ...evidence } = req;
    const row: SlackTraceRow = { ...evidence, ingress, outcome: 'unanswered' };
    const found = requestId !== undefined && eligible(req)
      ? binding.byRequestId.get(requestId) : undefined;
    if (ingress === 'failed') {
      row.outcome = 'bus-failed';
      if (found?.replyTs !== undefined) row.replyTs = found.replyTs;
      if (requestId === undefined) row.evidence = 'unverified';
    } else if (requestId === undefined) {
      // No reply identity (legacy, peer path, or not Leader-routed): neither
      // answered nor certified unanswered.
      row.outcome = 'uncertain';
      row.evidence = 'unverified';
    } else if (found?.verdict === 'answered' && (ingress === 'posted' || ingress === 'duplicate')) {
      row.outcome = 'answered';
      row.replyTs = found.replyTs!;
    } else if (found?.verdict === 'uncertain' || found?.verdict === 'answered') {
      // Exact-key attempt, inconsistent stored evidence, or a send whose
      // ingress was never durably recorded: transport cannot prove it.
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
