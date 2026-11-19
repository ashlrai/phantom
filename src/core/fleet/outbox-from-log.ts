/**
 * `phm outbox from-log`: copy the leader's newest "Reply for Mason" from the plan
 * log into MASON-OUTBOX.md (beside the plan log) so Mason hears it every hour,
 * not only in the 00:00Z digest. Content-hash dedupe; a dry run by default.
 */
import { appendFile, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { planLogPath, readLeaderReplies, replyTextHash } from './mason-outbox.js';

export const OUTBOX_FROM_LOG_SCHEMA = 'outbox.from-log.v1';

export type OutboxFromLogStatus = 'added' | 'would-add' | 'duplicate' | 'no-reply' | 'unreadable';

export interface OutboxFromLogResult {
  schema: typeof OUTBOX_FROM_LOG_SCHEMA;
  version: 1;
  status: OutboxFromLogStatus;
  /** True only when --apply was asked for. */
  apply: boolean;
  planLog: string;
  outbox: string;
  /** The reply text, when one was found. */
  text?: string;
  /** sha256 of the trimmed text, the dedupe key. */
  hash?: string;
  /** The exact entry added (or that would be added). */
  entry?: string;
  /** The Leader-chat copy: ids posted or already posted. Only after an add. */
  chat?: { posted: string[]; skipped: string[]; unknown: string[] };
  reason?: string;
}

export interface OutboxFromLogDeps {
  now?: () => Date;
  /** The existing Leader-chat route (`syncLeaderReplies`); injected so tests send nothing. */
  sendToChat?: (planLog: string) => Promise<{ posted: string[]; skipped: string[]; unknown: string[] }>;
}

/** Body hashes of every "## " entry already in the outbox; a headingless file counts as one body. */
export function outboxBodyHashes(markdown: string): Set<string> {
  const hashes = new Set<string>();
  const parts = markdown.replace(/\r\n/g, '\n').split(/^## .*$/m);
  for (const body of parts) {
    // The leader network writes "Leader: <text>"; the same words under that label are the same reply.
    const text = body.trim().replace(/^Leader:\s*/, '');
    if (text) hashes.add(replyTextHash(text));
  }
  return hashes;
}

export function outboxEntry(at: Date, text: string): string {
  return `## ${at.toISOString()} (leader)\n\n${text.trim()}\n`;
}

export async function outboxFromLog(opts: { file?: string; planLog?: string; apply?: boolean }, deps: OutboxFromLogDeps = {}): Promise<OutboxFromLogResult> {
  const planLog = planLogPath(opts.file, opts.planLog);
  const outbox = join(dirname(planLog), 'MASON-OUTBOX.md');
  const apply = opts.apply === true;
  const base = { schema: OUTBOX_FROM_LOG_SCHEMA, version: 1, apply, planLog, outbox } as const;
  const replies = await readLeaderReplies({ file: planLog, limit: 1 });
  if (replies.sourceState !== 'healthy') return { ...base, status: 'unreadable', ...(replies.reason ? { reason: replies.reason } : {}) };
  const text = replies.replies[0]?.text.trim();
  if (!text) return { ...base, status: 'no-reply', reason: 'No "Reply for Mason" block in the plan log.' };
  const hash = replyTextHash(text);
  const existing = await readFile(outbox, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  if (outboxBodyHashes(existing).has(hash)) return { ...base, status: 'duplicate', text, hash, reason: 'The outbox already has this reply.' };
  const entry = outboxEntry((deps.now ?? (() => new Date()))(), text);
  if (!apply) return { ...base, status: 'would-add', text, hash, entry };
  const size = await stat(outbox).then(s => s.size).catch(() => 0);
  await appendFile(outbox, `${size > 0 && !existing.endsWith('\n') ? '\n' : ''}${size > 0 ? '\n' : ''}${entry}`, { mode: 0o600 });
  const sendToChat = deps.sendToChat ?? (async (file: string) => (await import('../vision/leader-thread.js')).syncLeaderReplies(undefined, file));
  // The outbox write is the record; a chat failure is reported, never undone or retried here.
  const chat = await sendToChat(planLog).catch(() => ({ posted: [], skipped: [], unknown: ['chat-unavailable'] }));
  return { ...base, status: 'added', text, hash, entry, chat };
}
