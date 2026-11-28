/**
 * Inbox projection over the advisory coordination board. The ledger's agent
 * labels are coordination names, not bus routing labels, so --from matches
 * the recorded sender exactly and never resolves through the agent registry.
 * Filtering is a read convenience only; it grants no authority.
 */
import { parseSince } from './agent-messages.js';
import type { FleetAssignment, FleetBoard, FleetMessage } from './coordination.js';

const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTAINS_MAX = 512;

export interface CoordinationInboxFilters {
  /** Exact sender label; proposals carry no sender and never match it. */
  from?: string;
  /** Exact sender label whose posts drop out; proposals carry no sender, so
   * an exclusion can never prove one came from this label and they stay. */
  excludeFrom?: string;
  /** Exact record id — a message id or a proposal id. */
  id?: string;
  /** Keep only one record class: live messages or assignment proposals. */
  kind?: CoordinationInboxKind;
  /** Inclusive lower bound on the record's `at` stamp, epoch ms. */
  since?: number;
  /** Exclusive upper bound on the record's `at` stamp, epoch ms. */
  before?: number;
  /** Normalized case-insensitive needle matched against message bodies and proposal repo+task text. */
  contains?: string;
}

/** The two record classes the addressed inbox carries, in output order. */
export const COORDINATION_INBOX_KINDS = ['message', 'proposal'] as const;
export type CoordinationInboxKind = (typeof COORDINATION_INBOX_KINDS)[number];
export const isCoordinationInboxKind = (value: string): value is CoordinationInboxKind =>
  (COORDINATION_INBOX_KINDS as readonly string[]).includes(value);

export interface CoordinationInboxFilterInput {
  from?: string;
  excludeFrom?: string;
  id?: string;
  kind?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
}

export type CoordinationInboxQuery = { ok: true; filters: CoordinationInboxFilters } | { ok: false };

function containsNeedle(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > CONTAINS_MAX) return null;
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Shared validation for the CLI flags; `now` anchors the relative grammar once per read. */
export function parseCoordinationInboxFilters(input: CoordinationInboxFilterInput, now = Date.now()): CoordinationInboxQuery {
  const filters: CoordinationInboxFilters = {};
  if (input.from !== undefined) {
    if (!IDENT.test(input.from)) return { ok: false };
    filters.from = input.from;
  }
  if (input.excludeFrom !== undefined) {
    if (!IDENT.test(input.excludeFrom)) return { ok: false };
    filters.excludeFrom = input.excludeFrom;
  }
  if (input.id !== undefined) {
    if (!IDENT.test(input.id)) return { ok: false };
    filters.id = input.id;
  }
  if (input.kind !== undefined) {
    if (!isCoordinationInboxKind(input.kind)) return { ok: false };
    filters.kind = input.kind;
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

export interface CoordinationInboxView {
  schema: 'fleet.coordination.v1';
  state: 'known' | 'unknown';
  messages: FleetMessage[];
  proposals: FleetAssignment[];
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/**
 * The agent's inbox: live messages addressed to it or `all`, plus proposals
 * addressed to it, narrowed by the supplied filters. `--since`/`--before`
 * compose one [since, before) window on each record's `at` stamp — a record
 * stamped exactly at `before` never matches, the same exclusive upper bound
 * the bus reads apply. `--contains` keeps messages whose scrubbed body and
 * proposals whose repo and task carry the needle; `--from` keeps only posts
 * the named sender label wrote, so every proposal drops out of a sender
 * read, while `--exclude-from` drops only posts the named sender label
 * provably wrote — a proposal carries no sender an exclusion could match,
 * so it stays. `--id` keeps the one message or proposal carrying that exact
 * record id and `--kind` keeps only one record class (`message` or
 * `proposal`), so "the assignments addressed to me" and "one known record"
 * are each one filtered read. An unknown board stays unknown with empty
 * lists — filters never fabricate rows.
 */
export function projectCoordinationInbox(board: FleetBoard, agent: string, filters: CoordinationInboxFilters = {}): CoordinationInboxView {
  const windowed = (at: number): boolean =>
    (filters.since === undefined || at >= filters.since) &&
    (filters.before === undefined || at < filters.before);
  const needle = filters.contains;
  const messages = filters.kind === 'proposal' ? [] : board.messages.filter(message =>
    (message.to === agent || message.to === 'all') &&
    (filters.from === undefined || message.from === filters.from) &&
    (filters.excludeFrom === undefined || message.from !== filters.excludeFrom) &&
    (filters.id === undefined || message.id === filters.id) &&
    windowed(message.at) &&
    (needle === undefined || fold(message.body).includes(needle)));
  const proposals = filters.from !== undefined || filters.kind === 'message' ? [] : board.proposals.filter(proposal =>
    proposal.to === agent &&
    (filters.id === undefined || proposal.id === filters.id) &&
    windowed(proposal.at) &&
    (needle === undefined || fold(`${proposal.repo} ${proposal.task}`).includes(needle)));
  return { schema: board.schema, state: board.state, messages, proposals };
}
