import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { INBOX_CHANNEL_LINE } from './inbox-channel-line.js';
import type { RecentInboxEntry } from './cross-channel-dedupe.js';
import { inboxChannelSlug } from './inbox-channel-slug.js';

export interface InboxEntry {
  id?: string;
  channel?: string;
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
  | { ok: true; at: string; bytes: number; id: string }
  | { ok: false; reason: 'empty' | 'too-long' | 'secret-shaped' | 'write-failed' };

export const INBOX_MAX_CHARS = 6000;
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_SOURCE = 'Phantom desktop';

function safeSource(source: string | undefined): string {
  return source && /^[A-Za-z0-9 ._-]{1,40}$/.test(source) && scrubSecrets(source) === source
    ? source : DEFAULT_SOURCE;
}

function localTimestamp(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}`;
}

function normaliseText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim();
}

export function formatInboxEntry(text: string, source: string, when: Date): string {
  const at = localTimestamp(when);
  return `\n## ${at} ET (Mason, ${safeSource(source)}) PRIORITY P0\n${normaliseText(text)}\n`;
}

/** Prevent continuation text from opening another inbox entry. */
export function escapeInboxContinuation(line: string): string {
  return /^## /.test(line) || /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\s+\[src:([a-z0-9._-]{1,32})(?:\s+id:([A-Za-z0-9._:-]{1,64}))?\]\s+(.+)$/.test(line)
    ? ` ${line}` : line;
}

/**
 * Channel-line form: the first line carries the time, channel and a stable id
 * (so inbox-ack can reply on that channel); later lines escape entry delimiters and
 * reach the planner as one raw entry.
 */
function formatChannelEntry(text: string, source: string, when: Date): { entry: string; id: string } {
  const iso = when.toISOString();
  const channel = inboxChannelSlug(source);
  const id = `${channel === 'desktop' ? 'desk' : channel}-${createHash('sha256').update(iso + text).digest('hex').slice(0, 16)}`;
  const [first = '', ...rest] = text.split('\n');
  return { entry: `\n${[`${iso} [src:${channel} id:${id}] ${first}`, ...rest.map(escapeInboxContinuation)].join('\n')}\n`, id };
}

export function parseInbox(markdown: string, limit = 20): InboxEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const entries: InboxEntry[] = [];
  let heading: string | undefined;
  let body: string[] = [];
  let channelEntry: Omit<InboxEntry, 'text'> | undefined;
  const finish = (): void => {
    if (channelEntry) {
      entries.push({ ...channelEntry, text: body.join('\n').trim().slice(0, INBOX_MAX_CHARS) });
      return;
    }
    if (heading === undefined) return;
    const match = /^## (.+?) ET \([^,\n]+, (.+?)\) PRIORITY (\S+)(?:.*)$/.exec(heading);
    const dated = match ? null : /^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})(?: ET)?/.exec(heading);
    const source = dated ? /\(([^)]*)\)/.exec(heading.slice(dated[0].length))?.[1]?.trim().slice(0, 80) : undefined;
    const priority = dated ? /\bPRIORITY\s*:?\s+(\w+)/.exec(heading)?.[1] : undefined;
    entries.push({
      at: match?.[1] ?? dated?.[1] ?? heading,
      source: match?.[2] ?? (source || 'unknown'),
      priority: match?.[3] ?? priority ?? null,
      text: body.join('\n').trim().slice(0, INBOX_MAX_CHARS),
    });
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const channel = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\s+\[src:([a-z0-9._-]{1,32})(?:\s+id:([A-Za-z0-9._:-]{1,64}))?\]\s+(.+)$/.exec(line);
    const date = channel ? new Date(channel[1]!) : undefined;
    if (channel && date && Number.isFinite(date.getTime())) {
      finish();
      heading = undefined;
      channelEntry = {
        at: localTimestamp(date),
        channel: channel[2]!,
        ...(channel[3] ? { id: channel[3] } : {}),
        source: `${channel[2]}${channel[3] ? ` (${channel[3]})` : ''}`.slice(0, 80),
        priority: null,
      };
      body = [channel[4]!];
    } else if (line.startsWith('## ')) {
      finish();
      channelEntry = undefined;
      heading = line;
      body = [];
    } else if (heading !== undefined || channelEntry) {
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
    const at = localTimestamp(now);
    const eventTimestamp = now.toISOString().slice(0, 19).replace('T', ' ');
    const { entry, id } = formatChannelEntry(clean, source, now);
    await mkdir(join(runsDir, 'leader'), { recursive: true });
    await appendFile(join(runsDir, 'leader', 'MASON-INBOX.md'), entry, { encoding: 'utf8', flag: 'a' });
    // The inbox owns acceptance; the dispatch event is only observational.
    await appendFile(join(runsDir, 'dispatch-events.log'), `${eventTimestamp} INBOX new entry from ${source}\n`, { encoding: 'utf8', flag: 'a' }).catch(() => undefined);
    return { ok: true, at, id, bytes: Buffer.byteLength(entry, 'utf8') };
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

const INBOX_HEADING_START = /^## /;
const ALSO_TAG = /^\[also:([a-z0-9._,-]{1,200})\] ?/;
const CHANNEL_LINE_WITH_ID = /^(\d{4}-\d{2}-\d{2}T\S+)\s+\[src:([a-z0-9._-]{1,32}) id:([A-Za-z0-9._:-]{1,64})\] (.*)$/;

/**
 * Cross-channel dedupe: a duplicate from another surface is attributed on the
 * existing entry's first line as `[src:phone id:X] [also:telegram] text`. The
 * `[src:…]` tag keeps its single-channel shape (the planner brief and ack parsers
 * match it), and the entry id (a hash of the original time and text) is unchanged.
 * Sync read-modify-write so no await separates the read from the write.
 */
export function addInboxSource(entryId: string, channel: string, opts: { runsDir?: string } = {}): boolean {
  if (!/^[a-z0-9._-]{1,32}$/.test(channel) || !/^[A-Za-z0-9._:-]{1,64}$/.test(entryId)) return false;
  try {
    const file = join(opts.runsDir ?? join(homedir(), '.ashlr-runs'), 'leader', 'MASON-INBOX.md');
    const lines = readFileSync(file, 'utf8').split('\n');
    const at = lines.findIndex((line) => CHANNEL_LINE_WITH_ID.exec(line)?.[3] === entryId);
    if (at < 0) return false;
    const [, iso, src, , rest] = CHANNEL_LINE_WITH_ID.exec(lines[at]!)!;
    const also = ALSO_TAG.exec(rest!);
    const known = [src!, ...(also?.[1]?.split(',') ?? [])];
    if (known.includes(channel)) return true;
    lines[at] = `${iso} [src:${src} id:${entryId}] [also:${[...known.slice(1), channel].join(',')}] ${also ? rest!.slice(also[0].length) : rest}`;
    writeFileSync(file, lines.join('\n'), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** Channel-line entries from the last `sinceMs` before `nowMs`, with all attributed sources. senderId is left for the caller to prove. */
export function readRecentChannelEntries(runsDir: string, nowMs: number, sinceMs: number): RecentInboxEntry[] {
  let markdown: string;
  try {
    const buffer = readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'));
    markdown = buffer.subarray(Math.max(0, buffer.length - MAX_READ_BYTES)).toString('utf8').replace(/\r\n/g, '\n');
  } catch {
    return [];
  }
  const out: RecentInboxEntry[] = [];
  let current: { entry: RecentInboxEntry; body: string[] } | undefined;
  const flush = (): void => { if (current) out.push({ ...current.entry, text: current.body.join('\n').trim() }); current = undefined; };
  for (const line of markdown.split('\n')) {
    const m = CHANNEL_LINE_WITH_ID.exec(line);
    if (m) {
      flush();
      const receivedAt = Date.parse(m[1]!);
      if (!Number.isFinite(receivedAt) || nowMs - receivedAt >= sinceMs) continue;
      const also = ALSO_TAG.exec(m[4]!);
      current = {
        entry: { id: m[3]!, text: '', receivedAt, channels: [m[2]!, ...(also?.[1]?.split(',') ?? [])] },
        body: [also ? m[4]!.slice(also[0].length) : m[4]!],
      };
    } else if (INBOX_HEADING_START.test(line) || INBOX_CHANNEL_LINE.test(line)) flush();
    else current?.body.push(line);
  }
  flush();
  return out;
}
