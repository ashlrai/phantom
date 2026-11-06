import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

export type InboxAckState = 'acked' | 'skipped' | 'pending';
type RecordedAck = { status: Exclude<InboxAckState, 'pending'>; reason?: string };

/** First valid row per id in the bounded tail wins. Read failures are unknown. */
export function readInboxAckStates(runsDir: string): Map<string, RecordedAck> {
  const states = new Map<string, RecordedAck>();
  let fd: number | undefined;
  try {
    fd = openSync(join(runsDir, 'queue', 'inbox-acks.jsonl'), 'r');
    const size = fstatSync(fd).size;
    const offset = Math.max(0, size - 256 * 1024);
    const buffer = Buffer.alloc(size - offset);
    let count = 0;
    while (count < buffer.length) {
      const n = readSync(fd, buffer, count, buffer.length - count, offset + count);
      if (!n) break;
      count += n;
    }
    let tail = buffer.subarray(0, count).toString('utf8');
    if (offset > 0) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
    for (const line of tail.split('\n')) {
      try {
        const row: unknown = JSON.parse(line);
        if (!row || typeof row !== 'object' || !('entryId' in row) || !('status' in row) ||
          typeof row.entryId !== 'string' || !row.entryId || states.has(row.entryId) ||
          (row.status !== 'acked' && row.status !== 'skipped')) continue;
        states.set(row.entryId, { status: row.status,
          ...('reason' in row && typeof row.reason === 'string' ? { reason: row.reason } : {}) });
      } catch { /* Ignore malformed ledger rows. */ }
    }
    return states;
  } catch { return new Map(); }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* Best effort. */ } } }
}
