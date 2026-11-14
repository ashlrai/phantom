/**
 * Read-only projection of the Slack transport's outbound send store
 * (`<stateRoot>/messages.json`) into evidence rows for `bindSlackReplies`.
 * Never throws, never writes, and never copies the digest or clientId.
 */
import { join } from 'node:path';
import { ashlrHome } from '../cloud/store.js';
import { readPrivateFileCapped } from '../verse/preferences.js';
import { isSlackChannelId, isSlackTs } from './slack-network.js';
import type { SentReceipt } from './slack-reply-binding.js';

/** Same cap as MAX_REPLY_BYTES in slack-transport.ts (the transport's own store read). */
const MAX_STORE_BYTES = 1024 * 1024;
/** Same row limit the transport enforces on its store. */
const MAX_MESSAGES = 1024;

export interface SlackSendReceiptRead {
  state: 'ok' | 'missing' | 'degraded';
  receipts: SentReceipt[];
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function readSlackSendReceipts(options: { stateRoot?: string } = {}): SlackSendReceiptRead {
  try {
    const path = join(options.stateRoot ?? join(ashlrHome(), 'fleet', 'slack-transport'), 'messages.json');
    const read = readPrivateFileCapped(path, MAX_STORE_BYTES);
    if (read === null) return { state: 'missing', receipts: [] };
    if (read.truncated) return { state: 'degraded', receipts: [] };
    const data: unknown = JSON.parse(read.text);
    if (!record(data) || data.version !== 1 || !record(data.messages)) return { state: 'degraded', receipts: [] };
    const rows = Object.values(data.messages);
    if (rows.length > MAX_MESSAGES) return { state: 'degraded', receipts: [] };
    const receipts: SentReceipt[] = [];
    let degraded = false;
    for (const row of rows) {
      if (!record(row) || !isSlackChannelId(row.channel) || (row.state !== 'attempted' && row.state !== 'sent') ||
          (row.thread !== undefined && !isSlackTs(row.thread)) ||
          (row.ts !== undefined && !isSlackTs(row.ts)) || (row.state === 'sent' && row.ts === undefined)) {
        degraded = true;
        continue;
      }
      receipts.push({
        channel: row.channel, state: row.state,
        ...(row.thread !== undefined ? { thread: row.thread as string } : {}),
        ...(row.ts !== undefined ? { ts: row.ts as string } : {}),
      });
    }
    return { state: degraded ? 'degraded' : 'ok', receipts };
  } catch {
    return { state: 'degraded', receipts: [] };
  }
}
