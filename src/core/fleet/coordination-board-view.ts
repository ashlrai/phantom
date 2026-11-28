/**
 * Fleet-wide board projection over the advisory coordination ledger. The
 * ledger's agent labels are coordination names, not bus routing labels, so
 * --agent matches the recorded label exactly and never resolves through the
 * agent registry — the same rule the inbox and returns projections apply.
 * Filtering is a read convenience only; it grants no authority, and an
 * unreadable board stays unknown with empty sections — filters never
 * fabricate rows.
 */
import { parseSince } from './agent-messages.js';
import type { FleetAssignment, FleetBoard, FleetClaim, FleetMessage } from './coordination.js';

/** A coordination label — the same bound the ledger's own id/from/to/agent fields carry. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The owner/name repo shape claims and proposals record. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CONTAINS_MAX = 512;

/** Resolved board filters: every field narrows the three ledger sections, none fabricates rows. */
export interface CoordinationBoardFilters {
  /** Lowercase `owner/name` repo key — claim and proposal repos compare case-insensitively; messages record no repo and never match under it. */
  repo?: string;
  /** Exact coordination label the record names — a claim's holder, a proposal's assignee, a message's sender or addressee; `all` broadcasts name every agent. */
  agent?: string;
  /** Normalized case-insensitive needle matched against each section's own text — claim task, message body, proposal repo+task. */
  contains?: string;
  /** Inclusive lower bound on each record's own stamp — claim `claimedAt`, message/proposal `at` — epoch ms. */
  since?: number;
  /** Exclusive upper bound on the same stamps, epoch ms. */
  before?: number;
}

/** The stringly flags the CLI hands the parser — the same names `CoordinationBoardFilters` resolves to. */
export interface CoordinationBoardFilterInput {
  repo?: string;
  agent?: string;
  contains?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
}

export type CoordinationBoardQuery = { ok: true; filters: CoordinationBoardFilters } | { ok: false };

function boardContainsNeedle(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > CONTAINS_MAX) return null;
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Shared validation for the `board` flags; `now` anchors the relative
 * grammar once per read — the same rules `parseCoordinationInboxFilters`
 * and `parseCoordinationReturnsFilters` apply to the sibling reads, plus
 * the repo key claims and proposals carry. `--since`/`--before` compose one
 * [since, before) window on each record's own stamp — a record stamped
 * exactly at `before` never matches, the same exclusive upper bound the
 * bus reads apply.
 */
export function parseCoordinationBoardFilters(input: CoordinationBoardFilterInput, now = Date.now()): CoordinationBoardQuery {
  const filters: CoordinationBoardFilters = {};
  if (input.repo !== undefined) {
    if (!REPO.test(input.repo)) return { ok: false };
    filters.repo = input.repo.toLowerCase();
  }
  if (input.agent !== undefined) {
    if (!IDENT.test(input.agent)) return { ok: false };
    filters.agent = input.agent;
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
  const needle = boardContainsNeedle(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters };
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/** The board view `projectCoordinationBoard` returns — the same fields the raw `FleetBoard` read emits, each section narrowed by the filters. */
export interface CoordinationBoardView {
  schema: 'fleet.coordination.v1';
  state: 'known' | 'unknown';
  claims: FleetClaim[];
  messages: FleetMessage[];
  proposals: FleetAssignment[];
  /** Live-ledger expired-claim count — board health, never a filtered row, so it passes through untouched (`null` when the ledger is unknown). */
  expiredClaims: number | null;
}

/**
 * The fleet-wide board read narrowed by the supplied filters. `--repo`
 * keeps claims and proposals recorded for that repo (case-insensitive, the
 * returns read's rule) and drops every message — a message records no repo
 * and a positive filter never guesses one in. `--agent` keeps records naming
 * that coordination label: a claim's holder, a proposal's assignee, and a
 * message the label sent, was sent to, or that was broadcast to `all` — the
 * same addressed-set rule the inbox read applies to `all`. `--contains`
 * searches each section's own text the way the inbox read does — claim
 * task, message body, proposal repo+task — and `--since`/`--before` bound
 * each record's own stamp inside one [since, before) window. An unknown
 * board stays unknown with empty sections; `expiredClaims` and `state`
 * always pass through so ledger health is never hidden by a filter.
 */
export function projectCoordinationBoard(board: FleetBoard, filters: CoordinationBoardFilters = {}): CoordinationBoardView {
  const windowed = (at: number): boolean =>
    (filters.since === undefined || at >= filters.since) &&
    (filters.before === undefined || at < filters.before);
  const needle = filters.contains;
  const claims = board.claims.filter(claim =>
    (filters.repo === undefined || claim.repo.toLowerCase() === filters.repo) &&
    (filters.agent === undefined || claim.agent === filters.agent) &&
    windowed(claim.claimedAt) &&
    (needle === undefined || fold(claim.task).includes(needle)));
  const messages = filters.repo !== undefined ? [] : board.messages.filter(message =>
    (filters.agent === undefined || message.from === filters.agent || message.to === filters.agent || message.to === 'all') &&
    windowed(message.at) &&
    (needle === undefined || fold(message.body).includes(needle)));
  const proposals = board.proposals.filter(proposal =>
    (filters.repo === undefined || proposal.repo.toLowerCase() === filters.repo) &&
    (filters.agent === undefined || proposal.to === filters.agent) &&
    windowed(proposal.at) &&
    (needle === undefined || fold(`${proposal.repo} ${proposal.task}`).includes(needle)));
  return { schema: board.schema, state: board.state, claims, messages, proposals,
    expiredClaims: board.expiredClaims };
}
