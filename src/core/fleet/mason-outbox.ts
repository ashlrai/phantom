import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { FLEET_RUNS_INBOX_MAX_CHARS } from '../verse/fleet-runs-types.js';

export interface OutboxEntry {
  /** Heading wall time, `YYYY-MM-DD HH:MM` ET or ISO; '' when the heading has none. */
  at: string;
  heading?: string;
  /** PLAN-LOG only: stable id derived from the entry heading. */
  id?: string;
  /** MASON-OUTBOX only: the leader-network request id a `[leader-network:reply-<id>]` heading answers. */
  replyTo?: string;
  text: string;
}

/** One reply as `phm leader replies --json`, the Home cards and agents read it. */
export interface LeaderReply {
  /** The heading's wall time (`YYYY-MM-DD HH:MM` ET) or ISO instant; 'unknown' when no dated heading sits above the reply. */
  at: string;
  text: string;
  source: 'plan-log' | 'outbox';
}

export interface LeaderRepliesV1 {
  schema: 'leader.replies.v1';
  version: 1;
  /** The plan log: read, absent, or unreadable. */
  sourceState: 'healthy' | 'missing' | 'unknown';
  reason?: string;
  /** Newest first, identical text once, each at most LEADER_REPLY_MAX_CHARS. */
  replies: LeaderReply[];
  /** Dated plan-log replies only, newest first, with the stable ids `replies sync` posts under. */
  entries: OutboxEntry[];
}

export const LEADER_REPLY_MAX_CHARS = 1200;
/** The plan log is large and grows; the replies reader looks at its end only. */
export const LEADER_REPLIES_TAIL_BYTES = 200 * 1024;
const MAX_READ_BYTES = 256 * 1024;
// The leader's outbox is free-form Markdown; the first ISO 8601 or
// "YYYY-MM-DD HH:MM" run in a "## " heading is the entry's time and every
// other heading word stays as text. The leader writes approximate times as
// "2026-11-16 ~22:55 ET"; the "~" is dropped and the wall time normalised.
const HEADING_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|(\d{4}-\d{2}-\d{2}) ~?(\d{1,2}):(\d{2})(?!\d)/;

function headingAt(match: RegExpExecArray): string {
  return match[1] ? `${match[1]} ${match[2]!.padStart(2, '0')}:${match[3]}` : match[0];
}

// "**Reply for Mason** (for OUTBOXFALLBACK to copy): "text"" and older shapes:
// optional bullet or heading, optional bold, an optional parenthetical note
// before the colon. Group 1 is the reply text.
const REPLY_MARKER = /^(?:[-*]\s+|#{1,6}\s+)?(?:\*\*)?(?:Reply for Mason(?:, to copy there)?|MASON-OUTBOX)(?:\*\*)?(?:\s*\([^)\n]*\))?\s*:?(?:\*\*)?\s*(.*)$/i;

/** Drop one pair of outer quotes; quotes inside the reply stay. */
function unquote(text: string): string {
  const match = /^(["\u201C])([\s\S]*)(["\u201D])$/.exec(text);
  return match && match[2]!.trim() ? match[2]!.trim() : text;
}

/** Stable across reads and rotations: the same heading always yields the same id. */
export function planReplyId(heading: string): string {
  return `plan-${createHash('sha256').update(heading.trim()).digest('hex').slice(0, 16)}`;
}

/** One plain line per reply for terminal output; a missing time reads "unknown". */
export function replyLine(entry: Pick<OutboxEntry, 'at' | 'text'>): string {
  return `${entry.at || 'unknown'}  ${entry.text.replace(/\s+/g, ' ').trim()}`;
}

function cap(text: string): string {
  return scrubSecrets(text).slice(0, FLEET_RUNS_INBOX_MAX_CHARS);
}

/** Oldest-first file order, keeping the newest `limit` entries. */
export function parseOutbox(markdown: string, limit = 30): OutboxEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  if (!lines.some(line => line.startsWith('## '))) {
    const text = markdown.replace(/\r\n/g, '\n').trim();
    return text ? [{ at: '', text: cap(text) }] : [];
  }
  const entries: OutboxEntry[] = [];
  let openEntry = false;
  let at = '';
  let words = '';
  let replyTo: string | undefined;
  let body: string[] = [];
  const finish = (): void => {
    if (!openEntry) return;
    entries.push({ at, ...(replyTo ? { replyTo } : {}), text: cap([body.join('\n').trim(), words].filter(part => part !== '').join('\n')) });
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      finish();
      openEntry = true;
      at = '';
      body = [];
      replyTo = /\[leader-network:reply-([a-f0-9]{64})\]$/.exec(line)?.[1];
      const rest = line.slice(3).replace(/\s*\[leader-network:(?:reply-|digest-)[a-f0-9]{64}\]$/, '');
      const match = HEADING_TIME.exec(rest);
      if (match) {
        at = headingAt(match);
        words = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`.replace(/\s+/g, ' ').trim();
      } else {
        words = rest.trim();
      }
    } else if (openEntry) {
      body.push(line);
    }
    // Lines before the first "## " heading — a "# " title and blank preamble —
    // belong to no entry.
  }
  finish();
  return entries.slice(-Math.floor(limit));
}

/** Extract only explicit leader replies, retaining their section's wall-clock time. */
export function parsePlanLog(markdown: string): OutboxEntry[] {
  const entries: OutboxEntry[] = [];
  let at = '';
  let heading = '';
  let body: string[] | null = null;
  let entryIndex = -1;
  const finish = (): void => {
    const text = body?.join('\n').trim();
    if (text) {
      const reply = { at, heading, id: planReplyId(heading), text: cap(unquote(text)) };
      if (entryIndex >= 0) entries[entryIndex] = reply;
      else { entryIndex = entries.length; entries.push(reply); }
    }
    body = null;
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = REPLY_MARKER.exec(line);
    if (marker) {
      finish();
      body = [marker[1]!];
    } else if (/^#{1,6} /.test(line)) {
      finish();
      if (line.startsWith('## ')) {
        entryIndex = -1;
        heading = line.slice(3).trim();
        const match = HEADING_TIME.exec(line);
        at = match ? headingAt(match) : /^## (\d{4}-\d{2}-\d{2}) ET/.exec(line)?.[1] ?? '';
      }
    } else if (body !== null) {
      body.push(line);
    }
  }
  finish();
  return entries;
}

/** Interpret journal wall times in Eastern time, independent of the server timezone. */
export function replyTime(at: string): number {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) return Date.parse(at);
  const wall = Date.parse(at.replace(' ', 'T') + ':00Z');
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let instant = wall;
  for (let i = 0; i < 2; i++) {
    const parts = formatter.formatToParts(instant);
    const n = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(p => p.type === type)?.value);
    instant += wall - Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'));
  }
  return instant;
}

export function replyTextHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}

/** Bounded, read-only tail; never expose a partial first line. */
async function readTail(path: string, maxBytes = MAX_READ_BYTES): Promise<string> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const offset = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - offset);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let markdown = buffer.subarray(0, bytesRead).toString('utf8');
    if (offset > 0) {
      const firstNewline = markdown.indexOf('\n');
      markdown = firstNewline < 0 ? '' : markdown.slice(firstNewline + 1);
    }
    return markdown;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** Read both journals without modifying them; dedupe before taking the newest replies. */
export async function readOutboxEntries(opts: { runsDir?: string; limit?: number } = {}): Promise<{ sourceState: 'healthy' | 'missing' | 'degraded'; entries: OutboxEntry[] }> {
  const runsDir = opts.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  let sourceState: 'healthy' | 'missing' | 'degraded' = 'missing';
  const entries: OutboxEntry[] = [];
  for (const name of ['MASON-OUTBOX.md', 'PLAN-LOG.md']) {
    try {
      const markdown = await readTail(join(runsDir, 'leader', name));
      entries.push(...(name === 'PLAN-LOG.md' ? parsePlanLog(markdown).map(({ at, text }) => ({ at, text })) : parseOutbox(markdown, Number.MAX_SAFE_INTEGER)));
      if (sourceState !== 'degraded') sourceState = 'healthy';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') sourceState = 'degraded';
    }
  }
  // Sort first so a duplicate keeps its newest timestamp across both journals.
  entries.sort((a, b) => (replyTime(b.at) || 0) - (replyTime(a.at) || 0));
  const seen = new Set<string>();
  const unique = entries.filter(entry => {
    const hash = `${entry.at.slice(0, 10)}:${replyTextHash(entry.text)}`;
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  }).sort((a, b) => (replyTime(a.at) || 0) - (replyTime(b.at) || 0));
  const limit = opts.limit ?? 30;
  return { sourceState, entries: Number.isFinite(limit) && limit > 0 ? unique.slice(-Math.floor(limit)) : [] };
}

/**
 * Where the PLAN-LOG lives: the explicit path, then PHANTOM_PLAN_LOG, then the
 * `comms.leaderPlanLogPath` config value, then the runs dir.
 */
export function planLogPath(file?: string, configured?: string): string {
  return file || process.env.PHANTOM_PLAN_LOG || configured || join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'leader', 'PLAN-LOG.md');
}

/** Dated replies, oldest first, keeping the newest copy of each text per date. */
function datedPlanReplies(parsed: OutboxEntry[], limit: number): OutboxEntry[] {
  const seen = new Set<string>();
  const entries = parsed
    .filter(e => e.at && e.heading && Number.isFinite(replyTime(e.at)))
    .sort((a, b) => replyTime(b.at) - replyTime(a.at))
    .filter(e => {
      const hash = `${e.at.slice(0, 10)}:${replyTextHash(e.text)}`;
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    }).reverse();
  return Number.isFinite(limit) && limit > 0 ? entries.slice(-Math.floor(limit)) : [];
}

const planLogFailure = (error: unknown, path: string): { sourceState: 'missing' | 'unknown'; reason: string } => {
  const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
  return { sourceState: missing ? 'missing' : 'unknown', reason: missing ? `No PLAN-LOG file at ${path}, so there are no replies yet.` : `Could not read the PLAN-LOG at ${path}.` };
};

/** Explicit PLAN-LOG replies: dated/text-deduped by default, or latest file entries with fileOrder. */
export async function readPlanLogReplies(opts: { limit?: number; file?: string; planLog?: string; fileOrder?: boolean } = {}): Promise<{ sourceState: 'healthy' | 'missing' | 'unknown'; entries: OutboxEntry[]; reason?: string }> {
  const path = planLogPath(opts.file, opts.planLog);
  try {
    const parsed = parsePlanLog(await readTail(path));
    return { sourceState: 'healthy', entries: opts.fileOrder ? parsed.slice(-(opts.limit ?? 30)) : datedPlanReplies(parsed, opts.limit ?? 30) };
  } catch (error) {
    return { ...planLogFailure(error, path), entries: [] };
  }
}

/** The reply itself: the leading quoted paragraph or blockquote when there is one, else the whole block. */
function replyParagraph(text: string): string {
  if (text.startsWith('>')) {
    const lines = text.split('\n');
    const end = lines.findIndex(line => !line.startsWith('>'));
    return unquote((end < 0 ? lines : lines.slice(0, end)).map(line => line.replace(/^>\s?/, '')).join('\n').trim());
  }
  // A quoted first paragraph is the whole reply; plan notes after it are not for Mason.
  const paragraph = text.split(/\n[ \t]*\n/, 1)[0]!.trim();
  const inner = unquote(paragraph);
  return inner === paragraph ? text : inner;
}

type RankedReply = LeaderReply & { rank: number };

/** File order in, one rank per reply: its own time, or the last dated reply above it when its time is unknown. */
function rankReplies(entries: OutboxEntry[], source: LeaderReply['source']): RankedReply[] {
  let last = -Infinity;
  return entries.map(entry => {
    const time = replyTime(entry.at);
    if (Number.isFinite(time)) last = time;
    return { at: Number.isFinite(time) ? entry.at : 'unknown', text: source === 'plan-log' ? replyParagraph(entry.text) : entry.text, source, rank: last };
  });
}

function newestReplies(ranked: RankedReply[], limit: number): LeaderReply[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const seen = new Set<string>();
  return ranked
    .map((reply, index) => ({ reply, index }))
    // Equal or unknown ranks fall back to position: later in the file is newer.
    .sort((a, b) => (b.reply.rank - a.reply.rank) || (b.index - a.index))
    .filter(({ reply }) => {
      const key = reply.text.replace(/\s+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, Math.floor(limit))
    .map(({ reply: { at, text, source } }) => ({ at, text: text.length > LEADER_REPLY_MAX_CHARS ? `${text.slice(0, LEADER_REPLY_MAX_CHARS - 1)}…` : text, source }));
}

/** Pure: the newest `limit` replies in one journal's Markdown, newest first, identical text once. */
export function parseLeaderReplies(markdown: string, limit = 10, source: LeaderReply['source'] = 'plan-log'): LeaderReply[] {
  return newestReplies(rankReplies(source === 'outbox' ? parseOutbox(markdown, Number.MAX_SAFE_INTEGER) : parsePlanLog(markdown), source), limit);
}

/**
 * What the leader last told Mason: the end of the plan log plus, unless one
 * file was named, the MASON-OUTBOX beside it. Read only; nothing is sent.
 */
export async function readLeaderReplies(opts: { limit?: number; file?: string; planLog?: string } = {}): Promise<LeaderRepliesV1> {
  const path = planLogPath(opts.file, opts.planLog);
  const limit = opts.limit ?? 10;
  const ranked: RankedReply[] = [];
  if (!opts.file) {
    // The outbox is optional: when it is absent or unreadable the plan log still answers.
    try { ranked.push(...rankReplies(parseOutbox(await readTail(join(dirname(path), 'MASON-OUTBOX.md'), LEADER_REPLIES_TAIL_BYTES), Number.MAX_SAFE_INTEGER), 'outbox')); } catch { /* optional */ }
  }
  let state: Pick<LeaderRepliesV1, 'sourceState' | 'reason'> = { sourceState: 'healthy' };
  let entries: OutboxEntry[] = [];
  try {
    const parsed = parsePlanLog(await readTail(path, LEADER_REPLIES_TAIL_BYTES));
    // After the outbox, so the plan log's copy wins a tie.
    ranked.push(...rankReplies(parsed, 'plan-log'));
    entries = datedPlanReplies(parsed, limit).reverse();
  } catch (error) {
    state = planLogFailure(error, path);
  }
  return { schema: 'leader.replies.v1', version: 1, ...state, replies: newestReplies(ranked, limit), entries };
}
