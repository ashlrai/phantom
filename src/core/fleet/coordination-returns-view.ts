/**
 * Returns are evidence posted by an agent label, not authenticated authority.
 * VERIFIED means the returning agent named this evidence, not that Phantom checked the PR.
 */
import { parseSince } from './agent-messages.js';
import type { FleetBoard } from './coordination.js';

/** A receipt's qualification against the caller's observation clock at asOf. */
type Temporal = 'current' | 'expired' | 'future' | 'invalid';

interface Row {
  claimId: string;
  repo: string;
  result: 'VERIFIED' | 'BLOCKED';
  evidenceKind: 'pr' | 'tests' | 'artifact' | 'dependency';
  pr: number | null;
  head: string | null;
  evidence: string;
  from: string;
  at: string;
  expiresAt: string;
  /**
   * Temporal qualification of this receipt: current inside [at, expiresAt),
   * expired at or after expiry, future when the receipt post-dates the
   * observation, invalid on an unrenderable clock or non-positive lifetime.
   * Non-enumerable by design — the row's enumerable key set is a reviewed
   * evidence-only contract — so readers use row.temporal in memory and
   * serialized output emits it through toJSON.
   */
  readonly temporal: Temporal;
  /** Emits the enumerable fields plus temporal for JSON.stringify. */
  toJSON(): Record<string, unknown>;
}

function iso(ms: number): string {
  const time = new Date(ms).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : 'unknown';
}

/** Total clock check: NaN, infinities and finite values outside Date's range all fail. */
const renderable = (ms: number): boolean => Number.isFinite(new Date(ms).getTime());

/** Qualify a receipt's [at, expiresAt) window against the caller's observation clock. */
function temporalOf(at: number, expiresAt: number, observedAt: number): Temporal {
  if (!renderable(at) || !renderable(expiresAt) || !renderable(observedAt) || expiresAt <= at)
    return 'invalid';
  if (at > observedAt) return 'future';
  return observedAt >= expiresAt ? 'expired' : 'current';
}

function rowToJSON(this: Row): Record<string, unknown> {
  return { ...this, temporal: this.temporal };
}

// The task is quoted but unescaped by the writer, so consume through its final delimiter.
const RECEIPT = /^RESULT (VERIFIED|BLOCKED) ([A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}) claim ([A-Za-z0-9][A-Za-z0-9._:-]{0,127}) task "(.+)": ((pr) #([1-9]\d*) head ([a-fA-F0-9]{7,40})|(tests|artifact|dependency) (.+))$/;

/** Printable routing label — the same bound the ledger's own id/from/to fields carry. */
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** The owner/name repo shape the receipt grammar itself accepts. */
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const RESULTS = new Set(['VERIFIED', 'BLOCKED']);
const CONTAINS_MAX = 512;

/** Resolved returns filters: every field narrows the parsed receipt set, none fabricates rows. */
export interface CoordinationReturnsFilters {
  /** Exact claim id the receipt's `return-<id>` message and RESULT claim field name. */
  claim?: string;
  /** Lowercase `owner/name` repo key — repo names compare case-insensitively. */
  repo?: string;
  /** Exact RESULT verdict. */
  result?: 'VERIFIED' | 'BLOCKED';
  /** Exact sender label; the ledger's agent labels are coordination names, never resolved through the bus registry. */
  from?: string;
  /** Inclusive lower bound on the receipt's `at` stamp, epoch ms. */
  since?: number;
  /** Exclusive upper bound on the receipt's `at` stamp, epoch ms. */
  before?: number;
  /** Normalized case-insensitive needle matched against the row's repo, verdict, evidence kind and evidence text. */
  contains?: string;
}

/** The stringly flags the CLI hands the parser — the same names `CoordinationReturnsFilters` resolves to. */
export interface CoordinationReturnsFilterInput {
  claim?: string;
  repo?: string;
  result?: string;
  from?: string;
  /** `15m`, `2h`, `1d`, epoch ms or an ISO time — the shared parseSince grammar. */
  since?: string;
  before?: string;
  contains?: string;
}

export type CoordinationReturnsQuery = { ok: true; filters: CoordinationReturnsFilters } | { ok: false };

function returnsContainsNeedle(value: string | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value.trim() === '' || value.length > CONTAINS_MAX) return null;
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Shared validation for the `returns` flags; `now` anchors the relative
 * grammar once per read — the same rules `parseCoordinationInboxFilters`
 * applies to the sibling inbox read, plus the receipt's own claim, repo and
 * verdict keys. `--since`/`--before` compose one [since, before) window on
 * each receipt's `at` stamp — a receipt stamped exactly at `before` never
 * matches, the same exclusive upper bound the bus reads apply.
 */
export function parseCoordinationReturnsFilters(input: CoordinationReturnsFilterInput, now = Date.now()): CoordinationReturnsQuery {
  const filters: CoordinationReturnsFilters = {};
  if (input.claim !== undefined) {
    if (!IDENT.test(input.claim)) return { ok: false };
    filters.claim = input.claim;
  }
  if (input.repo !== undefined) {
    if (!REPO.test(input.repo)) return { ok: false };
    filters.repo = input.repo.toLowerCase();
  }
  if (input.result !== undefined) {
    if (!RESULTS.has(input.result)) return { ok: false };
    filters.result = input.result as 'VERIFIED' | 'BLOCKED';
  }
  if (input.from !== undefined) {
    if (!IDENT.test(input.from)) return { ok: false };
    filters.from = input.from;
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
  const needle = returnsContainsNeedle(input.contains);
  if (needle === null) return { ok: false };
  if (needle !== undefined) filters.contains = needle;
  return { ok: true, filters };
}

const fold = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ');

/**
 * One parsed receipt against the resolved filters — the same slice rule the
 * inbox projection applies: the [since, before) window on `at`, exact
 * structured matches on claim/repo/result/from, and the needle as a
 * case-insensitive substring over the row's repo, verdict, evidence kind and
 * evidence text (the same fields the row displays; ids stay structured).
 */
function returnsRowMatch(entry: { row: Row; at: number }, filters: CoordinationReturnsFilters): boolean {
  const { row } = entry;
  if (filters.claim !== undefined && row.claimId !== filters.claim) return false;
  if (filters.repo !== undefined && row.repo.toLowerCase() !== filters.repo) return false;
  if (filters.result !== undefined && row.result !== filters.result) return false;
  if (filters.from !== undefined && row.from !== filters.from) return false;
  if (filters.since !== undefined && entry.at < filters.since) return false;
  if (filters.before !== undefined && entry.at >= filters.before) return false;
  if (filters.contains !== undefined &&
      !fold(`${row.repo} ${row.result} ${row.evidenceKind} ${row.evidence}`).includes(filters.contains)) return false;
  return true;
}

/** Explicit selection keeps unrelated ledger fields out of the public projection. */
export function projectCoordinationReturns(board: FleetBoard | null, nowMs: number,
  filters?: CoordinationReturnsFilters) {
  const base = { v: 1 as const, source: 'coordination-ledger' as const, asOf: iso(nowMs) };
  if (board === null || board.state === 'unknown') {
    return { ...base, state: 'unknown' as const, returns: [] as Row[], unparsed: 0,
      // Legacy unparsed stays compatible; coverage counters are unknown, not zero.
      coverage: { parsedTotal: null, matched: null, omitted: null, unparsed: null },
      reason: 'coordination ledger: reader failed' };
  }
  const rows: { row: Row; at: number }[] = [];
  let unparsed = 0;
  for (const message of board.messages) {
    if (!message.id.startsWith('return-')) continue;
    const match = RECEIPT.exec(message.body);
    const kind = match?.[6] ?? match?.[9];
    const pr = match?.[7] === undefined ? null : Number(match[7]);
    if (!match || match[3] !== message.id.slice('return-'.length)
      || (match[1] === 'BLOCKED') !== (kind === 'dependency')
      || (pr !== null && !Number.isSafeInteger(pr))
      || (match[10] !== undefined && !match[10].trim())) {
      unparsed++;
      continue;
    }
    const row = {
      claimId: match[3]!, repo: match[2]!, result: match[1] as Row['result'],
      evidenceKind: kind as Row['evidenceKind'], pr, head: match[8] ?? null,
      evidence: match[5]!.slice(0, 300), from: message.from,
      at: iso(message.at), expiresAt: iso(message.expiresAt),
    } as Row;
    // temporal and toJSON stay off the enumerable surface; a retained board
    // re-projected at a later clock still qualifies the receipt honestly.
    Object.defineProperties(row, {
      temporal: { value: temporalOf(message.at, message.expiresAt, nowMs) },
      toJSON: { value: rowToJSON },
    });
    rows.push({ at: message.at, row });
  }
  // Filters narrow the parsed set before the newest-50 slice, so a filtered
  // read reaches receipts the unfiltered cap would hide — the same reason
  // `fleet coordination inbox` filters its addressed slice. `matched` counts
  // the receipts the filters kept; `omitted` is the filtered truncation, so
  // matched = returns.length + omitted under every filter combination, while
  // `parsedTotal`/`unparsed` keep describing the whole ledger's parse.
  const matched = filters === undefined ? rows : rows.filter(entry => returnsRowMatch(entry, filters));
  return { ...base, state: 'known' as const,
    coverage: { parsedTotal: rows.length, matched: matched.length,
      omitted: Math.max(0, matched.length - 50), unparsed },
    returns: matched.sort((a, b) => b.at - a.at).slice(0, 50).map(entry => entry.row), unparsed };
}
