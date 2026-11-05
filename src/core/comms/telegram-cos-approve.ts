/**
 * RQ-PHX-TELEGRAMCOSAPPROVE16: read and approve a chief-of-staff reply from
 * Telegram itself — the same chat that asked the question, without opening
 * the desktop Tasks card.
 *
 *   /cos                          — lists waiting Telegram-origin drafts
 *                                   (newest first, at most 3) each followed by
 *                                   the exact line to copy to approve it.
 *   /approve cos-<32hex> <12hex>  — approves the draft whose stored digest
 *                                   starts with the 12-hex code and sends it
 *                                   as a reply to the original message.
 *
 * Security: the approval binds to the stored digest only; no reply text is
 * ever taken from the message, and the 12-hex code must prefix-match the
 * CURRENT draft's digest, re-read at approve time — a stale or wrong code
 * refuses. Only drafts whose origin channel is Telegram can be listed or
 * approved here, and deliverCosResult's exclusive delivery claim refuses
 * every repeat: nothing auto-resends. Verified-owner private-chat gating is
 * the bridge's job before this module is invoked.
 *
 * Never throws: every failure maps to one fixed reply string.
 */

import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { cosStatus, type CosDraft } from '../cos/intake.js';
import type { AshlrConfig } from '../types.js';
import type { deliverTelegramCosResult, TelegramInboxDeps } from './telegram-inbox-bridge.js';

/** `/cos` (optionally @bot) lists waiting drafts. */
export const TELEGRAM_COS_LIST_RE = /^\/cos(?:@\w+)?$/;
/** `/approve <cos-id> <first 12 hex of the draft digest>` (optionally @bot). */
export const TELEGRAM_COS_APPROVE_RE = /^\/approve(?:@\w+)?\s+(cos-[a-f0-9]{32})\s+([a-f0-9]{12})$/;

const DRAFT_FILE = /^cos-[a-f0-9]{32}\.json$/;
const LIST_MAX = 3;
const TEXT_CLIP = 3_000;

/** Same root cos/intake.ts resolves: explicit runsDir, ASHLR_RUNS_DIR, ~/.ashlr-runs. */
const root = (runsDir?: string): string =>
  runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');

/**
 * Waiting Telegram-origin drafts, newest first by file mtime, at most 3.
 * A draft is waiting only while it needs Mason AND no delivery claim exists —
 * 'sending', 'sent' and 'uncertain' claims are all final and never listed.
 * Symlinks, non-cos files and entries cosStatus cannot read are skipped.
 */
export async function listTelegramCosDrafts(runsDir?: string): Promise<CosDraft[]> {
  try {
    const dir = join(root(runsDir), 'cos');
    const found: { draft: CosDraft; mtimeMs: number }[] = [];
    for (const name of await readdir(dir)) {
      if (!DRAFT_FILE.test(name)) continue;
      try {
        const stat = await lstat(join(dir, name));
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        const state = await cosStatus(name.slice(0, -'.json'.length), runsDir);
        if (state.needsYou && state.delivery === undefined && state.draft?.origin.channel === 'telegram') {
          found.push({ draft: state.draft, mtimeMs: stat.mtimeMs });
        }
      } catch { /* A racing or malformed entry is skipped, never fatal. */ }
    }
    return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, LIST_MAX).map(item => item.draft);
  } catch {
    return [];
  }
}

/** One message: each waiting draft's text, then the exact line to copy. */
export function formatTelegramCosList(drafts: readonly CosDraft[]): string {
  if (drafts.length === 0) return 'No Telegram replies are waiting for approval.';
  return drafts.map(draft =>
    `${draft.text.length > TEXT_CLIP ? `${draft.text.slice(0, TEXT_CLIP)} [truncated]` : draft.text}\n\n` +
    `/approve ${draft.id} ${draft.digest.slice(0, 12)}`,
  ).join('\n\n');
}

export interface TelegramCosApproveDeps extends TelegramInboxDeps {
  /** Approval transport seam for tests. Default: deliverTelegramCosResult. */
  deliver?: typeof deliverTelegramCosResult;
}

/**
 * Approve and send a Telegram-origin draft. The 12-hex code must prefix-match
 * the current draft's digest, re-read here; the approval binds to that stored
 * digest only. Any existing delivery claim is final — a second /approve can
 * never resend.
 */
export async function approveTelegramCos(text: string, cfg: AshlrConfig, deps: TelegramCosApproveDeps = {}): Promise<string> {
  try {
    const match = TELEGRAM_COS_APPROVE_RE.exec(text);
    if (!match) return 'That code does not match the current draft.';
    const id = match[1]!;
    const code = match[2]!;
    const state = await cosStatus(id, deps.runsDir);
    const draft = state.draft;
    if (!draft || draft.origin.channel !== 'telegram' || !draft.digest.startsWith(code)) {
      return 'That code does not match the current draft.';
    }
    if (state.delivery !== undefined) return 'Already sent or in progress.';
    const deliver = deps.deliver ?? (await import('./telegram-inbox-bridge.js')).deliverTelegramCosResult;
    try {
      await deliver(id, draft.digest, cfg, deps);
      return 'Sent.';
    } catch {
      // Re-read to classify: 'sending' or 'sent' means another caller holds the
      // claim; anything else — our own failed send, a claim write that could
      // not land, or state we can no longer read — is reconciled on desktop.
      const after = await cosStatus(id, deps.runsDir).catch(() => null);
      return after?.delivery === 'sending' || after?.delivery === 'sent'
        ? 'Already sent or in progress.'
        : 'Delivery uncertain; check the chat, then settle it in the desktop Tasks card.';
    }
  } catch {
    return 'That code does not match the current draft.';
  }
}
