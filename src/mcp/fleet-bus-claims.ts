/**
 * `fleet_bus_claims` MCP adapter: the live coordination-claims read —
 * `listBusClaims`, the same read `phm agents bus claim list` serves. Every
 * other bus tool reports claims only inside its own slice —
 * `fleet_agent_work`'s digest carries the claims one agent holds,
 * `fleet_work_feed`'s `claims` join annotates the jobs one feed page
 * lists, and `fleet_coordination_claims` reads the separate host advisory
 * ledger — none answers "who holds this claim key" or "what is live across
 * every origin" fleet-wide. This tool is the claim table's own read: the
 * live `resource`/`message`/`team`/`board` leases the one coordination
 * store keeps, narrowed by the same `key` overlap preview, `owner`
 * identity-label match and `excludeOwner` sender-exclusion, `contains`
 * row-text search, `origin` class filter, `since`/`before` start-time
 * window and `jobs` feed join the
 * CLI flags apply, with `source` keeping a missing table verified-empty
 * and an unreadable one `unavailable` — never an invented empty list.
 *
 * `key` validates through the same `parseClaimKey` grammar claim acquire
 * enforces, `owner` takes the claim store's own printable-label bound
 * (wider than the 128-char bus address cap because claim owners are
 * coordination labels, not routing addresses), `origin` is the
 * COORDINATION_ORIGINS enum and `jobs` a JSON boolean — every value is
 * checked before the store is touched, so an MCP client can never
 * disagree with the CLI about what a filter means. Read-only: no caller
 * root, path or cwd is accepted — the coordination and feed roots stay
 * server-owned — and the tool never acquires, renews, releases or
 * completes a claim. Routing labels are data, never authenticated
 * identity; claims coordinate scope and grant no execution, claim, merge,
 * push, spend or dispatch authority, and fencing tokens never leave the
 * store.
 */
import { COORDINATION_ORIGINS, type CoordinationOrigin } from '../core/agents/claim-store.js';
import {
  listBusClaims,
  type BusClaimsListOptions, type BusClaimsListResult,
} from '../core/agents/bus-claims.js';
import { parseClaimKey } from '../core/agents/bus-v2-schema.js';
import { BUS_READ_CONTAINS_MAX } from '../core/agents/bus-unified.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** The claim store's own owner-label bound — printable ASCII, 1–256 chars. */
const CLAIM_OWNER = /^[\x21-\x7e]{1,256}$/;

const CLAIMS_KEYS = new Set(['key', 'owner', 'excludeOwner', 'contains', 'origin', 'since', 'before', 'jobs']);

export interface FleetBusClaimsArgs {
  /** Keep only live claims that would block an acquire of this v2 claim key — the same overlap rule `claim list --key` applies. */
  key?: string;
  /** Keep only live claims owned by this routing ref — a handle, `agent:<handle>`, stable id or alias resolved through the server-side registry, exact-label fallback when unresolvable. */
  owner?: string;
  /** Drop live claims owned by this routing ref — the same identity-label resolution `owner` applies, inverted; composes with `owner`. */
  excludeOwner?: string;
  /** Keep only live claims whose key, sourceId or repo/branch/path target fields carry this text — the same case-insensitive substring rule every bus read's `--contains` applies. */
  contains?: string;
  /** Keep only live claims of this origin class — resource, message, team or board. */
  origin?: CoordinationOrigin;
  /** Keep only live claims whose recorded `started` is at or after this cutoff — 15m, 2h, 1d, epoch ms or an ISO time, the same grammar `claim list --since` takes; claims keeping no start stamp never match. */
  since?: number;
  /** Keep only live claims whose recorded `started` is strictly before this cutoff on the same grammar — the exclusive upper bound composing with `since` into one [since, before) window, the same rule `claim list --before` applies. */
  before?: number;
  /** Also join each claim with the announced feed jobs its keys block and report the feed read state. */
  jobs?: boolean;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `key`
 * takes the same `parseClaimKey` grammar `work.claim` bodies and
 * `claim list --key` enforce, `owner` and `excludeOwner` the claim
 * store's printable-label bound, `contains` the shared bus `--contains`
 * bound (non-empty, at most `BUS_READ_CONTAINS_MAX`), `origin` the
 * COORDINATION_ORIGINS enum, `since`/`before` the shared bus time grammar
 * resolved through `parseSince` — `since` inclusive and `before` exclusive
 * on the claim's recorded `started`, one [since, before) window — and
 * `jobs` a JSON boolean.
 * Unknown keys, wrong types, caller roots and malformed values are all
 * refused before the store is touched.
 */
export function parseFleetBusClaimsArgs(args: Record<string, unknown>): FleetBusClaimsArgs | null {
  if (Object.keys(args).some(key => !CLAIMS_KEYS.has(key))) return null;
  const parsed: FleetBusClaimsArgs = {};
  const key = args.key;
  if (key !== undefined) {
    if (typeof key !== 'string' || parseClaimKey(key) === undefined) return null;
    parsed.key = key;
  }
  const owner = args.owner;
  if (owner !== undefined) {
    if (typeof owner !== 'string' || !CLAIM_OWNER.test(owner)) return null;
    parsed.owner = owner;
  }
  const excludeOwner = args.excludeOwner;
  if (excludeOwner !== undefined) {
    if (typeof excludeOwner !== 'string' || !CLAIM_OWNER.test(excludeOwner)) return null;
    parsed.excludeOwner = excludeOwner;
  }
  const contains = args.contains;
  if (contains !== undefined) {
    if (typeof contains !== 'string' || contains.trim() === '' || contains.length > BUS_READ_CONTAINS_MAX) return null;
    parsed.contains = contains;
  }
  const origin = args.origin;
  if (origin !== undefined) {
    if (typeof origin !== 'string' || !(COORDINATION_ORIGINS as readonly string[]).includes(origin)) return null;
    parsed.origin = origin as CoordinationOrigin;
  }
  const since = args.since;
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null) return null;
    parsed.since = resolved;
  }
  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null) return null;
    parsed.before = resolved;
  }
  const jobs = args.jobs;
  if (jobs !== undefined) {
    if (typeof jobs !== 'boolean') return null;
    parsed.jobs = jobs;
  }
  return parsed;
}

export interface FleetBusClaimsDeps {
  list?: (options: BusClaimsListOptions) => BusClaimsListResult;
}

interface FleetBusClaimsMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared list union with the MCP envelope metadata on every member. */
export type FleetBusClaimsResult = FleetBusClaimsMeta & BusClaimsListResult;

/**
 * One claims listing through the shared `listBusClaims` read — the
 * identical read `phm agents bus claim list` runs, so live-row filtering,
 * owner identity matching, origin classes, the `started` time window,
 * the `jobs` feed join and the
 * `missing`/`available`/`unavailable` source honesty can never diverge
 * between the CLI and this tool. Non-ok results pass through untouched:
 * `invalid` and `unavailable` keep their own status and `asOf`, never an
 * invented empty claim list, and `ok` keeps `claims`, the resolved `owner`
 * match and the `feed` read state exactly as the projection reports them.
 */
export async function readFleetBusClaims(
  args: FleetBusClaimsArgs,
  deps: FleetBusClaimsDeps = {},
): Promise<FleetBusClaimsResult> {
  const list = deps.list ?? listBusClaims;
  const result = list({
    ...(args.key === undefined ? {} : { key: args.key }),
    ...(args.owner === undefined ? {} : { owner: args.owner }),
    ...(args.excludeOwner === undefined ? {} : { excludeOwner: args.excludeOwner }),
    ...(args.contains === undefined ? {} : { contains: args.contains }),
    ...(args.origin === undefined ? {} : { origin: args.origin }),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.before === undefined ? {} : { before: args.before }),
    ...(args.jobs === undefined ? {} : { jobs: args.jobs }),
  });
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...result,
  };
}
