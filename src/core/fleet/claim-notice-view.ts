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
 * own outbound send store: 'slack-sent' only when a same-channel, same-thread
 * `sent` receipt exists at-or-after the ledger time, 'no-slack-receipt' when
 * the store is healthy but nothing matches, 'unknown' whenever the evidence
 * itself is incomplete (missing or ambiguous binding, unparseable threadKey,
 * missing/degraded/thrown store read). Thread keys are Slack ids/timestamps;
 * tokens, author ids and file paths never enter the view. */
import { existsSync } from 'node:fs';
import { loadAgentNetworkConfig } from '../agents/slack-network.js';
import { readSlackSendReceipts, type SlackSendReceiptRead } from '../agents/slack-send-receipts.js';
import { parseNoticeThreadRef } from '../../cli/fleet-claim-notices.js';
import { readFleetBoard } from './coordination.js';
import { claimNoticeDir, claimNoticeFileDeps, claimNoticePaths, readClaimNoticeSentRows,
  readClaimThreadBindings, runClaimNoticePass, type ClaimNoticeSendDeps } from './claim-notice-send.js';

export const CLAIM_NOTICE_VIEW_ROWS = 20;
export const CLAIM_NOTICE_VIEW_TEXT = 300;
/** Slack `ts` is written when the API call lands; a ledger row and its
 * receipt differ by queueing and clock skew, not intent. */
export const CLAIM_NOTICE_RECEIPT_SKEW_MS = 120_000;

export type ClaimNoticeDeliveryWord = 'slack-sent' | 'no-slack-receipt' | 'unknown';

export interface ClaimNoticeDeliverySummary {
  sendStore: 'ok' | 'missing' | 'degraded';
  slackSent: number;
  noReceipt: number;
  unknown: number;
}

export interface ClaimNoticeView {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'missing' | 'unreadable';
  bindings: number;
  sent: { total: number; recent: Array<{ state: string; claimId: string; at: number; delivery: ClaimNoticeDeliveryWord }> };
  /** Counts over the listed `sent.recent` rows plus the send-store state they were read under. */
  delivery: ClaimNoticeDeliverySummary;
  pending: Array<{ state: string; threadKey: string; text: string }>;
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
  const base = { v: 1 as const, generatedAt: new Date(now()).toISOString() };
  let slackConfigured: ClaimNoticeView['slackConfigured'] = 'unknown';
  try {
    const cfg = (opts.readConfig ?? loadAgentNetworkConfig)();
    slackConfigured = cfg.state === 'ok' ? cfg.slack !== undefined && cfg.slack !== 'invalid'
      : cfg.state === 'missing' ? false : 'unknown';
  } catch { /* stays unknown */ }
  const empty = (source: 'missing' | 'unreadable'): ClaimNoticeView =>
    ({ ...base, source, bindings: 0, sent: { total: 0, recent: [] }, delivery: summary([]), pending: [], slackConfigured });
  if (!existsSync(root)) return empty('missing');

  const paths = claimNoticePaths(root);
  const rows = readClaimNoticeSentRows(paths.sent);
  if (rows === null) return empty('unreadable');
  const bindings = readClaimThreadBindings(paths.bindings);
  const classify = (claimId: string, repo: string | undefined, at: number): ClaimNoticeDeliveryWord => {
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
    return sendStore.receipts.some(r => r.state === 'sent' && r.channel === ref.channelId &&
        r.thread === ref.threadTs && r.ts !== undefined && Number(r.ts) >= floorSeconds)
      ? 'slack-sent' : 'no-slack-receipt';
  };
  const recent: ClaimNoticeView['sent']['recent'] = [];
  for (const row of [...rows].reverse()) {
    if (recent.length >= CLAIM_NOTICE_VIEW_ROWS) break;
    const parsed = parseClaimNoticeKey(row.key);
    if (parsed !== null) {
      recent.push({ state: parsed.state, claimId: parsed.claimId, at: row.at,
        delivery: classify(parsed.claimId, parsed.repo, row.at) });
    }
  }

  const files = claimNoticeFileDeps(root);
  let pending: ClaimNoticeView['pending'] = [];
  try {
    const pass = await runClaimNoticePass({
      ...files,
      readBoard: opts.readBoard ?? (() => readFleetBoard({ now: now() })),
      writePrevSnapshot: () => { throw new Error('claim-notice view is read-only'); },
      appendSentLedger: () => { throw new Error('claim-notice view is read-only'); },
      send: neverSend, now, dryRun: true,
    });
    pending = pass.deliveries.filter(d => d.result === 'planned').slice(0, CLAIM_NOTICE_VIEW_ROWS)
      .map(d => ({ state: d.state, threadKey: d.threadKey, text: d.text.slice(0, CLAIM_NOTICE_VIEW_TEXT) }));
  } catch { /* pending stays empty; the sent half is still honest */ }

  return { ...base, source: 'ok', bindings: bindings.length,
    sent: { total: rows.length, recent }, delivery: summary(recent), pending, slackConfigured };
}
