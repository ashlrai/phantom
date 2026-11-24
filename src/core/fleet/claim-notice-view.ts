/** Read-only view of the Slack claim-notice state for the desktop console.
 *
 * Reads the same files `ashlr fleet claim-notices` writes (bindings, sent
 * ledger, previous snapshot) through the existing readers, plus one DRY-RUN
 * pass to show what Phantom would post next. Nothing is sent, ledgered or
 * appended to the bus: the dry-run path of `runClaimNoticePass` never calls
 * `send` or `writePrevSnapshot`, and the stubs below throw if that ever
 * changes. The ~/.ashlr/KILL switch is therefore irrelevant here: it halts
 * outward sends and this module sends nothing.
 *
 * A "sent" row means a durable bus note was written, NOT that Slack
 * delivered it. To keep that distinction honest each recent row also carries
 * `delivery`, which joins the row's claim binding onto the Slack transport's
 * own outbound send store: 'slack-sent' only when the exact notice identity has
 * a same-channel, same-thread `sent` receipt with a well-formed Slack ts at-or-after the ledger
 * time (minus skew) and no later than the collection time, 'no-slack-receipt'
 * when the store is healthy but nothing matches, 'unknown' whenever the evidence
 * itself is incomplete (missing or ambiguous binding, unparseable threadKey,
 * missing/degraded/thrown store read). Thread keys are Slack ids/timestamps;
 * tokens, author ids and file paths never enter the view. */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { slackSendStoreKey } from '../agents/slack-reply-identity.js';
import { isSlackTs, loadAgentNetworkConfig } from '../agents/slack-network.js';
import { readSlackSendReceipts, type SlackSendReceiptRead } from '../agents/slack-send-receipts.js';
import { parseNoticeThreadRef } from '../../cli/fleet-claim-notices.js';
import { readFleetBoard, type FleetBoard } from './coordination.js';
import { claimNoticeDir, claimNoticeFileDeps, claimNoticePaths, readClaimNoticeSentRows,
  readClaimThreadBindings, runClaimNoticePass, type ClaimNoticeSendDeps } from './claim-notice-send.js';

export const CLAIM_NOTICE_VIEW_ROWS = 20;
export const CLAIM_NOTICE_VIEW_TEXT = 300;
/** Slack `ts` is written when the API call lands; a ledger row and its
 * receipt differ by queueing and clock skew, not intent. */
export const CLAIM_NOTICE_RECEIPT_SKEW_MS = 120_000;

/** Cap on agent/repo/claimId strings copied into the view (labels are untrusted). */
export const CLAIM_NOTICE_UNBOUND_TEXT = 128;

export type ClaimNoticeDeliveryWord = 'slack-sent' | 'no-slack-receipt' | 'unknown';

export interface ClaimNoticeDeliverySummary {
  sendStore: 'ok' | 'missing' | 'degraded';
  slackSent: number;
  noReceipt: number;
  unknown: number;
}

/** Fixed, sanitized reasons a pending observation could not be made. */
export type ClaimNoticePendingUnknownReason = 'state-missing' | 'ledger-unavailable' | 'board-unavailable'
  | 'bindings-unavailable' | 'prev-unavailable' | 'observation-failed';

/** 'known' only after a successful dry-run pass, so `pending: []` under
 * 'known' means nothing awaits delivery. Under 'unknown' `pending` is `[]`
 * only for compatibility and says nothing. Diagnostic, never dispatch authority. */
export type ClaimNoticePendingObservation =
  | { state: 'known' }
  | { state: 'unknown'; reason: ClaimNoticePendingUnknownReason };

export interface ClaimNoticeView {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'missing' | 'unreadable';
  bindings: number;
  sent: { total: number; recent: Array<{ state: string; claimId: string; at: number; delivery: ClaimNoticeDeliveryWord }> };
  /** Counts over the listed `sent.recent` rows plus the send-store state they were read under. */
  delivery: ClaimNoticeDeliverySummary;
  pending: Array<{ state: string; threadKey: string; text: string }>;
  /** Whether `pending` was actually observed; independent of `delivery` receipts. */
  pendingObservation: ClaimNoticePendingObservation;
  /** Live claims with no binding: runClaimNoticePass drops every notice for them.
   * 'unknown' whenever the board could not be read as known; never an empty-list guess.
   * Task text is deliberately not carried. */
  unbound: { state: 'known' | 'unknown'; total: number;
    rows: Array<{ claimId: string; repo: string; agent: string; claimedAt: number }> };
  slackConfigured: boolean | 'unknown';
}

export interface ClaimNoticeViewOpts {
  runsRoot?: string;
  now?: () => number;
  readBoard?: ClaimNoticeSendDeps['readBoard'];
  readConfig?: () => ReturnType<typeof loadAgentNetworkConfig>;
  /** Slack transport send-store read; defaults to `readSlackSendReceipts()`.
   * A throwing reader is reported as a degraded store, never a fake success. */
  readSendReceipts?: () => SlackSendReceiptRead;
}

/** Dedupe keys are JSON arrays led by the state (see planClaimThreadNotices):
 * [state, id, tail] | [state, repo, id, tail] | [state, repo, id, agent, claimedAt, tail].
 * The repo slot exists only on the 4- and 6-part shapes. Anything else is
 * unparseable: never guess. */
export function parseClaimNoticeKey(key: string): { state: string; claimId: string; repo?: string } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.every(part => typeof part === 'string' || typeof part === 'number')) return null;
  const idIndex = parsed.length === 3 ? 1 : parsed.length === 4 || parsed.length === 6 ? 2 : -1;
  const state = parsed[0], claimId = parsed[idIndex];
  if (idIndex < 0 || typeof state !== 'string' || typeof claimId !== 'string' || !state || !claimId) return null;
  const repo = idIndex === 2 && typeof parsed[1] === 'string' && parsed[1] !== '' ? parsed[1] : undefined;
  return repo === undefined ? { state, claimId } : { state, claimId, repo };
}

const neverSend: ClaimNoticeSendDeps['send'] = () => { throw new Error('claim-notice view is read-only'); };

export async function readClaimNoticeView(opts: ClaimNoticeViewOpts = {}): Promise<ClaimNoticeView> {
  const now = opts.now ?? Date.now;
  // One captured collection time stamps generatedAt and bounds receipt
  // eligibility above, so a receipt cannot claim a send that has not happened.
  const collectedAtMs = now();
  const root = claimNoticeDir(opts.runsRoot);
  let sendStore: SlackSendReceiptRead;
  try {
    sendStore = (opts.readSendReceipts ?? (() => readSlackSendReceipts()))();
  } catch {
    sendStore = { state: 'degraded', receipts: [] };
  }
  const summary = (recent: ReadonlyArray<{ delivery: ClaimNoticeDeliveryWord }>): ClaimNoticeDeliverySummary => ({
    sendStore: sendStore.state,
    slackSent: recent.filter(r => r.delivery === 'slack-sent').length,
    noReceipt: recent.filter(r => r.delivery === 'no-slack-receipt').length,
    unknown: recent.filter(r => r.delivery === 'unknown').length,
  });
  const base = { v: 1 as const, generatedAt: new Date(collectedAtMs).toISOString() };
  let slackConfigured: ClaimNoticeView['slackConfigured'] = 'unknown';
  try {
    const cfg = (opts.readConfig ?? loadAgentNetworkConfig)();
    slackConfigured = cfg.state === 'ok' ? cfg.slack !== undefined && cfg.slack !== 'invalid'
      : cfg.state === 'missing' ? false : 'unknown';
  } catch { /* stays unknown */ }
  const empty = (source: 'missing' | 'unreadable'): ClaimNoticeView =>
    ({ ...base, source, bindings: 0, sent: { total: 0, recent: [] }, delivery: summary([]), pending: [],
      pendingObservation: { state: 'unknown', reason: source === 'missing' ? 'state-missing' : 'ledger-unavailable' },
      unbound: { state: 'unknown', total: 0, rows: [] }, slackConfigured });
  if (!existsSync(root)) return empty('missing');

  const paths = claimNoticePaths(root);
  const rows = readClaimNoticeSentRows(paths.sent);
  if (rows === null) return empty('unreadable');
  const bindings = readClaimThreadBindings(paths.bindings);
  const classify = (claimId: string, repo: string | undefined, at: number, dedupeKey: string): ClaimNoticeDeliveryWord => {
    // A non-ok store can hide receipts; only a healthy read may say "none matched".
    if (sendStore.state !== 'ok') return 'unknown';
    const threads = new Set(bindings
      .filter(b => b.claimId === claimId && (repo === undefined || b.repo === repo))
      .map(b => b.threadKey));
    // Zero bindings, or several threads for a repo-less key: never guess.
    if (threads.size !== 1) return 'unknown';
    const ref = parseNoticeThreadRef(threads.values().next().value!);
    if (ref === null) return 'unknown';
    const floorSeconds = (at - CLAIM_NOTICE_RECEIPT_SKEW_MS) / 1000;
    const ceilingSeconds = collectedAtMs / 1000;
    // Match the producer's envelope id and the transport's store key exactly.
    // Thread/time proximity alone cannot identify which transition was sent.
    const envelopeId = `claim-notice-${createHash('sha256').update(dedupeKey).digest('hex').slice(0, 24)}`;
    const key = slackSendStoreKey(envelopeId);
    return sendStore.receipts.some(r => r.key === key && r.state === 'sent' && r.channel === ref.channelId &&
        r.thread === ref.threadTs && isSlackTs(r.ts) &&
        Number(r.ts) >= floorSeconds && Number(r.ts) <= ceilingSeconds)
      ? 'slack-sent' : 'no-slack-receipt';
  };
  const recent: ClaimNoticeView['sent']['recent'] = [];
  for (const row of [...rows].reverse()) {
    if (recent.length >= CLAIM_NOTICE_VIEW_ROWS) break;
    const parsed = parseClaimNoticeKey(row.key);
    if (parsed !== null) {
      recent.push({ state: parsed.state, claimId: parsed.claimId, at: row.at,
        delivery: classify(parsed.claimId, parsed.repo, row.at, row.key) });
    }
  }

  // One board read, shared by the unbound list and the dry run below.
  let boardRead: { board: FleetBoard } | { error: unknown };
  try { boardRead = { board: (opts.readBoard ?? (() => readFleetBoard({ now: collectedAtMs })))() }; }
  catch (error) { boardRead = { error }; }
  const readBoardOnce = (): FleetBoard => {
    if ('error' in boardRead) throw boardRead.error;
    return boardRead.board;
  };
  let unbound: ClaimNoticeView['unbound'] = { state: 'unknown', total: 0, rows: [] };
  if ('board' in boardRead && boardRead.board.state === 'known') {
    const bound = new Set(bindings.map(b => JSON.stringify([b.repo, b.claimId])));
    const live = boardRead.board.claims
      .filter(c => c.expiresAt > collectedAtMs && !bound.has(JSON.stringify([c.repo, c.id])))
      .sort((a, b) => b.claimedAt - a.claimedAt);
    const cap = (v: string) => v.slice(0, CLAIM_NOTICE_UNBOUND_TEXT);
    unbound = { state: 'known', total: live.length, rows: live.slice(0, CLAIM_NOTICE_VIEW_ROWS)
      .map(c => ({ claimId: cap(c.id), repo: cap(c.repo), agent: cap(c.agent), claimedAt: c.claimedAt })) };
  }

  const files = claimNoticeFileDeps(root);
  let pending: ClaimNoticeView['pending'] = [];
  let pendingObservation: ClaimNoticePendingObservation = { state: 'unknown', reason: 'observation-failed' };
  try {
    const pass = await runClaimNoticePass({
      ...files,
      readBoard: readBoardOnce,
      writePrevSnapshot: () => { throw new Error('claim-notice view is read-only'); },
      appendSentLedger: () => { throw new Error('claim-notice view is read-only'); },
      send: neverSend, now: () => collectedAtMs, dryRun: true,
    });
    if (pass.status === 'dry-run') pendingObservation = { state: 'known' };
    else if (pass.status !== 'completed') pendingObservation = { state: 'unknown', reason: pass.status };
    if (pass.status === 'dry-run') pending = pass.deliveries.filter(d => d.result === 'planned').slice(0, CLAIM_NOTICE_VIEW_ROWS)
      .map(d => ({ state: d.state, threadKey: d.threadKey, text: d.text.slice(0, CLAIM_NOTICE_VIEW_TEXT) }));
  } catch {
    // A thrown board read is a board outage; anything else stays 'observation-failed'.
    if ('error' in boardRead) pendingObservation = { state: 'unknown', reason: 'board-unavailable' };
  }

  return { ...base, source: 'ok', bindings: bindings.length,
    sent: { total: rows.length, recent }, delivery: summary(recent), pending, pendingObservation, unbound, slackConfigured };
}
