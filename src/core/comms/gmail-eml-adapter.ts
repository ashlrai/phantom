import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { EMAIL_DROP_MAX_BYTES, parseEmlMessage } from './email-drop-bridge.js';
import type { GmailClassification, GmailMessage } from './gmail-bridge.js';
import { scrubSecrets } from '../util/scrub.js';

export type EmlHeaders = ReadonlyMap<string, string>;
const headersByMessage = new WeakMap<GmailMessage, EmlHeaders>();

function parseHeaders(raw: string): Map<string, string> {
  const headers = new Map<string, string>();
  const section = raw.split(/\r?\n\r?\n/, 1)[0] ?? '';
  let name: string | undefined;
  for (const line of section.split(/\r?\n/)) {
    if (/^[ \t]/.test(line)) {
      if (name) headers.set(name, `${headers.get(name)} ${line.trim()}`);
    } else {
      const match = /^([^:\s]+):\s*(.*)$/.exec(line);
      const key = match?.[1]?.toLowerCase();
      name = key && !headers.has(key) ? key : undefined;
      if (name) headers.set(name, match![2]!.trim());
    }
  }
  return headers;
}

/** Read newest saved messages, without following symlinks or modifying the folder. */
export function readEmlInbox(dir: string): GmailMessage[] {
  const files = readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && /\.eml$/i.test(e.name))
    .flatMap(e => {
      try {
        const stat = lstatSync(join(dir, e.name));
        return stat.isFile() && stat.size <= EMAIL_DROP_MAX_BYTES ? [{ name: e.name, mtime: stat.mtimeMs }] : [];
      } catch { return []; }
    }).sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name));
  const messages: GmailMessage[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (messages.length === 100) break;
    let fd: number | undefined;
    try {
      fd = openSync(join(dir, file.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > EMAIL_DROP_MAX_BYTES) continue;
      const buffer = Buffer.alloc(EMAIL_DROP_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const n = readSync(fd, buffer, size, buffer.length - size, null);
        if (!n) break;
        size += n;
      }
      if (size > EMAIL_DROP_MAX_BYTES) continue;
      const bytes = buffer.subarray(0, size);
      const raw = bytes.toString('utf8');
      const parsed = parseEmlMessage(raw);
      if (!parsed) continue;
      const id = parsed.messageId ?? createHash('sha256').update(bytes).digest('hex').slice(0, 16);
      if (seen.has(id)) continue;
      seen.add(id);
      const headers = parseHeaders(raw);
      const autoSubmitted = headers.get('auto-submitted');
      const message: GmailMessage = { id, from: parsed.from, subject: parsed.subject, body: parsed.body,
        ...(autoSubmitted === undefined ? {} : { autoSubmitted }) };
      headersByMessage.set(message, headers);
      messages.push(message);
    } catch { /* Skip files that disappear or cannot be read safely. */ }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return messages;
}

export function classifyGmailHeuristic(message: GmailMessage, headers: EmlHeaders = headersByMessage.get(message) ?? new Map()): GmailClassification {
  const local = message.from.split('@')[0] ?? '';
  if (/^(?:no-reply|noreply|notifications|newsletter|digest)$/i.test(local) || headers.has('list-unsubscribe') ||
      /^(?:bulk|list)(?:\s|$)/i.test(headers.get('precedence') ?? '')) return 'update';
  return /\?|\b(?:please|could you|would you|can you|let me know|kindly)\b/i.test(`${message.subject} ${message.body}`) ? 'reply' : 'review';
}

export function summarizeUpdateLine(message: GmailMessage): string {
  return scrubSecrets(`${message.from} · ${message.subject}`.replace(/\s+/g, ' ')).slice(0, 160);
}

export function holdingReply(_message: GmailMessage): string {
  return 'Thanks, I have this and will reply properly soon.';
}

/** Messages are ordered newest first by the adapter. Counts represent this sample. */
export function archivePlan(messages: readonly GmailMessage[], classifications: readonly GmailClassification[], unreadTarget = 100): { unread: number; target: number; archiveCandidates: string[] } {
  const target = Math.max(0, Math.floor(unreadTarget));
  const candidates = messages.flatMap((message, i) => classifications[i] === 'update' ? [message.id] : []).reverse();
  return { unread: messages.length, target, archiveCandidates: candidates.slice(0, Math.max(0, messages.length - target)) };
}
