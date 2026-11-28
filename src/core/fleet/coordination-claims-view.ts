/**
 * Public, read-only claim projection. Advisory ownership grants no authority.
 * The filters narrow the live-claim set before the newest-50 slice — the same
 * rule `projectCoordinationReturns`/`projectCoordinationInbox` apply — so a
 * filtered read reaches claims the unfiltered cap hides, and `matched`/
 * `omitted` keep that bounded page honest: matched counts every live claim
 * the filters kept, omitted is the filtered total minus the returned rows.
 * The ledger's agent labels are coordination names, not bus routing labels,
 * so `agent` matches the recorded label exactly and never resolves through
 * the agent registry — the same rule the sibling inbox/returns sender
 * filters apply. `expiredClaims` still reports the board's expired total:
 * the filters narrow live claims only.
 */
import { parseSince } from './agent-messages.js';
import type { FleetBoard, FleetClaim } from './coordination.js';

function iso(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown';
}

/** Printable routing label — the same bound the ledger's own id/agent fields carry. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The owner/name repo shape `claimFleetWork` accepts; repo names compare case-insensitively. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CONTAINS_MAX = 512;

/** Resolved claims filters: every field narrows the live-claim set, none fabricates rows. */
export interface CoordinationClaimsFilters {
  /** Exact claim id. */
  id?: string;
  /** Exact agent label — a coordination name, never resolved through the bus registry. */
  agent?: string;
  /** Lowercase `owner/name` repo key — repo names compare case-insensitively. */
  repo?: string;
  /** Inclusive lower bound on the claim's `claimedAt` stamp, epoch ms. */
  since?: number;
  /** Exclusive upper bound on the claim's `claimedAt` stamp, epoch ms. */
  before?: number;
  /** Normalized case-insensitive needle matched against the claim's id, repo, task and agent. */
  contains?: string;
}

/** The stringly flags the CLI and MCP args hand the parser — the same names `CoordinationClaimsFilters` resolves to. */
export interface CoordinationClaimsFilterInput {
  id?: string;
  agent?: string;
  repo?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
}

export type CoordinationClaimsQuery = { ok: true; filters: CoordinationClaimsFilters } | { ok: false };

function claimsContainsNeedle(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > CONTAINS_MAX) return null;
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Shared validation for the claims flags; `now` anchors the relative grammar
 * once per read — the same rules `parseCoordinationReturnsFilters` applies
 * to the sibling returns read, minus the receipt-only verdict key. `--since`/
 * `--before` compose one [since, before) window on each claim's `claimedAt`
 * stamp — a claim stamped exactly at `before` never matches, the same
 * exclusive upper bound every bus read applies.
 */
export function parseCoordinationClaimsFilters(input: CoordinationClaimsFilterInput, now = Date.now()): CoordinationClaimsQuery {
  const filters: CoordinationClaimsFilters = {};
  if (input.id !== undefined) {
    if (!IDENT.test(input.id)) return { ok: false };
    filters.id = input.id;
  }
  if (input.agent !== undefined) {
    if (!IDENT.test(input.agent)) return { ok: false };
    filters.agent = input.agent;
  }
  if (input.repo !== undefined) {
    if (!REPO.test(input.repo)) return { ok: false };
    filters.repo = input.repo.toLowerCase();
  }
  if (input.since !== undefined) {
    const since = parseSince(input.since, now);
    if (since === null) return { ok: false };
    filters.since = since;
  }
  if (input.before !== undefined) {
    const before = parseSince(input.before, now);
    if (before === null) return { ok: false };
    filters.before = before;
  }
  const needle = claimsContainsNeedle(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters };
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/**
 * One live claim against the resolved filters — exact structured matches on
 * id/agent/repo, the [since, before) window on `claimedAt`, and the needle as
 * a case-insensitive substring over the claim's id, repo, task and agent (the
 * same fields the row displays).
 */
function claimsRowMatch(claim: FleetClaim, filters: CoordinationClaimsFilters): boolean {
  if (filters.id !== undefined && claim.id !== filters.id) return false;
  if (filters.agent !== undefined && claim.agent !== filters.agent) return false;
  if (filters.repo !== undefined && claim.repo.toLowerCase() !== filters.repo) return false;
  if (filters.since !== undefined && claim.claimedAt < filters.since) return false;
  if (filters.before !== undefined && claim.claimedAt >= filters.before) return false;
  if (filters.contains !== undefined &&
      !fold(`${claim.id} ${claim.repo} ${claim.task} ${claim.agent}`).includes(filters.contains)) return false;
  return true;
}

/** Explicitly select fields so messages, proposals and lease material stay local. */
export function projectCoordinationClaims(board: FleetBoard | null, nowMs: number,
  filters?: CoordinationClaimsFilters) {
  const base = { v: 1 as const, source: 'coordination-ledger' as const, asOf: iso(nowMs) };
  if (board === null) {
    return { ...base, state: 'unknown' as const, claims: [], expiredClaims: null,
      matched: null, omitted: null,
      reason: 'coordination ledger: reader failed' };
  }
  const observationKnown = base.asOf !== 'unknown';
  const live = board.state === 'known' ? board.claims : [];
  const matchedClaims = filters === undefined ? live : live.filter(claim => claimsRowMatch(claim, filters));
  const claims = [...matchedClaims]
    .sort((a, b) => b.claimedAt - a.claimedAt)
    .slice(0, 50)
    .map(c => ({
      id: c.id, repo: c.repo, task: String(c.task).slice(0, 200), agent: c.agent,
      claimedAt: iso(c.claimedAt), expiresAt: iso(c.expiresAt),
      expiresInSeconds: observationKnown && iso(c.expiresAt) !== 'unknown'
        ? Math.round((c.expiresAt - nowMs) / 1000) : null,
    }));
  return { ...base, state: board.state, claims, expiredClaims: board.expiredClaims,
    matched: board.state === 'known' ? matchedClaims.length : null,
    omitted: board.state === 'known' ? Math.max(0, matchedClaims.length - claims.length) : null };
}
