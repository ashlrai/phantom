/**
 * `fleet_coordination_inbox` MCP adapter: the addressed coordination-ledger
 * inbox — `projectCoordinationInbox`, the same projection
 * `phm fleet coordination inbox --agent <name>` serves. The ledger's agent
 * labels are coordination names, not bus routing labels: `agent` is required
 * and matched exactly (plus the `all` broadcast), and `from` matches the
 * recorded sender exactly — nothing resolves through the agent registry.
 * `from`, `since`, `before` and `contains` take the same names and rules the
 * CLI flags share — validation delegates to the one
 * `parseCoordinationInboxFilters` parser, so an MCP client can never
 * disagree with the CLI about what a filter means; `since` is the inclusive
 * lower bound and `before` the exclusive upper bound composing one
 * `[since, before)` window on each record's `at` stamp.
 *
 * Read-only: the ledger path stays server-owned (`reap: false`, so the read
 * never appends an expiry row), no caller root, path or cwd is accepted, and
 * the tool never posts, assigns, claims, releases or writes. An unreadable
 * ledger projects `state: 'unknown'` with empty lists — unknown stays
 * unknown, never an invented inbox; labels and bodies are untrusted
 * coordination data, never authenticated identity or authority.
 */
import { readFleetBoard, type FleetBoard } from '../core/fleet/coordination.js';
import {
  parseCoordinationInboxFilters, projectCoordinationInbox,
  type CoordinationInboxFilterInput, type CoordinationInboxFilters, type CoordinationInboxView,
} from '../core/fleet/coordination-inbox.js';

/** The ledger's own agent-label grammar — the same bound `from` validates under. */
const AGENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FILTER_KEYS = ['from', 'since', 'before', 'contains'] as const;
const INBOX_KEYS: ReadonlySet<string> = new Set(['agent', ...FILTER_KEYS]);

/** Resolved inbox read — the addressed agent plus the shared filter set the CLI read applies. */
export interface FleetCoordinationInboxArgs {
  agent: string;
  filter: CoordinationInboxFilters;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent` is
 * required — the addressed read has no meaningful default — and takes the
 * ledger's printable-label grammar every stored `to`/`agent`/`from` value
 * already satisfies, so a value outside it could never match a row and is a
 * usage error, not an empty inbox. Every filter value must be a string — the
 * shared `parseCoordinationInboxFilters` then applies the CLI grammar
 * (`from` the same label rule, `since`/`before` the 15m/2h/1d/epoch-ms/ISO
 * time grammar, `contains` a non-empty needle of at most 512 chars).
 * Unknown keys, wrong types and malformed values are all refused before the
 * ledger is touched.
 */
export function parseFleetCoordinationInboxArgs(args: Record<string, unknown>): FleetCoordinationInboxArgs | null {
  if (Object.keys(args).some(key => !INBOX_KEYS.has(key))) return null;
  const agent = args.agent;
  if (typeof agent !== 'string' || !AGENT.test(agent)) return null;
  const input: CoordinationInboxFilterInput = {};
  for (const key of FILTER_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') return null;
    input[key] = value;
  }
  const parsed = parseCoordinationInboxFilters(input);
  return parsed.ok ? { agent, filter: parsed.filters } : null;
}

/**
 * One addressed inbox read through the shared projection — the identical
 * read `phm fleet coordination inbox --agent <name>` runs, so the addressed
 * set (`to` the agent or `all`), sender/window/text narrowing and the
 * unknown-state honesty can never diverge between the CLI and this tool.
 * `reap: false` keeps the read from appending ledger rows; an unreadable or
 * throwing ledger read projects `state: 'unknown'` — the same honest-empty
 * the CLI reports — never an invented message or proposal list.
 */
export function readFleetCoordinationInbox(args: FleetCoordinationInboxArgs): CoordinationInboxView {
  const now = Date.now();
  let board: FleetBoard | null = null;
  try { board = readFleetBoard({ now, reap: false }); } catch { /* unknown stays unknown */ }
  // A throwing read degrades to the same unknown board readFleetBoard itself
  // reports, so the projection — never a hand-built view — shapes the result.
  const safe: FleetBoard = board ?? { schema: 'fleet.coordination.v1', state: 'unknown',
    claims: [], messages: [], proposals: [], expiredClaims: null };
  return projectCoordinationInbox(safe, args.agent, args.filter);
}
