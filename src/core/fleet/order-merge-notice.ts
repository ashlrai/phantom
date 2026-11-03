import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { scrubSecrets } from '../util/scrub.js';
import { postLeaderMessage } from '../vision/leader-thread.js';
import { appendBusInbox } from './bus-inbox.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import type { OrderTraceV1 } from './order-trace.js';

export interface OrderMergeNotice { key: string; entryId: string; jobId: string; channel: string; text: string }
export type OrderMergeNoticeSenders = Partial<Record<string, (notice: OrderMergeNotice) => Promise<void>>>;

export function orderSourceRoute(source: string): { channel: string; entryId: string } | null {
  const match = /^([a-z0-9._-]{1,32}) \(([A-Za-z0-9._:-]{1,64})\)$/.exec(source);
  return match ? { channel: match[1]!, entryId: match[2]! } : null;
}

export function planOrderMergeNotices(trace: OrderTraceV1, sent: ReadonlySet<string>): OrderMergeNotice[] {
  const seen = new Set(sent);
  const notices: OrderMergeNotice[] = [];
  for (const order of trace.orders) {
    const route = orderSourceRoute(order.source);
    if (!route) continue;
    for (const job of order.jobs) {
      const key = `${route.entryId}:${job.id}`;
      if (job.state !== 'merged' || seen.has(key)) continue;
      seen.add(key);
      notices.push({ ...route, key, jobId: job.id,
        text: scrubSecrets(`Merged: ${job.id} for your ${order.key} order${job.url ? ` (${job.url})` : ''}.`).slice(0, 200) });
    }
  }
  return notices;
}

/** Malformed rows are ignored; skipped routes are terminal just like successful sends. */
export function readOrderNoticeLedger(root: string): Set<string> {
  let text: string;
  try { text = readFileSync(join(root, 'queue', 'order-notices.jsonl'), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line);
      if (row && typeof row === 'object' && 'key' in row && typeof row.key === 'string'
        && 'status' in row && (row.status === 'sent' || row.status === 'skipped')) seen.add(row.key);
    } catch { /* Partial or malformed rows do not prevent retries. */ }
  }
  return seen;
}

const postBusNotice = async (notice: OrderMergeNotice): Promise<void> => {
  const id = createHash('sha256').update(notice.key).digest('hex').slice(0, 32);
  const result = appendBusInbox({ id: `order-merged-${id}`, from: 'planner', to: 'mason', priority: 'P2',
    ttl: 7 * 24 * 60 * 60 * 1000, body: { kind: 'order-merged', channel: notice.channel, text: notice.text } });
  if (result.status !== 'posted' && result.status !== 'duplicate') throw new Error('bus unavailable');
};
const defaultSenders: OrderMergeNoticeSenders = {
  desktop: postBusNotice, phone: postBusNotice, page: postBusNotice,
  telegram: async notice => { postLeaderMessage({ channel: 'telegram', kind: 'update', text: notice.text }); },
};

export async function sendOrderMergeNotices(root: string, notices: readonly OrderMergeNotice[],
  senders: OrderMergeNoticeSenders = defaultSenders): Promise<{ sent: number; skipped: number; failed: number }> {
  const counts = { sent: 0, skipped: 0, failed: 0 };
  if (!notices.length) return counts;
  const ledger = join(root, 'queue', 'order-notices.jsonl');
  try {
    ensurePrivateDirectory(dirname(ledger));
    const acquired = acquireLocalStoreLockWithOutcome(`${ledger}.lock`, 0);
    if (acquired.state !== 'acquired') return counts;
    try {
      const seen = readOrderNoticeLedger(root);
      // A newline also isolates any truncated final row from the next record.
      for (const notice of notices) {
        if (seen.has(notice.key)) continue;
        const send = Object.hasOwn(senders, notice.channel) ? senders[notice.channel] : undefined;
        try {
          if (send) await send(notice);
          const status = send ? 'sent' : 'skipped';
          appendFileSync(ledger, `\n${JSON.stringify({ key: notice.key, status,
            ...(!send ? { reason: 'channel has no sender' } : {}) })}\n`, { mode: 0o600 });
          seen.add(notice.key);
          counts[status]++;
        } catch { counts.failed++; }
      }
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { counts.failed++; }
  return counts;
}
