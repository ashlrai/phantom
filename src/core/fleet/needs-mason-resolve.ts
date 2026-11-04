/**
 * Round trip for NEEDS-MASON.md: Mason resolves an open line from the /verse/
 * console, one `needs_mason.resolved` envelope lands on the durable bus, and a
 * marker line is appended to the same file so the glance reader stops listing
 * the item. Pure file + bus logic; the HTTP guards live in agent-bus-api.ts.
 *
 * Item ids are `nm-` + 12 hex of sha256 over the cleaned line text, so they
 * survive reordering and need no extra index. The reply is untrusted: it goes
 * to the bus body only, never into the markdown marker.
 */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { appendBusInbox, type BusInboxOptions } from './bus-inbox.js';

export const NEEDS_MASON_REPLY_MAX = 500;
export const NEEDS_MASON_RESOLVED_KIND = 'needs_mason.resolved';
const MAX_BYTES = 32 * 1024;
const TEXT_MAX = 300;
const MARKER = /^[-*]\s+\[[xX]\]\s+resolved\s+(nm-[0-9a-f]{12})\b/;
const ID = /^nm-[0-9a-f]{12}$/;

export interface NeedsMasonItem { id: string; text: string }
export interface NeedsMasonOptions {
  runsDir?: string; bus?: BusInboxOptions; now?: () => number;
  /** Which surface resolved the item; recorded in the envelope body. Defaults to 'desktop'. */
  source?: 'desktop' | 'telegram' | 'cli' | 'phone';
}
export type NeedsMasonResolveResult =
  | { ok: true; itemId: string; cursor: number; duplicate: boolean }
  | { ok: false; code: 'invalid' | 'reply-too-long' | 'unknown' | 'already-resolved' | 'unavailable'; error: string };

const runsDirOf = (options: NeedsMasonOptions): string =>
  options.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
const fileOf = (options: NeedsMasonOptions): string => join(runsDirOf(options), 'NEEDS-MASON.md');
const itemId = (text: string): string => `nm-${createHash('sha256').update(text).digest('hex').slice(0, 12)}`;

type TextRead = { status: 'ok'; text: string } | { status: 'missing' | 'unavailable' };

function readTextResult(path: string): TextRead {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unavailable' }; }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_BYTES) return { status: 'unavailable' };
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!n) return { status: 'unavailable' };
      offset += n;
    }
    return { status: 'ok', text: scrubSecrets(bytes.toString('utf8')) };
  } catch { return { status: 'unavailable' }; }
  finally { try { closeSync(fd); } catch { /* The read result remains usable. */ } }
}

function readText(path: string): string | null {
  const result = readTextResult(path);
  return result.status === 'ok' ? result.text : null;
}

/** Open candidates follow the glance rule (parseIncidentLines): no headings, no resolved or checked lines. */
function scan(text: string): { candidates: NeedsMasonItem[]; resolved: Set<string> } {
  const candidates: NeedsMasonItem[] = [], resolved = new Set<string>(), seen = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const marker = MARKER.exec(line);
    if (marker) { resolved.add(marker[1]!); continue; }
    const body = line.replace(/^[-*]\s+/, '');
    if (!body || body.startsWith('#') || /\bresolved\b/i.test(body) || /^\[[xX]\]/.test(body)) continue;
    const clean = body.replace(/^\[ \]\s+/, '').slice(0, TEXT_MAX).trim();
    const id = clean ? itemId(clean) : '';
    if (clean && !seen.has(id)) { seen.add(id); candidates.push({ id, text: clean }); }
  }
  return { candidates, resolved };
}

export type NeedsMasonReadResult =
  | { status: 'available' | 'missing'; items: NeedsMasonItem[] }
  | { status: 'unavailable'; items: NeedsMasonItem[] };

/** Read the ledger without confusing an unavailable file with an empty one. */
export function readNeedsMason(options: NeedsMasonOptions = {}): NeedsMasonReadResult {
  const result = readTextResult(fileOf(options));
  if (result.status !== 'ok') return { status: result.status, items: [] };
  const { candidates, resolved } = scan(result.text);
  return { status: 'available', items: candidates.filter(item => !resolved.has(item.id)) };
}

/** Items still waiting on Mason, as the glance reader sees them. */
export function listNeedsMason(options: NeedsMasonOptions = {}): NeedsMasonItem[] {
  return readNeedsMason(options).items;
}

/** The glance reader's view: resolved item lines removed (markers already read as resolved). */
export function hideResolvedNeedsMason(text: string | null): string | null {
  if (text === null) return null;
  const { candidates, resolved } = scan(text);
  if (resolved.size === 0) return text;
  const hidden = new Set(candidates.filter(item => resolved.has(item.id)).map(item => item.text));
  return text.split(/\r?\n/).filter(raw => {
    const clean = raw.trim().replace(/^[-*]\s+/, '').replace(/^\[ \]\s+/, '').slice(0, TEXT_MAX).trim();
    return !hidden.has(clean);
  }).join('\n');
}

const fail = (code: Extract<NeedsMasonResolveResult, { ok: false }>['code'], error: string): NeedsMasonResolveResult =>
  ({ ok: false, code, error });

/**
 * Validate, publish one bus envelope, then append the marker. The envelope id is
 * derived from the item id, so a retry after a failed marker write dedupes on the
 * bus instead of publishing a second event.
 */
export function resolveNeedsMason(input: unknown, options: NeedsMasonOptions = {}): NeedsMasonResolveResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return fail('invalid', 'Expected {itemId, reply?}.');
  const { itemId: id, reply, ...extra } = input as Record<string, unknown>;
  if (Object.keys(extra).length > 0 || typeof id !== 'string' || !ID.test(id) || (reply !== undefined && typeof reply !== 'string')) {
    return fail('invalid', 'Expected {itemId, reply?} with a needs-you item id.');
  }
  if (typeof reply === 'string' && reply.length > NEEDS_MASON_REPLY_MAX) {
    return fail('reply-too-long', `Reply is limited to ${NEEDS_MASON_REPLY_MAX} characters.`);
  }
  const path = fileOf(options);
  const text = readText(path);
  const { candidates, resolved } = text === null ? { candidates: [], resolved: new Set<string>() } : scan(text);
  const item = candidates.find(candidate => candidate.id === id);
  if (!item) return fail('unknown', 'No such needs-you item.');
  if (resolved.has(id)) return fail('already-resolved', 'That item is already resolved.');
  const now = options.now ?? Date.now;
  // Control characters (newlines included) collapse to spaces; the reply stays a single line of text.
  // eslint-disable-next-line no-control-regex
  const note = typeof reply === 'string' ? reply.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : '';
  const posted = appendBusInbox({
    id: `needs-mason-resolved-${id}`, from: 'mason', to: 'leaders', priority: 'P1', ttl: 7 * 24 * 60 * 60 * 1000,
    body: {
      kind: NEEDS_MASON_RESOLVED_KIND, itemId: id, source: options.source ?? 'desktop', item: item.text,
      ...(note ? { reply: note } : {}), resolvedAt: new Date(now()).toISOString(),
    },
  }, { ...options.bus, now: options.bus?.now ?? now });
  if (posted.status !== 'posted' && posted.status !== 'duplicate') return fail('unavailable', 'The bus did not accept the resolution.');
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
    try { writeSync(fd, `\n- [x] resolved ${id} ${new Date(now()).toISOString()}\n`); } finally { closeSync(fd); }
  } catch { return fail('unavailable', 'The resolution marker could not be written; retry.'); }
  return { ok: true, itemId: id, cursor: posted.cursor, duplicate: posted.status === 'duplicate' };
}
