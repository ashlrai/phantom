/**
 * Filters for the fleet-wide board read behind `phm fleet coordination board`.
 * The ledger's agent labels are coordination names, not bus routing labels, so
 * --from matches the recorded owner/sender exactly and never resolves through
 * the agent registry. Filtering is a read convenience only; it grants no
 * authority, and an unreadable ledger stays unknown — filters never fabricate
 * rows.
 */
import { parseSince } from './agent-messages.js';
import type { FleetBoard } from './coordination.js';

/** Printable routing label — the same bound the ledger's own id/from/to/agent fields carry. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The owner/name repo shape the ledger itself accepts; repo names compare case-insensitively. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CONTAINS_MAX = 512;

/** Resolved board filters: every field narrows one or more of the board's collections, none fabricates rows. */
export interface CoordinationBoardFilters {
  /** Exact agent label: keeps claims that label holds and messages that label posted; proposals carry no sender and drop out. */
  from?: string;
  /** Lowercase `owner/name` repo key — claims and proposals compare case-insensitively; messages carry no repo and drop out. */
  repo?: string;
  /** Inclusive lower bound on each record's stamp (claims.claimedAt, messages.at, proposals.at), epoch ms. */
  since?: number;
  /** Exclusive upper bound on each record's stamp, epoch ms — a record stamped exactly at `before` never matches. */
  before?: number;
  /** Normalized case-insensitive needle matched against claims'/proposals' repo+task text and message bodies. */
  contains?: string;
}

/** The stringly flags the CLI hands the parser — the same names `CoordinationBoardFilters` resolves to. */
export interface CoordinationBoardFilterInput {
  from?: string;
  repo?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
}

export type CoordinationBoardQuery = { ok: true; filters: CoordinationBoardFilters } | { ok: false };

function boardContainsNeedle(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > CONTAINS_MAX) return null;
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Shared validation for the `board` flags; `now` anchors the relative grammar
 * once per read — the same rules `parseCoordinationInboxFilters` and
 * `parseCoordinationReturnsFilters` apply to the sibling reads. `--since`/
 * `--before` compose one [since, before) window on each record's own stamp —
 * a claim reads `claimedAt`, a message or proposal its `at` — the same
 * exclusive upper bound the bus reads apply.
 */
export function parseCoordinationBoardFilters(input: CoordinationBoardFilterInput, now = Date.now()): CoordinationBoardQuery {
  const filters: CoordinationBoardFilters = {};
  if (input.from !== undefined) {
    if (!IDENT.test(input.from)) return { ok: false };
    filters.from = input.from;
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
  const needle = boardContainsNeedle(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters };
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/** One [since, before) window check on a record's epoch-ms stamp. */
const inWindow = (at: number, filters: CoordinationBoardFilters): boolean =>
  (filters.since === undefined || at >= filters.since) &&
  (filters.before === undefined || at < filters.before);

/**
 * The fleet-wide board narrowed by the supplied filters. Each collection
 * applies the filters its records can answer: `--from` keeps claims the
 * named agent holds and messages the named sender posted while every proposal
 * drops out (proposals carry an assignee, never a sender); `--repo` keeps
 * claims and proposals on that repo while every message drops out (messages
 * carry no repo); `--since`/`--before` window each record's own stamp;
 * `--contains` keeps claims and proposals whose repo+task and messages whose
 * body carry the needle. `expiredClaims` stays the ledger-wide expired count —
 * expired rows are never projected, so no per-filter count exists to report.
 * An unknown board passes through untouched: state stays unknown and the
 * lists stay empty.
 */
export function projectCoordinationBoard(board: FleetBoard, filters: CoordinationBoardFilters = {}): FleetBoard {
  if (board.state !== 'known') return board;
  const claims = board.claims.filter(claim =>
    (filters.from === undefined || claim.agent === filters.from) &&
    (filters.repo === undefined || claim.repo.toLowerCase() === filters.repo) &&
    inWindow(claim.claimedAt, filters) &&
    (filters.contains === undefined || fold(`${claim.repo} ${claim.task}`).includes(filters.contains)));
  const messages = board.messages.filter(message =>
    filters.repo === undefined &&
    (filters.from === undefined || message.from === filters.from) &&
    inWindow(message.at, filters) &&
    (filters.contains === undefined || fold(message.body).includes(filters.contains)));
  const proposals = board.proposals.filter(proposal =>
    filters.from === undefined &&
    (filters.repo === undefined || proposal.repo.toLowerCase() === filters.repo) &&
    inWindow(proposal.at, filters) &&
    (filters.contains === undefined || fold(`${proposal.repo} ${proposal.task}`).includes(filters.contains)));
  return { ...board, claims, messages, proposals };
}
