/**
 * Per-channel delivery receipts for outgoing Leader messages: where a message
 * WENT (desktop, iMessage via Dot, Slack, ...) and whether it failed. Append-only
 * jsonl in the owner runs dir's `leader/` folder, read bounded to the last
 * MAX_READ_LINES lines. A message with no record is "unknown", never "delivered".
 * Rows carry `at` (ISO-8601) so windowed folds can place them in time; rows
 * written before the stamp existed have no `at` and stay undated evidence.
 */
import { appendFileSync, closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';

export const MAX_READ_LINES = 500;
const MAX_READ_BYTES = 256 * 1024;
const MAX_REASON = 160;

export type ReceiptState = 'delivered' | 'pending' | 'failed';
export interface DeliveryReceipt { state: ReceiptState | 'unknown'; reason?: string }
export type MessageReceipts = Record<string, DeliveryReceipt>;

const dirOf = (runsDir: string) => join(runsDir, 'leader');
const fileOf = (runsDir: string) => join(dirOf(runsDir), 'delivery-receipts.jsonl');

/** Best effort: a receipt that cannot be written must never block the send. */
export function recordDelivery(runsDir: string, messageId: string, channel: string, state: ReceiptState, reason?: string): void {
  try {
    ensurePrivateDirectory(runsDir);
    ensurePrivateDirectory(dirOf(runsDir));
    const row = { messageId, channel, state, at: new Date().toISOString(), ...(reason ? { reason: scrubSecrets(reason).slice(0, MAX_REASON) } : {}) };
    appendFileSync(fileOf(runsDir), `${JSON.stringify(row)}\n`, { mode: 0o600 });
  } catch { /* receipts are advisory */ }
}

function tailLines(file: string): string[] {
  let fd: number;
  try { fd = openSync(file, 'r'); } catch { return []; }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_READ_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    if (size > length) lines.shift(); // first line is probably cut in half
    return lines.filter(Boolean).slice(-MAX_READ_LINES);
  } catch { return []; } finally { closeSync(fd); }
}

/** Latest receipt per channel for each asked message id. Ids with no record are absent (= unknown). */
export function readReceipts(runsDir: string, messageIds: readonly string[]): Record<string, MessageReceipts> {
  const wanted = new Set(messageIds);
  const out: Record<string, MessageReceipts> = {};
  if (!wanted.size) return out;
  for (const line of tailLines(fileOf(runsDir))) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object') continue;
    const { messageId, channel, state, reason } = row as Record<string, unknown>;
    if (typeof messageId !== 'string' || !wanted.has(messageId) || typeof channel !== 'string') continue;
    if (state !== 'delivered' && state !== 'pending' && state !== 'failed') continue;
    (out[messageId] ??= {})[channel] = { state, ...(typeof reason === 'string' ? { reason } : {}) };
  }
  return out;
}

/**
 * The writer's channel vocabulary — OwnerChannel in
 * src/core/comms/leader-mailbox.ts, duplicated rather than imported so this
 * reader stays a leaf for every consumer's import closure (the same split
 * the improve backlog feed keeps). recordDelivery's channel parameter is
 * typed string, so a row outside this set is off-contract.
 */
const RECEIPT_CHANNELS = ['desktop', 'telegram', 'email', 'imessage', 'slack'] as const;
const RECEIPT_CHANNEL_SET: ReadonlySet<string> = new Set(RECEIPT_CHANNELS);
export type DeliveryReceiptChannel = typeof RECEIPT_CHANNELS[number];

/**
 * Newest confirmed ('delivered') receipt time per channel across the
 * retained tail — the same bounded read `readReceipts` performs, folded by
 * channel instead of keyed by message id, for surfaces that need "when did
 * this channel last carry an outbound" without naming message ids. Only
 * `delivered` rows carrying a parseable `at` contribute: a pending or
 * failed attempt is not an outbound that landed, and a row written before
 * the stamp existed is undated evidence that can never claim a "last
 * outbound" time. A channel with no delivered row is absent — unknown
 * stays unknown, never a fabricated timestamp. An absent or unreadable
 * journal folds to {} — the same "nothing proven" answer, never a throw.
 */
export function readLatestDeliveredAt(runsDir: string): Partial<Record<DeliveryReceiptChannel, string>> {
  const latest = new Map<string, number>();
  for (const line of tailLines(fileOf(runsDir))) {
    let row: unknown;
    try { row = JSON.parse(line); } catch { continue; }
    if (row === null || typeof row !== 'object') continue;
    const { channel, state, at } = row as Record<string, unknown>;
    if (typeof channel !== 'string' || !RECEIPT_CHANNEL_SET.has(channel) || state !== 'delivered') continue;
    if (typeof at !== 'string') continue;
    const ms = Date.parse(at);
    if (!Number.isFinite(ms)) continue;
    if ((latest.get(channel) ?? Number.NEGATIVE_INFINITY) < ms) latest.set(channel, ms);
  }
  const out: Partial<Record<DeliveryReceiptChannel, string>> = {};
  for (const [channel, ms] of latest) {
    out[channel as DeliveryReceiptChannel] = new Date(ms).toISOString();
  }
  return out;
}
