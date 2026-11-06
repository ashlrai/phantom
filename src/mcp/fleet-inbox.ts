/**
 * Durable bus-inbox observation for the isolated fleet MCP server. Reuses the
 * canonical store behind `phm comms bus` — never a second bus — and stays
 * read-only: no TTL renewal, no store creation, no dispatch. Routing labels
 * are data, never authenticated identity; bodies are untrusted.
 */
import {
  BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter,
} from '../core/fleet/bus-inbox.js';
import { validateBusEnvelope } from '../core/fleet/bus-envelope.js';

export const MAX_FLEET_BUS_INBOX_READ = BUS_INBOX_MAX_READ;
export const DEFAULT_FLEET_BUS_INBOX_READ = 50;

export interface FleetBusInboxArgs {
  /** Durable integer cursor; receipts with cursor <= after are skipped. */
  after: number;
  /** Cap on scanned live records, applied before the to/from filters. */
  limit: number;
  /** Exact case-sensitive recipient routing label. */
  to?: string;
  /** Exact case-sensitive sender routing label. */
  from?: string;
}

export interface FleetBusInboxDeps {
  inspect?: typeof inspectBusInbox;
  list?: typeof listBusInboxAfter;
}

const INBOX_KEYS = new Set(['after', 'limit', 'to', 'from']);

/**
 * Routing labels use the bus wire contract: printable ASCII tokens of 1..128
 * characters (the same dummy-envelope check `phm comms bus read` applies). A
 * label that could never appear on the bus is an argument error, not an
 * empty match.
 */
function addressLabel(value: unknown): value is string {
  return typeof value === 'string' && validateBusEnvelope({
    id: value, from: value, to: value, priority: 'P3', ttl: 1, body: null,
  }).ok;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Unknown keys,
 * non-integer cursors, out-of-range limits and malformed labels are rejected
 * before the store is touched.
 */
export function parseFleetBusInboxArgs(args: Record<string, unknown>): FleetBusInboxArgs | null {
  const after = args['after'] ?? 0, limit = args['limit'] ?? DEFAULT_FLEET_BUS_INBOX_READ;
  const to = args['to'], from = args['from'];
  if (Object.keys(args).some(key => !INBOX_KEYS.has(key)) ||
    args['after'] === null || args['limit'] === null ||
    typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0 ||
    typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_FLEET_BUS_INBOX_READ ||
    to !== undefined && !addressLabel(to) || from !== undefined && !addressLabel(from)) return null;
  return { after, limit, to: to as string | undefined, from: from as string | undefined };
}

/**
 * One durable page after `after`, filtered by exact routing labels. The limit
 * counts scanned live records before filtering (the CLI's contract), so an
 * unmatched page still advances nextCursor without replay; expired records
 * advance it unseen and never count. `sourceState` stays honest: missing,
 * unavailable and retryable stores surface as themselves, never as an
 * invented successful empty page. Envelope ttl is the remaining lifetime
 * measured from the original receipt — reading never renews it.
 */
export async function readFleetBusInbox(input: FleetBusInboxArgs, deps: FleetBusInboxDeps = {}) {
  const inspect = deps.inspect ?? inspectBusInbox, list = deps.list ?? listBusInboxAfter;
  const inspection = inspect();
  const base = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
    retainedCount: inspection.retainedCount,
    liveCount: inspection.liveCount,
    expiredCount: inspection.expiredCount,
    after: input.after, limit: input.limit,
    to: input.to ?? null, from: input.from ?? null,
  };
  if (inspection.source !== 'available') {
    return { ...base, sourceState: inspection.source, messages: null, returnedMessages: null, nextCursor: null };
  }
  const page = list(input.after, input.limit);
  if (page.status !== 'ok') {
    return { ...base, sourceState: page.status, messages: null, returnedMessages: null, nextCursor: null };
  }
  const messages = page.messages.filter(({ envelope }) =>
    (input.to === undefined || envelope.to === input.to) &&
    (input.from === undefined || envelope.from === input.from));
  return {
    ...base, sourceState: 'ok' as const, messages,
    returnedMessages: messages.length, nextCursor: page.nextCursor,
  };
}
