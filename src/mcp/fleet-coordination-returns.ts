/**
 * `fleet_coordination_returns` MCP adapter: the retained RESULT receipts
 * read — `projectCoordinationReturns`, the same projection
 * `phm fleet coordination returns` serves. The receipts are evidence an
 * agent label posted, never authenticated authority: VERIFIED means the
 * returning agent named that evidence, not that Phantom checked the PR,
 * and unknown means unknown, not absent.
 *
 * `claim`, `repo`, `result`, `from`, `since`, `before` and `contains`
 * take the same names and rules the CLI flags share — validation
 * delegates to the one `parseCoordinationReturnsFilters` parser, so an
 * MCP client can never disagree with the CLI about what a filter means.
 * The filters narrow the parsed set before the newest-50 page, so a
 * filtered read reaches receipts the unfiltered cap hides, and
 * `coverage.matched`/`coverage.omitted` keep the filtered truncation
 * honest. Read-only: the ledger path stays server-owned, no caller root,
 * path or cwd is accepted, and the tool never writes, claims, merges,
 * verifies or sends.
 */
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import {
  parseCoordinationReturnsFilters, projectCoordinationReturns,
  type CoordinationReturnsFilters, type CoordinationReturnsFilterInput,
} from '../core/fleet/coordination-returns-view.js';

const FILTER_KEYS = ['claim', 'repo', 'result', 'from', 'since', 'before', 'contains'] as const;
const RETURNS_KEYS: ReadonlySet<string> = new Set(FILTER_KEYS);

/** Resolved returns filters — the same `CoordinationReturnsFilters` the CLI read applies. */
export type FleetCoordinationReturnsArgs = CoordinationReturnsFilters;

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. Every
 * value must be a string — the shared `parseCoordinationReturnsFilters`
 * then applies the receipt grammar (`claim`/`from` the ledger's
 * printable-label bound, `repo` the owner/name shape compared
 * case-insensitively, `result` the VERIFIED|BLOCKED verdict, `since`/
 * `before` the shared 15m/2h/1d/epoch-ms/ISO time grammar composing one
 * [since, before) window on each receipt's `at` stamp, `contains` a
 * non-empty needle of at most 512 chars). Unknown keys, wrong types and
 * malformed values are all refused before the ledger is touched.
 */
export function parseFleetCoordinationReturnsArgs(args: Record<string, unknown>): FleetCoordinationReturnsArgs | null {
  if (Object.keys(args).some(key => !RETURNS_KEYS.has(key))) return null;
  const input: CoordinationReturnsFilterInput = {};
  for (const key of FILTER_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    input[key] = value;
  }
  const parsed = parseCoordinationReturnsFilters(input);
  return parsed.ok ? parsed.filters : null;
}

/**
 * One returns read through the shared projection — the identical read
 * `phm fleet coordination returns` runs, so receipt parsing, filter
 * narrowing before the newest-50 slice and the unknown-state honesty can
 * never diverge between the CLI and this tool. A throwing or unreadable
 * ledger projects `state: 'unknown'` with empty returns — never an
 * invented receipt list.
 */
export function readFleetCoordinationReturns(args: FleetCoordinationReturnsArgs = {}): ReturnType<typeof projectCoordinationReturns> {
  const now = Date.now();
  let board: FleetBoard | null = null;
  try { board = readFleetBoard({ now, reap: false }); } catch { /* unknown stays unknown */ }
  const filtered = Object.values(args).some(value => value !== undefined);
  return projectCoordinationReturns(board, now, filtered ? args : undefined);
}
