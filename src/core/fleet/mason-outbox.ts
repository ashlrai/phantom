import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { FLEET_RUNS_INBOX_MAX_CHARS } from '../verse/fleet-runs-types.js';

export interface OutboxEntry {
  at: string;
  heading?: string;
  text: string;
}

const MAX_READ_BYTES = 256 * 1024;
// The leader's outbox is free-form Markdown; the first ISO 8601 or
// "YYYY-MM-DD HH:MM" run in a "## " heading is the entry's time and every
// other heading word stays as text.
const HEADING_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?|\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

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
  let body: string[] = [];
  const finish = (): void => {
    if (!openEntry) return;
    entries.push({ at, text: cap([body.join('\n').trim(), words].filter(part => part !== '').join('\n')) });
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      finish();
      openEntry = true;
      at = '';
      body = [];
      const rest = line.slice(3).replace(/\s*\[leader-network:(?:reply-|digest-)[a-f0-9]{64}\]$/, '');
      const match = HEADING_TIME.exec(rest);
      if (match) {
        at = match[0];
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
      const reply = { at, heading, text: cap(text) };
      if (entryIndex >= 0) entries[entryIndex] = reply;
      else { entryIndex = entries.length; entries.push(reply); }
    }
    body = null;
  };
  for (const line of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const marker = /^(?:[-*]\s+|#{1,6}\s+)?(?:\*\*)?(?:Reply for Mason(?:, to copy there)?|MASON-OUTBOX)(?:\*\*)?\s*:?(?:\*\*)?\s*(.*)$/i.exec(line);
    if (marker) {
      finish();
      body = [marker[1]!];
    } else if (/^#{1,6} /.test(line)) {
      finish();
      if (line.startsWith('## ')) {
        entryIndex = -1;
        heading = line.slice(3).trim();
        at = HEADING_TIME.exec(line)?.[0] ?? /^## (\d{4}-\d{2}-\d{2}) ET/.exec(line)?.[1] ?? '';
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
async function readTail(path: string): Promise<string> {
  const handle = await open(path, 'r');
  try {
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

/** Where the PLAN-LOG lives: explicit path, then PHANTOM_PLAN_LOG, then the runs dir. */
export function planLogPath(file?: string): string {
  return file || process.env.PHANTOM_PLAN_LOG || join(process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), 'leader', 'PLAN-LOG.md');
}

/** Only explicit dated PLAN-LOG replies, keeping the newest copy of each text per date. */
export async function readPlanLogReplies(opts: { limit?: number; file?: string } = {}): Promise<{ sourceState: 'healthy' | 'missing' | 'unknown'; entries: OutboxEntry[]; reason?: string }> {
  const path = planLogPath(opts.file);
  try {
    const limit = opts.limit ?? 30;
    const seen = new Set<string>();
    const entries = parsePlanLog(await readTail(path))
      .filter(e => e.at && e.heading && Number.isFinite(replyTime(e.at)))
      .sort((a, b) => replyTime(b.at) - replyTime(a.at))
      .filter(e => {
        const hash = `${e.at.slice(0, 10)}:${replyTextHash(e.text)}`;
        if (seen.has(hash)) return false;
        seen.add(hash);
        return true;
      }).reverse();
    return { sourceState: 'healthy', entries: Number.isFinite(limit) && limit > 0 ? entries.slice(-Math.floor(limit)) : [] };
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return { sourceState: missing ? 'missing' : 'unknown', entries: [], reason: missing ? `No PLAN-LOG file at ${path}, so there are no replies yet.` : `Could not read the PLAN-LOG at ${path}.` };
  }
}
