/**
 * `fleet_bus_dead_letters` MCP adapter: the transport dead-letter sink's
 * retained delivery-failure reports — `readBusDeadLetters`, the same read
 * `phm agents bus dead-letters` serves. `fleet_bus_status` reports only the
 * pending count by recorded reason and `fleet_comms_inbox` itemizes letters
 * as `bus-dead-letter` items inside its capped mixed page; this tool answers
 * "which sends provably never landed, fleet-wide, and why" with the report's
 * own filter set — the classified `reason`, the ORIGINAL envelope's
 * sender/recipient labels, channel/topic, kind, priority and receipt window —
 * none of which the raw `fleet_bus_inbox` page or the status probe computes,
 * and `fleet_agent_work`'s deadLetters section narrows to one agent's
 * addressed mail only.
 *
 * Every filter validates before any store read and maps onto the same
 * `BusDeadLettersOptions` fields the CLI flags fill, so an MCP client can
 * never disagree with the CLI about what a value means; `from`, `excludeFrom`
 * and `to` resolve through the server-owned identity registry under the same
 * fleet root the read derives, `channel`/`topic` take the channel-name
 * grammar and match on the ORIGINAL recipient's `group:<room>:<topic>`
 * address — never the letter's own `bus.dead-letter` sink address.
 * Read-only: no caller root, path or cwd is accepted — the bus store and
 * registry roots stay server-owned — and the tool never claims, acks,
 * replies, posts, retries or sends. Routing labels are data, never
 * authenticated identity; a missing store is a verified-empty sink while an
 * unreadable or mid-scan store stays `unavailable`/`retryable` — never an
 * invented empty list — and `matched` is always the true filtered total.
 */
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { busReadContains } from '../core/agents/bus-unified.js';
import { BUS_DEAD_LETTER_REASONS, type BusDeadLetterReason } from '../core/agents/bus-dead-letter.js';
import {
  BUS_DEAD_LETTERS_LIMIT_MAX, readBusDeadLetters,
  type BusDeadLettersOptions, type BusDeadLettersResult,
} from '../core/agents/bus-dead-letters.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** Largest `limit` the tool accepts — the same bound `phm agents bus dead-letters --limit` keeps. */
export const FLEET_BUS_DEAD_LETTERS_LIMIT_MAX = BUS_DEAD_LETTERS_LIMIT_MAX;
export const FLEET_BUS_DEAD_LETTERS_LIMIT_DEFAULT = 50;

/** The printable-label rule `id`, `from`, `excludeFrom`, `to` and `bodyKind` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const DEAD_LETTER_KEYS = new Set([
  'limit', 'since', 'before', 'contains', 'priority', 'id', 'reason',
  'from', 'excludeFrom', 'to', 'channel', 'topic', 'bodyKind',
]);
const LABEL_KEYS = ['id', 'from', 'excludeFrom', 'to', 'bodyKind'] as const;

/** The `readBusDeadLetters` option fields the MCP arguments fill. */
export interface FleetBusDeadLettersFilters {
  since?: number;
  before?: number;
  contains?: string;
  priority?: BusPriority;
  id?: string;
  reason?: BusDeadLetterReason;
  from?: string;
  excludeFrom?: string;
  to?: string;
  channel?: string;
  topic?: string;
  bodyKind?: string;
}

export interface FleetBusDeadLettersArgs {
  /** Cap on returned letters after filtering; `matched` still reports the true total. */
  limit: number;
  filters: FleetBusDeadLettersFilters;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every key is
 * optional — the fleet-wide read has no required narrowing — and each takes
 * the same value rules `phm agents bus dead-letters` flags and the other bus
 * reads share: printable routing labels, the P0–P3 priority enum, the closed
 * dead-letter reason set, the channel-name grammar for `channel`/`topic`,
 * the shared `since`/`before` grammar and the bounded `contains` needle
 * normalized by `busReadContains`. Unknown keys, caller roots, paths,
 * working directories and malformed values are all refused before the store
 * is touched.
 */
export function parseFleetBusDeadLettersArgs(args: Record<string, unknown>): FleetBusDeadLettersArgs | null {
  if (Object.keys(args).some(key => !DEAD_LETTER_KEYS.has(key))) return null;
  const limit = args.limit === undefined && !('limit' in args) ? FLEET_BUS_DEAD_LETTERS_LIMIT_DEFAULT : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FLEET_BUS_DEAD_LETTERS_LIMIT_MAX) {
    return null;
  }

  const filters: FleetBusDeadLettersFilters = {};
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    filters[key] = value;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    filters.priority = priority as BusPriority;
  }
  const reason = args.reason;
  if (reason !== undefined) {
    if (typeof reason !== 'string' || !(BUS_DEAD_LETTER_REASONS as readonly string[]).includes(reason)) return null;
    filters.reason = reason as BusDeadLetterReason;
  }
  for (const key of ['channel', 'topic'] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !agentChannelNameSchema.safeParse(value).success) return null;
    filters[key] = value;
  }
  const since = args.since;
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters.since = resolved;
  }
  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    filters.before = resolved;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) filters.contains = contains;

  return { limit, filters };
}

export interface FleetBusDeadLettersDeps {
  read?: typeof readBusDeadLetters;
}

interface FleetBusDeadLettersMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared read union with the MCP envelope metadata on every member. */
export type FleetBusDeadLettersResult =
  | (FleetBusDeadLettersMeta & Extract<BusDeadLettersResult, { status: 'ok' }>)
  | (FleetBusDeadLettersMeta & Exclude<BusDeadLettersResult, { status: 'ok' }>);

/**
 * One dead-letter page through the shared `readBusDeadLetters` read — the
 * identical projection `phm agents bus dead-letters` runs, so report
 * parsing, classified reasons, original-recipient matching, claim order and
 * the matched/truncated honesty fields can never diverge between the CLI and
 * this tool. Non-ok results pass through untouched with their own status
 * and reason: `invalid`, `unavailable` and `retryable` each stay themselves,
 * never an invented empty list, and `ok` keeps `source` (missing is a
 * verified-empty sink, available is real), `matched` the true filtered
 * total, `truncated` the capped-page flag and `asOf` the read's own clock
 * beside the envelope's `generatedAt`.
 */
export async function readFleetBusDeadLetters(
  args: FleetBusDeadLettersArgs,
  deps: FleetBusDeadLettersDeps = {},
): Promise<FleetBusDeadLettersResult> {
  const read = deps.read ?? readBusDeadLetters;
  const options: BusDeadLettersOptions = { ...args.filters, limit: args.limit };
  const result = read(options);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...result,
  };
}
