/**
 * `fleet_coordination_claims` MCP adapter: the live coordination-claims
 * read — `projectCoordinationClaims`, the same projection
 * `phm fleet coordination claims` serves. Claims are advisory ownership
 * records on this computer's coordination ledger: they grant no execution,
 * merge, verify, dispatch or send authority, and unknown means ownership is
 * unknown, not absent.
 *
 * `id`, `agent`, `repo`, `since`, `before` and `contains` take the same
 * names and rules the CLI flags share — validation delegates to the one
 * `parseCoordinationClaimsFilters` parser, so an MCP client can never
 * disagree with the CLI about what a filter means. The filters narrow the
 * live-claim set before the newest-50 slice, so a filtered read reaches
 * claims the unfiltered cap hides — "who holds claim X", "what does agent Y
 * hold", "claims on repo Z started in the last hour" — and `matched`/
 * `omitted` keep the bounded page honest the way the sibling returns and
 * inbox reads' coverage counters do; an unreadable ledger keeps both null —
 * unknown stays unknown, never an invented zero. Read-only: the ledger
 * path stays server-owned, no caller root, path or cwd is accepted, and the
 * tool never claims, releases, hands off, returns or writes.
 */
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import {
  parseCoordinationClaimsFilters, projectCoordinationClaims,
  type CoordinationClaimsFilterInput, type CoordinationClaimsFilters,
} from '../core/fleet/coordination-claims-view.js';

const FILTER_KEYS = ['id', 'agent', 'repo', 'since', 'before', 'contains'] as const;
const CLAIMS_KEYS: ReadonlySet<string> = new Set(FILTER_KEYS);

/** Resolved claims filters — the same `CoordinationClaimsFilters` the CLI read applies. */
export type FleetCoordinationClaimsArgs = CoordinationClaimsFilters;

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every
 * value must be a string — the shared `parseCoordinationClaimsFilters`
 * then applies the ledger grammar (`id`/`agent` the printable-label
 * bound, `repo` the owner/name shape compared case-insensitively,
 * `since`/`before` the shared 15m/2h/1d/epoch-ms/ISO time grammar composing
 * one [since, before) window on each claim's `claimedAt` stamp, `contains`
 * a non-empty needle of at most 512 chars). Unknown keys, wrong types and
 * malformed values are all refused before the ledger is touched.
 */
export function parseFleetCoordinationClaimsArgs(args: Record<string, unknown>): FleetCoordinationClaimsArgs | null {
  if (Object.keys(args).some(key => !CLAIMS_KEYS.has(key))) return null;
  const input: CoordinationClaimsFilterInput = {};
  for (const key of FILTER_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    input[key] = value;
  }
  const parsed = parseCoordinationClaimsFilters(input);
  return parsed.ok ? parsed.filters : null;
}

/**
 * One claims read through the shared projection — the identical read
 * `phm fleet coordination claims` runs, so live-claim filtering, the
 * newest-50 slice and the unknown-state honesty can never diverge between
 * the CLI and this tool. `reap: false` keeps the read from appending an
 * expiry row; an unreadable or throwing ledger read projects
 * `state: 'unknown'` with `matched`/`omitted` null — never an invented
 * claim list or a zeroed count.
 */
export function readFleetCoordinationClaims(args: FleetCoordinationClaimsArgs = {}): ReturnType<typeof projectCoordinationClaims> {
  const now = Date.now();
  let board: FleetBoard | null = null;
  try { board = readFleetBoard({ now, reap: false }); } catch { /* unknown stays unknown */ }
  const filtered = Object.values(args).some(value => value !== undefined);
  return projectCoordinationClaims(board, now, filtered ? args : undefined);
}
