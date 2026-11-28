/**
 * Board projection over the advisory coordination ledger with the shared
 * read-filter set `fleet coordination inbox` and `returns` already take.
 * Each collection filters on the fields it records: claims carry an owner
 * (`agent`), repo, task and claim time; messages carry sender, recipient,
 * body and post time; proposals carry repo, task, recipient and propose
 * time. A field a row never records can never match its filter — claims
 * have no `to`, messages no `repo`, proposals no `from` — so unknown stays
 * out of a positive match rather than being guessed in. The ledger's agent
 * labels are coordination names, not bus routing labels, so every match is
 * exact and never resolves through the agent registry. Filtering is a read
 * convenience only; it grants no authority.
 */
import { parseSince } from './agent-messages.js';
import type { FleetAssignment, FleetBoard, FleetClaim, FleetMessage } from './coordination.js';

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const CONTAINS_MAX = 512;

/** Resolved board filters; every field narrows its own collection's recorded fields, none fabricates rows. */
export interface CoordinationBoardFilters {
  /** Exact row id on any of the three collections. */
  id?: string;
  /** Exact message sender label; claims and proposals record no sender and never match it. */
  from?: string;
  /** Exact message sender label excluded; only messages carry a sender, so claims and proposals stay listed. */
  excludeFrom?: string;
  /** Exact message recipient or proposal `to` label; claims record no recipient and never match it. */
  to?: string;
  /** Exact claim owner label (`agent`); messages and proposals record no claim owner and never match it. */
  agent?: string;
  /** `owner/name` repo key, case-insensitive; claims and proposals carry one, messages record no repo and never match it. */
  repo?: string;
  /** Inclusive lower bound on each row's recorded stamp, epoch ms. */
  since?: number;
  /** Exclusive upper bound on each row's recorded stamp, epoch ms. */
  before?: number;
  /** Normalized case-insensitive needle over each row's displayed fields. */
  contains?: string;
}

/** The stringly flags the CLI hands the parser — the same names `CoordinationBoardFilters` resolves to. */
export interface CoordinationBoardFilterInput {
  id?: string;
  from?: string;
  excludeFrom?: string;
  to?: string;
  agent?: string;
  repo?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
}

export type CoordinationBoardQuery = { ok: true; filters: CoordinationBoardFilters } | { ok: false };

function containsNeedle(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > CONTAINS_MAX) return null;
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Shared validation for the `board` flags; `now` anchors the relative
 * grammar once per read — the same rules `parseCoordinationInboxFilters`
 * and `parseCoordinationReturnsFilters` apply, plus the board's own id,
 * recipient, claim-owner and repo keys. `--since`/`--before` compose one
 * [since, before) window on each row's recorded stamp — a row stamped
 * exactly at `before` never matches, the same exclusive upper bound every
 * bus read applies.
 */
export function parseCoordinationBoardFilters(input: CoordinationBoardFilterInput, now = Date.now()): CoordinationBoardQuery {
  const filters: CoordinationBoardFilters = {};
  for (const key of ['id', 'from', 'excludeFrom', 'to', 'agent'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (!IDENT.test(value)) return { ok: false };
    filters[key] = value;
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
  const needle = containsNeedle(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters };
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');
const windowed = (at: number, filters: CoordinationBoardFilters): boolean =>
  (filters.since === undefined || at >= filters.since) &&
  (filters.before === undefined || at < filters.before);

function claimMatch(claim: FleetClaim, filters: CoordinationBoardFilters): boolean {
  // Claims record no sender or recipient: --from and --to are positive
  // sender/recipient filters, so a claim can never satisfy either. The
  // negative --exclude-from names a sender to drop, and a claim has no
  // sender to exclude, so it stays listed.
  return filters.from === undefined && filters.to === undefined &&
    (filters.id === undefined || claim.id === filters.id) &&
    (filters.agent === undefined || claim.agent === filters.agent) &&
    (filters.repo === undefined || claim.repo.toLowerCase() === filters.repo) &&
    windowed(claim.claimedAt, filters) &&
    (filters.contains === undefined ||
      fold(`${claim.repo} ${claim.task} ${claim.agent} ${claim.id}`).includes(filters.contains));
}

function messageMatch(message: FleetMessage, filters: CoordinationBoardFilters): boolean {
  // Messages record no claim owner or repo: --agent and --repo are positive
  // filters on fields a message never carries, so it can never satisfy them.
  return filters.agent === undefined && filters.repo === undefined &&
    (filters.id === undefined || message.id === filters.id) &&
    (filters.from === undefined || message.from === filters.from) &&
    (filters.excludeFrom === undefined || message.from !== filters.excludeFrom) &&
    (filters.to === undefined || message.to === filters.to) &&
    windowed(message.at, filters) &&
    (filters.contains === undefined ||
      fold(`${message.from} ${message.to} ${message.body} ${message.id}`).includes(filters.contains));
}

function proposalMatch(proposal: FleetAssignment, filters: CoordinationBoardFilters): boolean {
  // Proposals record no sender or claim owner: --from and --agent are
  // positive filters on fields a proposal never carries. --exclude-from
  // names a sender to drop and a proposal has no sender, so it stays.
  return filters.from === undefined && filters.agent === undefined &&
    (filters.id === undefined || proposal.id === filters.id) &&
    (filters.to === undefined || proposal.to === filters.to) &&
    (filters.repo === undefined || proposal.repo.toLowerCase() === filters.repo) &&
    windowed(proposal.at, filters) &&
    (filters.contains === undefined ||
      fold(`${proposal.repo} ${proposal.task} ${proposal.to} ${proposal.id}`).includes(filters.contains));
}

/**
 * The whole-board read narrowed by the supplied filters. An unfiltered or
 * empty filter set returns the board untouched; an unknown board stays
 * unknown with its empty lists and null `expiredClaims` — filters never
 * fabricate rows and never turn unknown into a verified-empty board.
 */
export function projectCoordinationBoard(board: FleetBoard, filters?: CoordinationBoardFilters): FleetBoard {
  if (board.state !== 'known' || filters === undefined ||
      Object.values(filters).every(value => value === undefined)) return board;
  return {
    ...board,
    claims: board.claims.filter(claim => claimMatch(claim, filters)),
    messages: board.messages.filter(message => messageMatch(message, filters)),
    proposals: board.proposals.filter(proposal => proposalMatch(proposal, filters)),
  };
}
