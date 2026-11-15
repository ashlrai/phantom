/**
 * Per-channel delivery receipts for outgoing Leader messages: where a message
 * WENT (desktop, iMessage via Dot, Slack, ...) and whether it failed. Append-only
 * jsonl in the owner runs dir's `leader/` folder, read bounded to the last
 * MAX_READ_LINES lines. A message with no record is "unknown", never "delivered".
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
    const row = { messageId, channel, state, ...(reason ? { reason: scrubSecrets(reason).slice(0, MAX_REASON) } : {}) };
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
