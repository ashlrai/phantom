/**
 * `fleet_work_feed` MCP adapter: the bus v2 work-feed projection —
 * `readBusWorkFeed` + `projectBusWorkFeedView`, the same read
 * `phm fleet work-feed`, `phm agents bus work feed` and GET
 * `/api/verse/agent-bus/work-feed` serve. Every filter validates through the
 * shared `parseBusWorkFeedQuery` contract, so an MCP client can never
 * disagree with the CLI or HTTP reads about what a value means; `to`/`owner`
 * resolve through the server-owned identity registry with the same
 * exact-label fallback. Read-only: no caller root, path or cwd is accepted —
 * the store and registry roots stay server-owned — and the tool never
 * claims, dispatches, executes or writes. Claims coordinate scope only and
 * grant no authority; unknown feed or hold state stays unknown, never an
 * empty list passed off as fact.
 */
import {
  BUS_WORK_FEED_LIMIT_MAX, projectBusWorkFeedView, readBusWorkFeed, sliceBusWorkFeedView,
  type BusWorkFeedPaged, type BusWorkFeedReadOptions, type BusWorkFeedReadResult, type BusWorkFeedViewFilters,
} from '../core/agents/bus-work-feed-read.js';
import { parseBusWorkFeedQuery, type BusWorkFeedQueryInput } from '../core/agents/bus-work-feed-query.js';

/** Largest `limit` the tool accepts — the shared feed page bound the CLI and HTTP reads use too. */
export const FLEET_WORK_FEED_LIMIT_MAX = BUS_WORK_FEED_LIMIT_MAX;
export const FLEET_WORK_FEED_LIMIT_DEFAULT = 50;

const FEED_KEYS = new Set([
  'claims', 'open', 'claimable',
  'status', 'job', 'repo', 'provider', 'tier', 'to', 'owner', 'since', 'before', 'contains', 'channel', 'limit',
]);
const FLAG_KEYS = ['claims', 'open', 'claimable'] as const;
const STRING_KEYS = ['status', 'job', 'repo', 'provider', 'tier', 'to', 'owner', 'since', 'before', 'contains', 'channel'] as const;

export interface FleetWorkFeedArgs {
  /** Newest-first job cap applied after filtering; `matched` keeps the true total. */
  limit: number;
  /** Whether the coordination-hold join ran — `claims`, `open` or `claimable` requested it. */
  claims: boolean;
  filters: BusWorkFeedViewFilters;
}

/**
 * Validate MCP arguments into the shared feed query. The three hold flags
 * take JSON booleans — `true` maps to the literal `true` the shared parser
 * accepts, `false` is the same as absent — and every other key takes a
 * string the shared `parseBusWorkFeedQuery` rules then check (status,
 * provider and tier enums, the owner/name repo slug, printable routing
 * labels, the shared `since`/`before` grammar — `since` inclusive and
 * `before` exclusive on the job's `updatedAt`, one [since, before) window —
 * and the `contains` bound). Unknown
 * keys, wrong types and malformed values are all refused before any store
 * read, exactly like an invalid HTTP query.
 */
export function parseFleetWorkFeedArgs(args: Record<string, unknown>): FleetWorkFeedArgs | null {
  if (Object.keys(args).some(key => !FEED_KEYS.has(key))) return null;
  const limit = args.limit === undefined && !('limit' in args) ? FLEET_WORK_FEED_LIMIT_DEFAULT : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FLEET_WORK_FEED_LIMIT_MAX) return null;
  const input: BusWorkFeedQueryInput = {};
  for (const key of FLAG_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'boolean') return null;
    if (value) input[key] = 'true';
  }
  for (const key of STRING_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    input[key] = value;
  }
  const parsed = parseBusWorkFeedQuery(input);
  if (!parsed.ok) return null;
  return { limit, claims: parsed.claims, filters: parsed.filters };
}

export interface FleetWorkFeedDeps {
  read?: (options: BusWorkFeedReadOptions) => BusWorkFeedReadResult;
}

/**
 * The filtered feed view sliced to `limit` newest jobs through the shared
 * `sliceBusWorkFeedView`: `matched` counts the jobs the filters kept before
 * the slice and `omitted` the rest — the same honest-truncation pair the
 * other bounded fleet reads report — and the claims join's holds regroup
 * under the shown jobs exactly like `projectBusWorkFeedView` does for its
 * own filter slice, so a hold never names a hidden job. Non-ok results
 * pass through untouched: a refused or unavailable feed fabricates no job
 * list and no counts.
 */
export async function readFleetWorkFeed(
  args: FleetWorkFeedArgs,
  deps: FleetWorkFeedDeps = {},
): Promise<BusWorkFeedReadResult | BusWorkFeedPaged> {
  return sliceBusWorkFeedView(
    projectBusWorkFeedView((deps.read ?? readBusWorkFeed)({ claims: args.claims }), args.filters),
    args.limit);
}
