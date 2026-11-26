/**
 * Query-param validation for `GET /api/verse/comms/inbox` — the same filter
 * rules `phm comms inbox` applies to argv and `fleet_comms_inbox` to MCP
 * args, shared so the HTTP read and the CLI/MCP reads can never disagree on
 * what a value means. Read-only: builds the `limit` slice and the
 * `UnifiedInboxFilter` view `readUnifiedInbox` already applies; it reads no
 * store itself. Every malformed value is a usage error, never a silent
 * empty view.
 */
import {
  isUnifiedInboxKind, isUnifiedInboxPriority, isUnifiedInboxSeverity, isUnifiedInboxSource,
  UNIFIED_INBOX_CONTAINS_MAX, UNIFIED_INBOX_SOURCES, UNIFIED_INBOX_KINDS,
  type UnifiedInboxFilter,
} from './unified-inbox.js';
import { parseSince } from '../fleet/agent-messages.js';

/** Largest `limit` the endpoint accepts; the same bound `fleet_comms_inbox` applies to its `limit` arg. */
export const UNIFIED_INBOX_QUERY_LIMIT_MAX = 200;
export const UNIFIED_INBOX_QUERY_LIMIT_DEFAULT = 50;

/** The query keys the read accepts — the CLI/MCP filter dimensions plus `limit`. */
export const UNIFIED_INBOX_QUERY_PARAMS = [
  'limit', 'source', 'kind', 'severity', 'priority', 'blocking', 'job', 'since', 'before', 'contains',
] as const;

export interface UnifiedInboxQuery {
  limit: number;
  /** Present only when at least one view dimension was supplied. */
  filter?: UnifiedInboxFilter;
}

export type UnifiedInboxQueryResult =
  | { ok: true; query: UnifiedInboxQuery }
  | { ok: false; error: string };

/** The `--job` value rule every bus read surface shares: a printable label, 1-128 chars. */
const JOB_ID = /^[\x21-\x7e]{1,128}$/;

const invalid = (error: string): UnifiedInboxQueryResult => ({ ok: false, error });

/**
 * Validate one comms-inbox query into the item slice and the view filter
 * set. `source`, `kind`, `severity` and `priority` take exactly the stored
 * vocabularies (`UNIFIED_INBOX_SOURCES`, `UNIFIED_INBOX_KINDS`,
 * `info|warn|high`, `now|today|this-week|whenever` — the item's computed
 * urgency `UnifiedInboxItem.priority` carries),
 * `blocking` takes the literals `true` or `false` — the two states
 * `UnifiedInboxFilter.blocking` distinguishes — `job` the shared printable
 * label rule, `since` and `before` the shared `parseSince` grammar (15m, 2h,
 * 1d, epoch ms or an ISO time, resolved against `options.now`) — `since`
 * the inclusive lower bound, `before` the exclusive upper bound composing
 * into one `[since, before)` window — and `contains` a
 * non-empty needle of at most `UNIFIED_INBOX_CONTAINS_MAX` characters.
 * Repeated keys are the caller's concern: this parser sees `URLSearchParams`
 * values one key at a time and takes the first, so callers enforcing
 * once-each semantics check `getAll` themselves — the same split
 * `parseBusWorkFeedQuery` keeps.
 */
export function parseUnifiedInboxQuery(
  params: URLSearchParams,
  options: { now?: number } = {},
): UnifiedInboxQueryResult {
  const rawLimit = params.get('limit');
  let limit = UNIFIED_INBOX_QUERY_LIMIT_DEFAULT;
  if (rawLimit !== null) {
    if (!/^[0-9]+$/.test(rawLimit)) return invalid(`limit takes an integer from 1 to ${UNIFIED_INBOX_QUERY_LIMIT_MAX}.`);
    const value = Number(rawLimit);
    if (!Number.isSafeInteger(value) || value < 1 || value > UNIFIED_INBOX_QUERY_LIMIT_MAX) {
      return invalid(`limit takes an integer from 1 to ${UNIFIED_INBOX_QUERY_LIMIT_MAX}.`);
    }
    limit = value;
  }

  const filter: UnifiedInboxFilter = {};
  const source = params.get('source');
  if (source !== null) {
    if (!isUnifiedInboxSource(source)) {
      return invalid(`source takes one of ${UNIFIED_INBOX_SOURCES.join(', ')}.`);
    }
    filter.source = source;
  }
  const kind = params.get('kind');
  if (kind !== null) {
    if (!isUnifiedInboxKind(kind)) {
      return invalid(`kind takes one of ${UNIFIED_INBOX_KINDS.join(', ')}.`);
    }
    filter.kind = kind;
  }
  const severity = params.get('severity');
  if (severity !== null) {
    if (!isUnifiedInboxSeverity(severity)) {
      return invalid('severity takes info, warn or high.');
    }
    filter.severity = severity;
  }
  const priority = params.get('priority');
  if (priority !== null) {
    if (!isUnifiedInboxPriority(priority)) {
      return invalid('priority takes now, today, this-week or whenever.');
    }
    filter.priority = priority;
  }
  const blocking = params.get('blocking');
  if (blocking !== null) {
    if (blocking !== 'true' && blocking !== 'false') {
      return invalid('blocking takes true or false.');
    }
    filter.blocking = blocking === 'true';
  }
  const job = params.get('job');
  if (job !== null) {
    if (!JOB_ID.test(job)) return invalid('job takes a job id (printable label, 1-128 chars).');
    filter.job = job;
  }
  const since = params.get('since');
  if (since !== null) {
    const resolved = parseSince(since, options.now ?? Date.now());
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) {
      return invalid('since takes 15m, 2h, 1d, epoch ms or an ISO time.');
    }
    filter.since = resolved;
  }
  const before = params.get('before');
  if (before !== null) {
    const resolved = parseSince(before, options.now ?? Date.now());
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) {
      return invalid('before takes 15m, 2h, 1d, epoch ms or an ISO time.');
    }
    filter.before = resolved;
  }
  const contains = params.get('contains');
  if (contains !== null) {
    if (contains.trim() === '' || contains.length > UNIFIED_INBOX_CONTAINS_MAX) {
      return invalid(`contains takes a non-empty search text of at most ${UNIFIED_INBOX_CONTAINS_MAX} characters.`);
    }
    filter.contains = contains;
  }
  return { ok: true, query: { limit, ...(Object.keys(filter).length === 0 ? {} : { filter }) } };
}
