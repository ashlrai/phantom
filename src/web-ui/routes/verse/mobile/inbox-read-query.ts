/**
 * routes/verse/mobile/inbox-read-query.ts — the phone's end of the whole-
 * inbox read the Mac landed in #1612:
 *
 *   GET /api/verse/fleet/runs/inbox?limit=N   FleetInboxReadV1
 *
 * Same family rules as runs-queries.ts and bus-query.ts: a 404 is "not in
 * this build yet" — remembered once seen, never asked again this page
 * lifetime — and a body this build cannot read is rejected, never guessed.
 * The wire orders entries oldest-first; the Inbox screen reads newest
 * first, so the narrowing reverses. The route's types are NOT imported
 * from core: it may not exist in this build.
 */
import { ApiError, apiGet } from '../../../data/client.js';
import type { QueryDef } from '../../../data/queries.js';
import { FLEET_RUNS_INBOX_PATH } from './runs-queries.js';

/** The read route's own cap — a larger limit is clamped, never an error. */
export const INBOX_READ_LIMIT_MAX = 200;
/** What the screen asks for. */
export const INBOX_READ_LIMIT = 100;
/** What the phone says when the Mac's build lacks the route. */
export const INBOX_NOT_IN_THIS_BUILD = 'Inbox is not in this build yet.';

export interface FleetInboxReadEntry {
  at: string;
  source: string;
  priority: string | null;
  text: string;
}

/** FleetInboxReadV1 narrowed to what the Inbox screen renders. */
export interface FleetInboxReadLite {
  generatedAt: string;
  sourceState: 'healthy' | 'degraded' | 'missing';
  limit: number;
  source: string | null;
  dropped: number;
  /** Newest first (the wire is oldest-first). */
  entries: FleetInboxReadEntry[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const strOrNull = (v: unknown): v is string | null => v === null || str(v);
const isEntry = (v: unknown): v is FleetInboxReadEntry => isRecord(v)
  && str(v['at']) && str(v['source']) && strOrNull(v['priority']) && str(v['text']);

/** Structural narrowing — never throws. `null` means "not the contract", not "empty". */
export function narrowInboxRead(raw: unknown): FleetInboxReadLite | null {
  if (!isRecord(raw) || raw['v'] !== 1) return null;
  const { generatedAt, sourceState, limit, source, dropped, entries } = raw;
  if (!str(generatedAt)
    || (sourceState !== 'healthy' && sourceState !== 'degraded' && sourceState !== 'missing')
    || !num(limit) || !strOrNull(source) || !num(dropped)
    || !Array.isArray(entries) || !entries.every(isEntry)) return null;
  // File order is chronological and the wire ships it oldest-first; the
  // screen wants newest first. Reversing keeps that order even where `at`
  // is not a parseable date (a heading the server could not read).
  const clean = (entries as FleetInboxReadEntry[]).map((e) => ({ at: e.at, source: e.source, priority: e.priority, text: e.text }));
  return { generatedAt, sourceState, limit, source, dropped, entries: clean.reverse() };
}

/** A 404 is permanent for the life of this build, so the first one is remembered and never asked again. */
let missing = false;

export function inboxReadQuery(limit = INBOX_READ_LIMIT): QueryDef<FleetInboxReadLite | null> {
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(INBOX_READ_LIMIT_MAX, Math.floor(limit))) : INBOX_READ_LIMIT;
  const path = `${FLEET_RUNS_INBOX_PATH}?limit=${n}`;
  return {
    key: `verse-mobile-inbox-read:${n}`,
    fetch: async (signal) => {
      if (missing) return null;
      try {
        const lite = narrowInboxRead(await apiGet<unknown>(path, signal));
        if (lite === null) throw new ApiError(`GET ${path} answered a shape this build cannot read.`, 502, path, 'Unrecognized response — update Phantom.');
        return lite;
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          missing = true;
          return null;
        }
        throw error;
      }
    },
  };
}

/** Test hygiene: the not-in-this-build memo outlives a cache eviction. */
export function resetInboxReadMissingForTest(): void {
  missing = false;
}
