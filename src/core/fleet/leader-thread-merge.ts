/**
 * One Leader conversation from three journals: what Mason sent (MASON-INBOX,
 * both entry forms), the Leader's answers (MASON-OUTBOX) and the "Reply for
 * Mason" paragraphs in the PLAN-LOG. `mergeLeaderThread` is pure text in, list
 * out; `readLeaderThread` is the read-only file reader behind `phm leader
 * thread --since/--before` and GET /api/verse/leader/thread/merged. Nothing is written.
 *
 * Rules: a reply in both the outbox and the plan log shows once; an entry with
 * no readable date stays, with `at: null` ("time unknown"), sorted last; bare
 * flag lines such as "--help" are skipped, never shown as messages.
 *
 * `since` keeps entries at or after its cutoff and `before` keeps entries
 * strictly before its own — together they read one `[since, before)` window,
 * the same bound pair every other comms read applies. An entry with no
 * readable date cannot be placed inside or outside the window, so like
 * `since` the `before` ceiling never drops it.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inboxChannelSlug } from './inbox-channel-slug.js';
import { defaultRunsDir } from './landed-closes-read.js';
import { isFlagOnlyInboxText } from './mason-inbox.js';
import { parseOutbox, parsePlanLog, planLogPath, replyTime } from './mason-outbox.js';

export type ThreadFrom = 'mason' | 'leader' | 'teammate' | 'unknown';
export type ThreadSource = 'inbox' | 'outbox' | 'plan-log';

export interface LeaderThreadEntry {
  /** ISO instant, or null when no date could be read ("time unknown"). */
  at: string | null;
  from: ThreadFrom;
  /** Where it was sent from (phone, desktop, bus…); for the Leader's replies, the journal they came from. */
  channel: string;
  text: string;
  source: ThreadSource;
  /** PR numbers named in the text ("#7873", "PR 7873", github .../pull/7873), ascending, no repeats. */
  refs: number[];
}

const PR_REF = /(?:\bPRs?\s*#?|#|\/pull\/)(\d{1,6})\b/gi;
/** PR numbers found in free text, ascending and unique. */
export function prRefs(text: string): number[] {
  const found = new Set<number>();
  for (const m of text.matchAll(PR_REF)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

export interface LeaderThreadTexts { inbox: string; outbox: string; planLog: string }
export interface LeaderThreadOptions {
  nowMs?: number;
  sinceHours?: number;
  /** ISO instant; entries older than this are dropped. */
  sinceAt?: string;
  beforeHours?: number;
  /** ISO instant; entries at or after this are dropped (exclusive ceiling). */
  beforeAt?: string;
  /** Keep only the newest n entries. */
  limit?: number;
}

const CHANNEL_LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))\s+\[src:([a-z0-9._-]{1,32})(?:\s+id:[A-Za-z0-9._:-]{1,64})?\]\s+(.+)$/;
const DATED_HEADING = /^## (\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/;

function instant(at: string): number | null {
  const ms = at ? replyTime(at) : NaN;
  return Number.isFinite(ms) ? ms : null;
}
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function fromWho(who: string): ThreadFrom {
  const name = who.trim().toLowerCase();
  if (!name) return 'unknown';
  if (name === 'mason') return 'mason';
  return /\bleader\b/.test(name) ? 'leader' : 'teammate';
}

/** Both inbox forms, oldest first. A heading with no readable date is kept with a null time. */
function inboxEntries(markdown: string): LeaderThreadEntry[] {
  const out: LeaderThreadEntry[] = [];
  let open: { head: Omit<LeaderThreadEntry, 'text' | 'refs'>; body: string[]; channelForm: boolean } | null = null;
  const close = (): void => {
    if (!open) return;
    const text = open.body.filter(line => !isFlagOnlyInboxText(line) || !line.trim()).join('\n').trim();
    if (text && !isFlagOnlyInboxText(text)) out.push({ ...open.head, text, refs: prRefs(text) });
    open = null;
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const channel = CHANNEL_LINE.exec(line);
    const channelMs = channel ? Date.parse(channel[1]!) : NaN;
    if (channel && Number.isFinite(channelMs)) {
      close();
      open = { head: { at: new Date(channelMs).toISOString(), from: 'mason', channel: channel[2]!, source: 'inbox' }, body: [channel[3]!], channelForm: true };
    } else if (line.startsWith('## ') && (!open?.channelForm || DATED_HEADING.test(line))) {
      close();
      const dated = DATED_HEADING.exec(line);
      const paren = /\(([^)]*)\)/.exec(line)?.[1] ?? '';
      const comma = paren.indexOf(',');
      const who = comma < 0 ? paren : paren.slice(0, comma);
      const where = comma < 0 ? '' : paren.slice(comma + 1).trim();
      const ms = dated ? instant(dated[2] ? `${dated[1]} ${dated[2]}` : dated[1]!) : null;
      open = { head: { at: iso(ms), from: fromWho(who), channel: where ? inboxChannelSlug(where) : 'unknown', source: 'inbox' }, body: [], channelForm: false };
    } else if (open) {
      open.body.push(line);
    }
  }
  close();
  return out;
}

const norm = (text: string): string => text.replace(/^["“]|["”]$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Pure: the three journal texts as one thread, oldest first, newest last; unknown times last. */
export function mergeLeaderThread(texts: LeaderThreadTexts, opts: LeaderThreadOptions = {}): LeaderThreadEntry[] {
  const replies: LeaderThreadEntry[] = [];
  const seen = new Map<string, number>();
  const add = (source: ThreadSource, at: string, text: string): void => {
    if (!text.trim() || isFlagOnlyInboxText(text)) return;
    const when = iso(instant(at));
    // The outbox keeps a heading's leftover "ET" as a last line; it is not part of the reply.
    const clean = text.replace(/\n(?:ET|EST|EDT|UTC)\s*$/, '');
    const key = norm(clean);
    const twin = [...seen].find(([other]) => other === key || (Math.min(other.length, key.length) >= 12 && (other.includes(key) || key.includes(other))))?.[1];
    if (twin !== undefined) {
      // Same reply in both journals: keep one, and let it borrow a date the first copy lacked.
      const kept = replies[twin]!;
      if (kept.at === null) kept.at = when;
      return;
    }
    seen.set(key, replies.length);
    replies.push({ at: when, from: 'leader', channel: source, text: clean.trim(), source, refs: prRefs(clean) });
  };
  for (const entry of parseOutbox(texts.outbox, Number.MAX_SAFE_INTEGER)) add('outbox', entry.at, entry.text);
  for (const entry of parsePlanLog(texts.planLog)) add('plan-log', entry.at, entry.text);
  const all = [...inboxEntries(texts.inbox), ...replies].map((entry, order) => ({ entry, order, ms: entry.at === null ? null : Date.parse(entry.at) }));
  const byHours = opts.sinceHours !== undefined && Number.isFinite(opts.sinceHours) ? (opts.nowMs ?? Date.now()) - opts.sinceHours * 3_600_000 : null;
  const byTime = opts.sinceAt !== undefined && Number.isFinite(Date.parse(opts.sinceAt)) ? Date.parse(opts.sinceAt) : null;
  const sinceMs = byHours === null ? byTime : byTime === null ? byHours : Math.max(byHours, byTime);
  const beforeByHours = opts.beforeHours !== undefined && Number.isFinite(opts.beforeHours) ? (opts.nowMs ?? Date.now()) - opts.beforeHours * 3_600_000 : null;
  const beforeByTime = opts.beforeAt !== undefined && Number.isFinite(Date.parse(opts.beforeAt)) ? Date.parse(opts.beforeAt) : null;
  const beforeMs = beforeByHours === null ? beforeByTime : beforeByTime === null ? beforeByHours : Math.min(beforeByHours, beforeByTime);
  const sorted = all
    .filter(row => (sinceMs === null || row.ms === null || row.ms >= sinceMs) && (beforeMs === null || row.ms === null || row.ms < beforeMs))
    .sort((a, b) => (a.ms === null ? 1 : 0) - (b.ms === null ? 1 : 0) || (a.ms ?? 0) - (b.ms ?? 0) || a.order - b.order)
    .map(row => row.entry);
  return opts.limit !== undefined && opts.limit >= 0 && Number.isFinite(opts.limit) ? sorted.slice(Math.max(0, sorted.length - Math.floor(opts.limit))) : sorted;
}

/** One `--since`/`--before` value: hours above 0 (at most a year) or a time Date can read; null = unusable. */
function parseWhen(raw: string | undefined): { hours?: number; at?: string } | null {
  if (raw === undefined) return {};
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    const hours = Number(raw);
    if (!(hours > 0 && hours <= 24 * 365)) return null;
    return { hours };
  }
  const ms = /\d{4}-\d{2}-\d{2}/.test(raw) ? Date.parse(raw) : NaN;
  if (!Number.isFinite(ms)) return null;
  return { at: new Date(ms).toISOString() };
}

/** `--since`/`--before` are hours (a number) or a time Date can read; `--limit` is a whole number of newest messages. Null = unusable. */
export function parseThreadWindow(
  since: string | undefined,
  limit: string | undefined,
  before?: string,
): { sinceHours?: number; sinceAt?: string; beforeHours?: number; beforeAt?: string; limit?: number } | null {
  const lower = parseWhen(since);
  const upper = parseWhen(before);
  if (lower === null || upper === null) return null;
  const out: { sinceHours?: number; sinceAt?: string; beforeHours?: number; beforeAt?: string; limit?: number } = {};
  if (lower.hours !== undefined) out.sinceHours = lower.hours;
  if (lower.at !== undefined) out.sinceAt = lower.at;
  if (upper.hours !== undefined) out.beforeHours = upper.hours;
  if (upper.at !== undefined) out.beforeAt = upper.at;
  if (limit !== undefined) {
    if (!/^\d{1,4}$/.test(limit) || Number(limit) < 1) return null;
    out.limit = Number(limit);
  }
  return out;
}

export interface LeaderThreadRead {
  schema: 'leader.thread.v1';
  generatedAt: string;
  /** Each journal: read, absent, or unreadable (unknown, never silently empty). */
  sources: Record<'inbox' | 'outbox' | 'planLog', 'healthy' | 'missing' | 'unknown'>;
  thread: LeaderThreadEntry[];
}

const TAIL_BYTES = 256 * 1024;

async function readJournal(path: string): Promise<{ text: string; state: 'healthy' | 'missing' | 'unknown' }> {
  try {
    const buffer = await readFile(path);
    const text = buffer.subarray(Math.max(0, buffer.length - TAIL_BYTES)).toString('utf8');
    // A cut tail must not start mid-line.
    return { text: buffer.length > TAIL_BYTES ? text.slice(text.indexOf('\n') + 1) : text, state: 'healthy' };
  } catch (error) {
    return { text: '', state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unknown' };
  }
}

/** Read the three journals (the fleet home is ASHLR_RUNS_DIR, else ~/.ashlr-runs) and merge them. Read-only. */
export async function readLeaderThread(opts: LeaderThreadOptions & { runsDir?: string } = {}): Promise<LeaderThreadRead> {
  const dir = join(opts.runsDir ?? defaultRunsDir(), 'leader');
  const [inbox, outbox, planLog] = await Promise.all([
    readJournal(join(dir, 'MASON-INBOX.md')),
    readJournal(join(dir, 'MASON-OUTBOX.md')),
    readJournal(opts.runsDir ? join(dir, 'PLAN-LOG.md') : planLogPath()),
  ]);
  const nowMs = opts.nowMs ?? Date.now();
  return {
    schema: 'leader.thread.v1', generatedAt: new Date(nowMs).toISOString(),
    sources: { inbox: inbox.state, outbox: outbox.state, planLog: planLog.state },
    thread: mergeLeaderThread({ inbox: inbox.text, outbox: outbox.text, planLog: planLog.text }, { ...opts, nowMs }),
  };
}
