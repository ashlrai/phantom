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
 * delivered it. Thread keys are Slack ids/timestamps; tokens, author ids
 * and file paths never enter the view. */
import { existsSync } from 'node:fs';
import { loadAgentNetworkConfig } from '../agents/slack-network.js';
import { readFleetBoard } from './coordination.js';
import { claimNoticeDir, claimNoticeFileDeps, claimNoticePaths, readClaimNoticeSentRows,
  readClaimThreadBindings, runClaimNoticePass, type ClaimNoticeSendDeps } from './claim-notice-send.js';

export const CLAIM_NOTICE_VIEW_ROWS = 20;
export const CLAIM_NOTICE_VIEW_TEXT = 300;

export interface ClaimNoticeView {
  v: 1;
  generatedAt: string;
  source: 'ok' | 'missing' | 'unreadable';
  bindings: number;
  sent: { total: number; recent: Array<{ state: string; claimId: string; at: number }> };
  pending: Array<{ state: string; threadKey: string; text: string }>;
  slackConfigured: boolean | 'unknown';
}

export interface ClaimNoticeViewOpts {
  runsRoot?: string;
  now?: () => number;
  readBoard?: ClaimNoticeSendDeps['readBoard'];
  readConfig?: () => ReturnType<typeof loadAgentNetworkConfig>;
}

/** Dedupe keys are JSON arrays led by the state (see planClaimThreadNotices):
 * [state, id, tail] | [state, repo, id, tail] | [state, repo, id, agent, claimedAt, tail].
 * Anything else is unparseable: never guess. */
export function parseClaimNoticeKey(key: string): { state: string; claimId: string } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(key); } catch { return null; }
  if (!Array.isArray(parsed) || !parsed.every(part => typeof part === 'string' || typeof part === 'number')) return null;
  const idIndex = parsed.length === 3 ? 1 : parsed.length === 4 || parsed.length === 6 ? 2 : -1;
  const state = parsed[0], claimId = parsed[idIndex];
  if (idIndex < 0 || typeof state !== 'string' || typeof claimId !== 'string' || !state || !claimId) return null;
  return { state, claimId };
}

const neverSend: ClaimNoticeSendDeps['send'] = () => { throw new Error('claim-notice view is read-only'); };

export async function readClaimNoticeView(opts: ClaimNoticeViewOpts = {}): Promise<ClaimNoticeView> {
  const now = opts.now ?? Date.now;
  const root = claimNoticeDir(opts.runsRoot);
  const base = { v: 1 as const, generatedAt: new Date(now()).toISOString() };
  let slackConfigured: ClaimNoticeView['slackConfigured'] = 'unknown';
  try {
    const cfg = (opts.readConfig ?? loadAgentNetworkConfig)();
    slackConfigured = cfg.state === 'ok' ? cfg.slack !== undefined && cfg.slack !== 'invalid'
      : cfg.state === 'missing' ? false : 'unknown';
  } catch { /* stays unknown */ }
  const empty = (source: 'missing' | 'unreadable'): ClaimNoticeView =>
    ({ ...base, source, bindings: 0, sent: { total: 0, recent: [] }, pending: [], slackConfigured });
  if (!existsSync(root)) return empty('missing');

  const paths = claimNoticePaths(root);
  const rows = readClaimNoticeSentRows(paths.sent);
  if (rows === null) return empty('unreadable');
  const recent: ClaimNoticeView['sent']['recent'] = [];
  for (const row of [...rows].reverse()) {
    if (recent.length >= CLAIM_NOTICE_VIEW_ROWS) break;
    const parsed = parseClaimNoticeKey(row.key);
    if (parsed !== null) recent.push({ ...parsed, at: row.at });
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

  return { ...base, source: 'ok', bindings: readClaimThreadBindings(paths.bindings).length,
    sent: { total: rows.length, recent }, pending, slackConfigured };
}
