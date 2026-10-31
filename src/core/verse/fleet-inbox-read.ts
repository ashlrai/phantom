import { scrubSecrets } from '../util/scrub.js';

export const VERSE_FLEET_RUNS_INBOX_READ_LIMIT_MAX = 200;
type InboxReadQuery = { limit: number; source: string | null };
export type FleetInboxReadV1 = {
  v: 1; generatedAt: string; sourceState: 'healthy' | 'degraded' | 'missing';
  limit: number; source: string | null; dropped: number;
  /** Selected newest matching entries, in oldest-first file order (including timestamp ties). */
  entries: Array<{ at: string; source: string; priority: string | null; text: string }>;
};

export function parseInboxReadQuery(search: string | URLSearchParams): InboxReadQuery | { error: string } {
  const params = new URLSearchParams(search);
  for (const key of params.keys()) {
    if (!['limit', 'source'].includes(key) || params.getAll(key).length !== 1) return { error: 'invalid query parameter' };
  }
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (rawLimit !== null && (!/^\d+$/.test(rawLimit) || !Number.isSafeInteger(limit) || limit < 1 || limit > VERSE_FLEET_RUNS_INBOX_READ_LIMIT_MAX)) return { error: 'invalid limit' };
  const source = params.get('source');
  if (source !== null && !/^[A-Za-z0-9 ._-]{1,40}$/.test(source)) return { error: 'invalid source' };
  return { limit, source };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
// Reject paths in every exposed field, including paths following punctuation.
const privatePath = /(?:^|[\s"'`(=:\[])\/(?!\/)[^\s]*|(?:^|[^A-Za-z])[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|~[\\/]/;
function safeString(value: unknown): string | null {
  if (typeof value !== 'string' || privatePath.test(value)) return null;
  const clean = scrubSecrets(value);
  return privatePath.test(clean) ? null : clean;
}

export function projectInboxRead(raw: unknown, query: InboxReadQuery): FleetInboxReadV1 | null {
  if (!record(raw) || typeof raw.sourceState !== 'string' || !['healthy', 'degraded', 'missing'].includes(raw.sourceState) || !Array.isArray(raw.entries)) return null;
  const entries: FleetInboxReadV1['entries'] = [];
  let dropped = 0;
  for (const item of raw.entries) {
    if (!record(item)) { dropped++; continue; }
    const at = safeString(item.at), source = safeString(item.source), text = safeString(item.text);
    const priority = item.priority === null ? null : safeString(item.priority);
    if (at === null || source === null || text === null || (item.text as string).length > 6000 || (item.priority !== null && priority === null)) { dropped++; continue; }
    if (query.source === null || source.toLowerCase() === query.source.toLowerCase()) entries.push({ at, source, priority, text });
  }
  // The inbox reader supplies newest-first file order; select before reversing
  // for the oldest-first wire contract used by the phone reader.
  return { v: 1, generatedAt: new Date().toISOString(), sourceState: raw.sourceState as FleetInboxReadV1['sourceState'],
    limit: query.limit, source: query.source === null ? null : scrubSecrets(query.source), dropped, entries: entries.slice(0, query.limit).reverse() };
}
