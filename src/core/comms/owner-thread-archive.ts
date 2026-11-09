import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_THREAD_ID, isOwnerChannel } from './leader-mailbox.js';
import type { OwnerThreadMessage } from './owner-thread.js';
import { scrubSecrets } from '../util/scrub.js';
import { readStableRegularFile } from '../util/stable-file-read.js';

const FILE_BYTES = 2 * 1_048_576;
const TOTAL_BYTES = 8 * 1_048_576;
type Archive = { file: string; firstSeq: number; lastSeq: number };

export function listOwnerThreadArchives(options: { runsDir: string }): Archive[] {
  const dir = join(options.runsDir, 'leader');
  let names: string[];
  try { names = readdirSync(dir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const archives: Archive[] = [];
  for (const file of names) {
    const match = /^owner-thread-archive-(\d+)-(\d+)\.json$/.exec(file);
    if (!match) continue;
    const firstSeq = Number(match[1]); const lastSeq = Number(match[2]);
    if (!Number.isSafeInteger(firstSeq) || !Number.isSafeInteger(lastSeq) || firstSeq > lastSeq) continue;
    try { if (lstatSync(join(dir, file)).isFile()) archives.push({ file, firstSeq, lastSeq }); } catch { /* raced with removal */ }
  }
  return archives.sort((a, b) => a.firstSeq - b.firstSeq || a.lastSeq - b.lastSeq || a.file.localeCompare(b.file));
}

function validMessage(value: unknown, archive: Archive): value is OwnerThreadMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const m = value as Record<string, unknown>;
  return Number.isSafeInteger(m.seq) && (m.seq as number) >= archive.firstSeq && (m.seq as number) <= archive.lastSeq &&
    typeof m.id === 'string' && typeof m.idempotencyKey === 'string' && typeof m.senderId === 'string' &&
    typeof m.channel === 'string' && isOwnerChannel(m.channel) && (m.direction === 'inbound' || m.direction === 'outbound') &&
    typeof m.at === 'string' && typeof m.text === 'string' &&
    (m.replyTo === undefined || typeof m.replyTo === 'string') && (m.channelRef === undefined || typeof m.channelRef === 'string') &&
    (m.fanout === undefined || (Array.isArray(m.fanout) && m.fanout.every(isOwnerChannel)));
}

export function readOwnerThreadHistory(options: { runsDir: string }, page: { before?: number; limit?: number } = {}) {
  const archives = listOwnerThreadArchives(options);
  const limit = Number.isSafeInteger(page.limit) && page.limit! > 0 ? Math.min(page.limit!, 500) : 50;
  let remainingBytes = TOTAL_BYTES; let skipped = 0;
  const messages: OwnerThreadMessage[] = [];
  const dir = join(options.runsDir, 'leader');
  for (const archive of [...archives].reverse()) {
    if (page.before !== undefined && archive.firstSeq >= page.before) continue;
    const result = readStableRegularFile(join(dir, archive.file), { anchorPath: dir, maxFileBytes: FILE_BYTES, remainingBytes });
    if (!result.ok) { skipped++; continue; }
    remainingBytes -= result.bytesRead;
    try {
      const data: unknown = JSON.parse(result.text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid archive');
      const record = data as Record<string, unknown>;
      if (record.v !== 1 || record.threadId !== OWNER_THREAD_ID || !Array.isArray(record.messages) ||
          !record.messages.every(message => validMessage(message, archive))) throw new Error('invalid archive');
      for (const message of record.messages as OwnerThreadMessage[]) {
        if (page.before === undefined || message.seq < page.before) messages.push({ ...message, text: scrubSecrets(message.text) });
      }
    } catch { skipped++; }
  }
  messages.sort((a, b) => a.seq - b.seq);
  return { schema: 'comms.owner-thread-history.v1' as const, messages: messages.slice(-limit), archives: archives.length, skipped };
}
