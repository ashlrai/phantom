/**
 * Query-param validation for `GET /api/verse/agent-bus/work-feed` — the same
 * filter rules the two feed CLIs (`phm fleet work-feed`, `phm agents bus work
 * feed`) apply to argv, shared so the HTTP read and the CLI reads can never
 * disagree on what a value means. Read-only: builds the `projectBusWorkFeedView`
 * filter set plus the claims-join flag; it reads no store itself beyond the
 * identity registry the `to`/`owner` matchers resolve through, and an
 * unresolvable ref or unreadable registry keeps exact-label matching exactly
 * like the CLI flags. Every malformed value is a usage error, never a silent
 * empty view.
 */
import { parseSince } from '../fleet/agent-messages.js';
import { agentChannelNameSchema } from './bus-identity.js';
import {
  busWorkFeedOwnerMatcher, busWorkFeedPendingToMatcher, busWorkFeedRepoKey,
  BUS_WORK_FEED_CONTAINS_MAX, BUS_WORK_FEED_LIMIT_MAX, type BusWorkFeedViewFilters,
} from './bus-work-feed-read.js';
import {
  PROVIDERS, providerSchema, WORK_STATUSES, WORK_TIERS,
  type WorkDispatch, type WorkJob,
} from './bus-v2-schema.js';

/** Raw query values as `URLSearchParams.get` returns them; absent keys are undefined. */
export interface BusWorkFeedQueryInput {
  claims?: string;
  status?: string;
  job?: string;
  repo?: string;
  provider?: string;
  tier?: string;
  to?: string;
  owner?: string;
  since?: string;
  contains?: string;
  channel?: string;
  open?: string;
  claimable?: string;
  /** Newest-first page bound applied after the filters; absent means the whole filtered view. */
  limit?: string;
}

export type BusWorkFeedQuery =
  | { ok: true; claims: boolean; filters: BusWorkFeedViewFilters; limit?: number }
  | { ok: false; error: string };

/** Printable ASCII routing labels, the same constraint the feed CLIs' --to/--owner/--job enforce. */
const LABEL = /^[\x21-\x7e]{1,128}(?![\s\S])/;

const invalid = (error: string): BusWorkFeedQuery => ({ ok: false, error });

/**
 * Validate one work-feed query into the claims-join flag and the view filter
 * set. `claims`, `open` and `claimable` accept only the literal `true` — the
 * same strictness the endpoint's `claims` parameter always had — and `open`
 * or `claimable` imply the claims join exactly like the CLI flags. `repo`
 * normalizes through `busWorkFeedRepoKey` (the lowercase `owner/name` claim-key
 * rule), `since` parses through the shared `parseSince` grammar (15m, 2h, 1d,
 * epoch ms or an ISO time), and `contains` takes a non-empty needle of at most
 * `BUS_WORK_FEED_CONTAINS_MAX` characters, and `channel` takes the strict
 * bus channel-name grammar — a raw `group:<channel>:` prefix match on the
 * announcement address, never a registry-dependent guess. `limit` is the
 * page bound `sliceBusWorkFeedView` applies after the filters — an integer
 * in 1..BUS_WORK_FEED_LIMIT_MAX, absent meaning the whole filtered view.
 */
export function parseBusWorkFeedQuery(
  input: BusWorkFeedQueryInput,
  options: { root?: string; now?: number } = {},
): BusWorkFeedQuery {
  const flag = (value: string | undefined): boolean | undefined | 'invalid' =>
    value === undefined ? undefined : value === 'true' ? true : 'invalid';
  const claims = flag(input.claims), open = flag(input.open), claimable = flag(input.claimable);
  if (claims === 'invalid' || open === 'invalid' || claimable === 'invalid') {
    return invalid('claims, open and claimable take only the value true.');
  }
  const filters: BusWorkFeedViewFilters = {};
  if (input.status !== undefined) {
    if (!(WORK_STATUSES as readonly string[]).includes(input.status)) {
      return invalid(`status takes one of ${WORK_STATUSES.join(', ')}.`);
    }
    filters.status = input.status as WorkJob['status'];
  }
  for (const key of ['job', 'to', 'owner'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!LABEL.test(value)) return invalid(`${key} takes a printable routing label of 1-128 characters.`);
    if (key === 'job') filters.jobId = value;
    else if (key === 'to') filters.toMatch = busWorkFeedPendingToMatcher(value, { root: options.root });
    else filters.ownerMatch = busWorkFeedOwnerMatcher(value, { root: options.root });
  }
  if (input.repo !== undefined) {
    const repo = busWorkFeedRepoKey(input.repo);
    if (repo === undefined) return invalid('repo takes an owner/name repo slug.');
    filters.repo = repo;
  }
  if (input.provider !== undefined) {
    if (!providerSchema.safeParse(input.provider).success) {
      return invalid(`provider takes one of ${PROVIDERS.join(', ')}.`);
    }
    filters.provider = input.provider as WorkJob['provider'];
  }
  if (input.tier !== undefined) {
    if (!(WORK_TIERS as readonly string[]).includes(input.tier)) {
      return invalid(`tier takes one of ${WORK_TIERS.join(', ')}.`);
    }
    filters.tier = input.tier as WorkDispatch['tier'];
  }
  if (input.since !== undefined) {
    const since = parseSince(input.since, options.now ?? Date.now());
    if (since === null) return invalid('since takes 15m, 2h, 1d, epoch ms or an ISO time.');
    filters.since = since;
  }
  if (input.contains !== undefined) {
    if (input.contains.trim() === '' || input.contains.length > BUS_WORK_FEED_CONTAINS_MAX) {
      return invalid(`contains takes a non-empty search text of at most ${BUS_WORK_FEED_CONTAINS_MAX} characters.`);
    }
    filters.contains = input.contains;
  }
  if (input.channel !== undefined) {
    // The same strict channel-name grammar `agents bus channel create`,
    // `agents bus inbox --channel`, `channel read` and `phm messages
    // --channel` enforce — a value that cannot name a room is a usage error,
    // never a guessed match.
    if (!agentChannelNameSchema.safeParse(input.channel).success) {
      return invalid('channel takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).');
    }
    filters.channel = input.channel;
  }
  if (open === true) filters.open = true;
  if (claimable === true) filters.claimable = true;
  let limit: number | undefined;
  if (input.limit !== undefined) {
    if (!/^[0-9]+$/.test(input.limit)) return invalid(`limit takes an integer from 1 to ${BUS_WORK_FEED_LIMIT_MAX}.`);
    const parsedLimit = Number(input.limit);
    if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > BUS_WORK_FEED_LIMIT_MAX) {
      return invalid(`limit takes an integer from 1 to ${BUS_WORK_FEED_LIMIT_MAX}.`);
    }
    limit = parsedLimit;
  }
  return { ok: true, claims: claims === true || open === true || claimable === true, filters,
    ...(limit === undefined ? {} : { limit }) };
}
