import { appendFile, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';

export interface InboxEntry {
  at: string;
  source: string;
  priority: string | null;
  text: string;
}

export interface InboxAppendOptions {
  runsDir?: string;
  now?: () => Date;
  source?: string;
}

export type InboxAppendResult =
  | { ok: true; at: string; bytes: number }
  | { ok: false; reason: 'empty' | 'too-long' | 'secret-shaped' | 'write-failed' };

export const INBOX_MAX_CHARS = 6000;
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_SOURCE = 'Phantom desktop';

function safeSource(source: string | undefined): string {
  return source && /^[A-Za-z0-9 ._-]{1,40}$/.test(source) && scrubSecrets(source) === source
    ? source : DEFAULT_SOURCE;
}

function localTimestamp(date: Date): { at: string; seconds: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const at = `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
  return { at, seconds: `${at}:${part('second')}` };
}

function normaliseText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function formatInboxEntry(text: string, source: string, when: Date): string {
  const { at } = localTimestamp(when);
  return `\n## ${at} ET (Mason, ${safeSource(source)}) PRIORITY P0\n${normaliseText(text)}\n`;
}

export function parseInbox(markdown: string, limit = 20): InboxEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const entries: InboxEntry[] = [];
  let heading: string | undefined;
  let body: string[] = [];
  const finish = (): void => {
    if (heading === undefined) return;
    const match = /^## (.+?) ET \([^,\n]+, (.+?)\) PRIORITY (\S+)\s*$/.exec(heading);
    entries.push({
      at: match?.[1] ?? heading,
      source: match?.[2] ?? 'unknown',
      priority: match?.[3] ?? null,
      text: body.join('\n').trim().slice(0, INBOX_MAX_CHARS),
    });
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (line.startsWith('## ')) {
      finish();
      heading = line;
      body = [];
    } else if (heading !== undefined) {
      body.push(line);
    }
  }
  finish();
  return entries.reverse().slice(0, Math.floor(limit));
}

export async function appendInboxEntry(text: string, opts: InboxAppendOptions = {}): Promise<InboxAppendResult> {
  const clean = normaliseText(text);
  if (!clean) return { ok: false, reason: 'empty' };
  if (clean.length > INBOX_MAX_CHARS) return { ok: false, reason: 'too-long' };
  if (scrubSecrets(clean) !== clean) return { ok: false, reason: 'secret-shaped' };

  try {
    const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
    const source = safeSource(opts.source);
    const now = (opts.now ?? (() => new Date()))();
    const { at, seconds } = localTimestamp(now);
    const entry = formatInboxEntry(clean, source, now);
    await mkdir(join(runsDir, 'leader'), { recursive: true });
    await appendFile(join(runsDir, 'leader', 'MASON-INBOX.md'), entry, { encoding: 'utf8', flag: 'a' });
    await appendFile(join(runsDir, 'dispatch-events.log'), `${seconds} INBOX new entry from ${source}\n`, { encoding: 'utf8', flag: 'a' });
    return { ok: true, at, bytes: Buffer.byteLength(entry, 'utf8') };
  } catch {
    return { ok: false, reason: 'write-failed' };
  }
}

export async function readInboxEntries(opts: { runsDir?: string; limit?: number } = {}): Promise<{ sourceState: 'healthy' | 'missing' | 'degraded'; entries: InboxEntry[] }> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const runsDir = opts.runsDir ?? join(homedir(), '.ashlr-runs');
    handle = await open(join(runsDir, 'leader', 'MASON-INBOX.md'), 'r');
    const { size } = await handle.stat();
    const offset = Math.max(0, size - MAX_READ_BYTES);
    const buffer = Buffer.alloc(size - offset);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let markdown = buffer.subarray(0, bytesRead).toString('utf8');
    // An offset inside a line cannot identify a complete heading or body.
    if (offset > 0) {
      const firstNewline = markdown.indexOf('\n');
      markdown = firstNewline < 0 ? '' : markdown.slice(firstNewline + 1);
    }
    return { sourceState: 'healthy', entries: parseInbox(markdown, opts.limit) };
  } catch (error) {
    const missing = !handle && (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { sourceState: missing ? 'missing' : 'degraded', entries: [] };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
