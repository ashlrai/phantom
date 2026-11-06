import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { imessageStateDir } from '../integrations/imessage.js';

const TAIL_BYTES = 256 * 1024;
type SourceState = 'ok' | 'missing' | 'unreadable';
interface AckRow {
  timestamp: string;
  rowid: number;
  status: 'accepted' | 'duplicate';
  delivery: 'recorded-not-sent' | 'unknown';
}
export interface AckEvidence {
  sourceState: SourceState;
  rows: AckRow[];
  malformedRows: number;
  deliveryProof: false;
  rowid?: number;
  match?: 'matched' | 'no-match' | 'unknown';
}

/** Read at most 256 KiB, discarding a partial leading line and rejecting a torn final line. */
export async function readImessageAckEvidence(limit: number, runsDir?: string, rowid?: number): Promise<AckEvidence> {
  const empty = (sourceState: SourceState): AckEvidence => ({ sourceState, rows: [], malformedRows: 0, deliveryProof: false,
    ...(rowid === undefined ? {} : { rowid, match: sourceState === 'ok' ? 'no-match' : 'unknown' }) });
  let file;
  try {
    file = await open(join(imessageStateDir(runsDir), 'acks.jsonl'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    return empty((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable');
  }
  try {
    const info = await file.stat();
    if (!info.isFile()) return empty('unreadable');
    const start = Math.max(0, info.size - TAIL_BYTES);
    const bytes = Buffer.alloc(info.size - start);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await file.read(bytes, offset, bytes.length - offset, start + offset);
      if (!result.bytesRead) return empty('unreadable');
      offset += result.bytesRead;
    }
    let text = bytes.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline < 0 ? '' : text.slice(newline + 1);
    }
    const report = empty('ok');
    const lines = text.split('\n');
    const final = lines.pop()!;
    if (final.length) report.malformedRows++;
    for (const line of lines) {
      try {
        const value: unknown = JSON.parse(line);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        const row = value as Record<string, unknown>;
        if (typeof row.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(row.at)
          || !Number.isFinite(Date.parse(row.at)) || new Date(row.at).toISOString() !== row.at
          || typeof row.rowid !== 'number' || !Number.isSafeInteger(row.rowid) || row.rowid <= 0
          || (row.status !== 'accepted' && row.status !== 'duplicate')) throw new Error();
        if (rowid === undefined || row.rowid === rowid) {
          report.rows.push({ timestamp: row.at, rowid: row.rowid, status: row.status,
            delivery: row.delivery === 'recorded-not-sent' ? 'recorded-not-sent' : 'unknown' });
        }
      } catch { report.malformedRows++; }
    }
    report.rows = report.rows.slice(-limit);
    if (rowid !== undefined && report.rows.length) report.match = 'matched';
    return report;
  } catch { return empty('unreadable'); } finally { await file.close().catch(() => {}); }
}
