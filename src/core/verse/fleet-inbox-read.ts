import { scrubSecrets } from '../util/scrub.js';

export const VERSE_FLEET_RUNS_INBOX_READ_LIMIT_MAX = 200;
// Same needle bound the unified comms inbox applies to --contains.
const INBOX_READ_CONTAINS_MAX = 512;

// Validate the calendar fields before Date.parse, which otherwise normalizes invalid dates.
type Instant = { seconds: number; fraction: string };
function rfc3339Instant(value: string): Instant | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?([Zz]|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return undefined;
  const [, y, m, d, h, min, s, fraction = '', zone] = match;
  const year = Number(y), month = Number(m), day = Number(d);
  const calendar = new Date(0); calendar.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > calendar.getUTCDate() ||
    Number(h) > 23 || Number(min) > 59 || Number(s) > 59 || zone === '-00:00' ||
    (zone!.toUpperCase() !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59))) return undefined;
  const milliseconds = Date.parse(`${y}-${m}-${d}T${h}:${min}:${s}${zone!.toUpperCase()}`);
  if (!Number.isFinite(milliseconds)) return undefined;
  return { seconds: milliseconds / 1000, fraction: fraction.replace(/0+$/, '') };
}

const easternClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const easternOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' });

/** Parse an inbox entry's `at` — `YYYY-MM-DD HH:MM` Eastern wall time or RFC3339 — to an instant; undefined when neither form reads. */
export function entryInstant(at: string): Instant | undefined {
  const local = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(at);
  if (!local) return rfc3339Instant(at);
  const [, year, month, day, hour, minute] = local;
  const wall = rfc3339Instant(`${year}-${month}-${day}T${hour}:${minute}:00Z`);
  if (wall === undefined) return undefined;
  const wallMs = wall.seconds * 1000;
  const candidates = new Set<number>();
  // Sample both sides of a transition, then validate the round-trip in Eastern time.
  for (const delta of [-86_400_000, 0, 86_400_000]) {
    const offset = easternOffset.formatToParts(new Date(wallMs + delta)).find(part => part.type === 'timeZoneName')?.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset ?? '');
    if (!match) continue;
    const minutes = (Number(match[2]) * 60 + Number(match[3])) * (match[1] === '+' ? 1 : -1);
    const candidate = wallMs - minutes * 60_000;
    const parts = easternClock.formatToParts(new Date(candidate));
    const part = (type: Intl.DateTimeFormatPartTypes): string | undefined => parts.find(item => item.type === type)?.value;
    if (`${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}` === at) candidates.add(candidate);
  }
  return candidates.size === 1 ? { seconds: [...candidates][0]! / 1000, fraction: '' } : undefined;
}

function laterThan(left: Instant, right: Instant): boolean {
  if (left.seconds !== right.seconds) return left.seconds > right.seconds;
  const length = Math.max(left.fraction.length, right.fraction.length);
  return left.fraction.padEnd(length, '0') > right.fraction.padEnd(length, '0');
}

type InboxReadQuery = {
  limit: number;
  source: string | null;
  /** Keeps only projected entries whose scrubbed text carries the needle as a case-insensitive substring — the same match `comms inbox read --contains` applies. */
  contains?: string;
  /** Keeps only entries whose own priority label is strictly equal — the same exact match `comms inbox read --priority` applies. */
  priority?: string;
  /** Exclusive lower/upper bounds on the entry's parsed `at` instant, composing into one `(after, before)` window — the same strict bounds `comms inbox read --after/--before` apply; an entry whose `at` parses as neither Eastern wall time nor RFC3339 is excluded while either bound is set. */
  after?: Instant;
  before?: Instant;
};
export type FleetInboxReadV1 = {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'degraded' | 'missing';
  limit: number; source: string | null; dropped: number;
  /** Selected newest matching entries, in oldest-first file order (including timestamp ties). */
  entries: Array<{ at: string; source: string; priority: string | null; text: string }>;
};

export function parseInboxReadQuery(search: string | URLSearchParams): InboxReadQuery | { error: string } {
  const params = new URLSearchParams(search);
  const keys = ['limit', 'source', 'contains', 'priority', 'after', 'before'];
  for (const key of params.keys()) {
    if (!keys.includes(key) || params.getAll(key).length !== 1) return { error: 'invalid query parameter' };
  }
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > VERSE_FLEET_RUNS_INBOX_READ_LIMIT_MAX)) return { error: 'invalid limit' };
  const source = params.get('source');
  if (source !== null && !/^[A-Za-z0-9 ._-]{1,40}$/.test(source)) return { error: 'invalid source' };
  const contains = params.get('contains');
  if (contains !== null && (!contains.trim() || contains.length > INBOX_READ_CONTAINS_MAX)) return { error: 'invalid contains' };
  const priority = params.get('priority');
  if (priority !== null && !/^P[0-3]$/.test(priority)) return { error: 'invalid priority' };
  const rawAfter = params.get('after'), rawBefore = params.get('before');
  const after = rawAfter === null ? undefined : rfc3339Instant(rawAfter);
  const before = rawBefore === null ? undefined : rfc3339Instant(rawBefore);
  if (rawAfter !== null && after === undefined) return { error: 'invalid after' };
  if (rawBefore !== null && before === undefined) return { error: 'invalid before' };
  if (after !== undefined && before !== undefined && !laterThan(before, after)) return { error: 'invalid window' };
  return { limit, source,
    ...(contains === null ? {} : { contains }), ...(priority === null ? {} : { priority }),
    ...(after === undefined ? {} : { after }), ...(before === undefined ? {} : { before }) };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// Reject paths in every exposed field, including paths following punctuation.
const privatePath = /(?:^|[\s"'`(=:[])\/(?!\/)[^\s]*|(?:^|[^A-Za-z])[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|~[\\/]/;
function safeString(value: unknown): string | null {
  if (typeof value !== 'string' || privatePath.test(value)) return null;
  const clean = scrubSecrets(value);
  return privatePath.test(clean) ? null : clean;
}

export function projectInboxRead(raw: unknown, query: InboxReadQuery): FleetInboxReadV1 | null {
  if (!record(raw) || typeof raw.sourceState !== 'string' || !['healthy', 'degraded', 'missing'].includes(raw.sourceState) || !Array.isArray(raw.entries)) return null;
  const needle = query.contains?.toLowerCase();
  const entries: FleetInboxReadV1['entries'] = [];
  let dropped = 0;
  for (const item of raw.entries) {
    if (!record(item)) { dropped++; continue; }
    const at = safeString(item.at), source = safeString(item.source), text = safeString(item.text);
    const priority = item.priority === null ? null : safeString(item.priority);
    if (at === null || source === null || text === null || (item.text as string).length > 6000 || (item.priority !== null && priority === null)) { dropped++; continue; }
    // Channel records retain their receipt ID in the display source. Match the
    // actual channel only when it is bound to that display attribution.
    const channel = typeof item.channel === 'string' && /^[a-z0-9._-]{1,32}$/.test(item.channel)
      && (source === item.channel || (typeof item.id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(item.id)
        && source === `${item.channel} (${item.id})`)) ? item.channel : null;
    if (query.source !== null && source.toLowerCase() !== query.source.toLowerCase() && channel !== query.source.toLowerCase()) continue;
    if (query.priority !== undefined && priority !== query.priority) continue;
    if (needle !== undefined && !text.toLowerCase().includes(needle)) continue;
    if (query.after !== undefined || query.before !== undefined) {
      const instant = entryInstant(at);
      if (instant === undefined) continue;
      if (query.after !== undefined && !laterThan(instant, query.after)) continue;
      if (query.before !== undefined && !laterThan(query.before, instant)) continue;
    }
    entries.push({ at, source, priority, text });
  }
  // The inbox reader supplies newest-first file order; select before reversing
  // for the oldest-first wire contract used by the phone reader.
  return { v: 1, generatedAt: new Date().toISOString(), sourceState: raw.sourceState as FleetInboxReadV1['sourceState'],
    limit: query.limit, source: query.source === null ? null : scrubSecrets(query.source), dropped, entries: entries.slice(0, query.limit).reverse() };
}
