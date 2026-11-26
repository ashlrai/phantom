/**
 * Claims are advisory holds an agent label recorded on the coordination
 * ledger — they coordinate scope and grant no execution, claim, merge,
 * dispatch or delivery authority. Filtering narrows the read only; it never
 * fabricates rows and an unreadable ledger stays unknown, never an invented
 * empty claim list. `agent`/`excludeAgent` match the recorded owner label
 * exactly — the ledger's agent labels are coordination names, never resolved
 * through the bus registry — the same rule the inbox and returns reads apply.
 */
import { parseSince } from './agent-messages.js';
import type { FleetBoard, FleetClaim } from './coordination.js';

function iso(ms: number): string {
  const time = new Date(ms).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : 'unknown';
}

/** Printable routing label — the same bound the ledger's own agent/id fields carry. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The owner/name repo shape the claim grammar itself accepts. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CONTAINS_MAX = 512;
/** The newest-first page every coordination read shares. */
const CLAIMS_PAGE = 50;

/** Resolved claims filters: every field narrows the live claim set, none fabricates rows. */
export interface CoordinationClaimsFilters {
  /** Exact owner label the claim's `agent` field records. */
  agent?: string;
  /** Exact owner label to drop — "what do the other seats hold" is one read. */
  excludeAgent?: string;
  /** Lowercase `owner/name` repo key — repo names compare case-insensitively. */
  repo?: string;
  /** Exact claim id. */
  id?: string;
  /** Inclusive lower bound on the claim's `claimedAt` stamp, epoch ms. */
  since?: number;
  /** Exclusive upper bound on the claim's `claimedAt` stamp, epoch ms. */
  before?: number;
  /** Normalized case-insensitive needle matched against the row's id, repo, task and agent text. */
  contains?: string;
}

/** The stringly flags the CLI hands the parser — the same names `CoordinationClaimsFilters` resolves to. */
export interface CoordinationClaimsFilterInput {
  agent?: string;
  excludeAgent?: string;
  repo?: string;
  id?: string;
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
 * Shared validation for the `claims` flags; `now` anchors the relative
 * grammar once per read — the same rules `parseCoordinationReturnsFilters`
 * and `parseCoordinationInboxFilters` apply to the sibling reads, plus the
 * claim's own owner, repo and id keys. `--since`/`--before` compose one
 * [since, before) window on each claim's `claimedAt` stamp — a claim stamped
 * exactly at `before` never matches, the same exclusive upper bound the bus
 * reads apply.
 */
export function parseCoordinationClaimsFilters(input: CoordinationClaimsFilterInput, now = Date.now()): CoordinationClaimsQuery {
  const filters: CoordinationClaimsFilters = {};
  if (input.agent !== undefined) {
    if (!IDENT.test(input.agent)) return { ok: false };
    filters.agent = input.agent;
  }
  if (input.excludeAgent !== undefined) {
    if (!IDENT.test(input.excludeAgent)) return { ok: false };
    filters.excludeAgent = input.excludeAgent;
  }
  if (input.repo !== undefined) {
    if (!REPO.test(input.repo)) return { ok: false };
    filters.repo = input.repo.toLowerCase();
  }
  if (input.id !== undefined) {
    if (!IDENT.test(input.id)) return { ok: false };
    filters.id = input.id;
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
 * One live claim against the resolved filters — the same slice rule the
 * returns and inbox projections apply: the [since, before) window on
 * `claimedAt`, exact structured matches on agent/excludeAgent/repo/id, and
 * the needle as a case-insensitive substring over the row's id, repo, task
 * and agent text (the same fields the row displays).
 */
function claimsRowMatch(claim: FleetClaim, filters: CoordinationClaimsFilters): boolean {
  if (filters.agent !== undefined && claim.agent !== filters.agent) return false;
  if (filters.excludeAgent !== undefined && claim.agent === filters.excludeAgent) return false;
  if (filters.repo !== undefined && claim.repo.toLowerCase() !== filters.repo) return false;
  if (filters.id !== undefined && claim.id !== filters.id) return false;
  if (filters.since !== undefined && claim.claimedAt < filters.since) return false;
  if (filters.before !== undefined && claim.claimedAt >= filters.before) return false;
  if (filters.contains !== undefined &&
      !fold(`${claim.id} ${claim.repo} ${claim.task} ${claim.agent}`).includes(filters.contains)) return false;
  return true;
}

/**
 * The live claims read: the advisory ledger's claim table projected newest
 * first. `filters` narrow the live set before the newest-50 page, so a
 * filtered read reaches claims the unfiltered cap would hide — the same
 * reason `fleet coordination returns` and `fleet coordination inbox` filter
 * their slices. `matched` counts the claims the filters kept; `omitted` is
 * the filtered truncation, so matched = claims.length + omitted under every
 * filter combination. Under an unknown board both stay null — the count is
 * unknown, never an invented zero.
 */
export function projectCoordinationClaims(board: FleetBoard | null, nowMs: number,
  filters?: CoordinationClaimsFilters) {
  const base = { v: 1 as const, source: 'coordination-ledger' as const, asOf: iso(nowMs) };
  if (board === null) {
    return { ...base, state: 'unknown' as const, claims: [], expiredClaims: null,
      matched: null, omitted: null, reason: 'coordination ledger: reader failed' };
  }
  const observationKnown = base.asOf !== 'unknown';
  const known = board.state === 'known';
  // An unknown ledger reports no claims and null counts — unknown stays
  // unknown, never an invented empty list presented as a verified zero.
  const matched = known
    ? (filters === undefined ? board.claims : board.claims.filter(claim => claimsRowMatch(claim, filters)))
    : [];
  const claims = [...matched]
    .sort((a, b) => b.claimedAt - a.claimedAt)
    .slice(0, CLAIMS_PAGE)
    .map(c => ({
      id: c.id, repo: c.repo, task: String(c.task).slice(0, 200), agent: c.agent,
      claimedAt: iso(c.claimedAt), expiresAt: iso(c.expiresAt),
      expiresInSeconds: observationKnown && iso(c.expiresAt) !== 'unknown'
        ? Math.round((c.expiresAt - nowMs) / 1000) : null,
    }));
  return { ...base, state: board.state, claims, expiredClaims: board.expiredClaims,
    matched: known ? matched.length : null,
    omitted: known ? Math.max(0, matched.length - claims.length) : null };
}
