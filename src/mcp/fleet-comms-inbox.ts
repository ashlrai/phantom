import { fixedOwnerRunsDir } from '../core/comms/owner-channel.js';
import {
  isUnifiedInboxKind, isUnifiedInboxSeverity, isUnifiedInboxSource, readUnifiedInbox,
  UNIFIED_INBOX_CONTAINS_MAX, UNIFIED_INBOX_MAX_ITEMS,
  type UnifiedInbox, type UnifiedInboxFilter, type UnifiedInboxOptions,
} from '../core/comms/unified-inbox.js';
import { parseSince } from '../core/fleet/agent-messages.js';

export interface FleetCommsInboxArgs {
  limit: number;
  /** Optional view narrowing — the same dimensions `phm comms inbox` filters expose. */
  filter?: UnifiedInboxFilter;
}
export interface FleetCommsInboxDeps {
  runsDir?: string;
  read?: (options: UnifiedInboxOptions) => Promise<UnifiedInbox>;
}

/** The job-id rule every bus read surface shares: a printable label, 1-128 chars. */
const JOB_ID = /^[\x21-\x7e]{1,128}$/;
const INBOX_KEYS = new Set(['limit', 'source', 'kind', 'severity', 'blocking', 'job', 'since', 'before', 'contains']);

export function parseFleetCommsInboxArgs(args: Record<string, unknown>): FleetCommsInboxArgs | null {
  if (Object.keys(args).some(key => !INBOX_KEYS.has(key))) return null;
  const limit = args.limit === undefined && !('limit' in args) ? 50 : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > UNIFIED_INBOX_MAX_ITEMS) return null;

  const filter: UnifiedInboxFilter = {};
  if (args.source !== undefined) {
    if (typeof args.source !== 'string' || !isUnifiedInboxSource(args.source)) return null;
    filter.source = args.source;
  }
  if (args.kind !== undefined) {
    if (typeof args.kind !== 'string' || !isUnifiedInboxKind(args.kind)) return null;
    filter.kind = args.kind;
  }
  if (args.severity !== undefined) {
    if (typeof args.severity !== 'string' || !isUnifiedInboxSeverity(args.severity)) return null;
    filter.severity = args.severity;
  }
  if (args.blocking !== undefined) {
    if (typeof args.blocking !== 'boolean') return null;
    filter.blocking = args.blocking;
  }
  if (args.job !== undefined) {
    if (typeof args.job !== 'string' || !JOB_ID.test(args.job)) return null;
    filter.job = args.job;
  }
  if (args.since !== undefined) {
    if (typeof args.since !== 'string') return null;
    const since = parseSince(args.since);
    if (since === null || !Number.isSafeInteger(since) || since < 0) return null;
    filter.since = since;
  }
  if (args.before !== undefined) {
    if (typeof args.before !== 'string') return null;
    const before = parseSince(args.before);
    if (before === null || !Number.isSafeInteger(before) || before < 0) return null;
    filter.before = before;
  }
  if (args.contains !== undefined) {
    if (typeof args.contains !== 'string' || args.contains.trim() === '' || args.contains.length > UNIFIED_INBOX_CONTAINS_MAX) return null;
    filter.contains = args.contains;
  }
  return { limit, ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

/** Read the same ranked, private inbox as the local HTTP endpoint. */
export async function readFleetCommsInbox(args: FleetCommsInboxArgs, deps: FleetCommsInboxDeps = {}) {
  const schema = 'comms.unified-inbox.v1' as const;
  try {
    const inbox = await (deps.read ?? readUnifiedInbox)({
      runsDir: deps.runsDir ?? fixedOwnerRunsDir(),
      ...(args.filter === undefined ? {} : { filter: args.filter }),
    });
    const items = inbox.items.slice(0, args.limit);
    return { schema, generatedAt: inbox.generatedAt, sources: inbox.sources, total: inbox.total,
      omitted: Math.max(0, inbox.total - items.length), items,
      ...(inbox.filter === undefined ? {} : { filter: inbox.filter }) };
  } catch {
    return { schema, unavailable: true as const, items: [] };
  }
}
