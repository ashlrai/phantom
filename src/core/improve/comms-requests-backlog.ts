/**
 * <ashlr home>/comms/requests.jsonl comms request store → self-improvement
 * backlog items.
 *
 * The CommsRequest store (src/core/comms/requests.ts) is the protocol layer
 * behind every question, approval and report Phantom asks its owner:
 * postRequest appends a 'pending' row, dispatch promotes it to 'sent' (at
 * most ONE question/approval may be outstanding at a time — reports never
 * wait for the slot), resolveRequest records the owner's numbered reply,
 * and expireStaleRequests / expireRequestsWhere / noteSendFailure /
 * markReportDelivered stamp 'expired' or 'answered' by rewriting the whole
 * file as one snapshot. Mutations rewrite <home>/.ashlr/comms/requests.jsonl
 * (storeDir resolves join(homedir(), '.ashlr', 'comms') — it honors $HOME,
 * never $ASHLR_HOME), so expired rows persist as history and accumulate
 * until they age out of any bounded tail read.
 *
 * Until now the store had no trend reader at all: readCommsRequests feeds
 * the comms API's point-in-time queue view and listRequests feeds `phm
 * comms`, both snapshots of right now — so a channel whose asks kept
 * expiring unanswered, whose pending queue kept starving behind one stuck
 * question, or whose transport kept rejecting sends never became work.
 * The store's own doc comment records the stakes: on a live machine one
 * June question held 585 digests and briefings back for three months
 * until TTL expiry was added.
 * commsRequestsBacklogItems carries the expired rows into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The store is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched. A
 *    missing, unreadable or non-file store yields no items; a malformed
 *    line is skipped, never guessed.
 *  - Rows count only under the writer's contract: id/kind are bounded
 *    control-character-free strings, type is the closed
 *    question|approval|report vocabulary, status is the closed
 *    pending|sent|answered|expired vocabulary, createdAt/sentAt/expiredAt
 *    are absent or parseable instants, and an 'expired' row always carries
 *    a parseable expiredAt (every expiry path stamps it). Foreign shapes
 *    are malformed, never folded.
 *  - Only 'expired' rows are evidence. Pending and sent rows are live
 *    queue state that may still resolve; answered rows are resolved
 *    history. Live rows count toward the parsed total only.
 *  - The window anchors on expiredAt — when the friction occurred — not
 *    createdAt, so a request posted long ago but expired inside the
 *    window still counts.
 *  - Recurring means recorded across days: a (type, kind, expiry-class)
 *    cell emits only at COMMS_REQUESTS_MIN_ROWS in-window expiries across
 *    COMMS_REQUESTS_MIN_DAYS distinct UTC days. One migration sweep, one
 *    bad transport afternoon or one designed veto window cannot mint a
 *    pattern by itself.
 *  - Expiry classes are counted, never guessed: 'send-failure' rows carry
 *    the writer's own 'send failed N times' expiredReason (noteSendFailure
 *    expired a pending request the transport kept rejecting);
 *    'migration:*' reasons are the one-time 3.14 cleanup and never count;
 *    every other expiry splits on sentAt — 'unanswered' reached the owner
 *    and expired before a reply, 'unsent' never left pending (starved
 *    behind the single question slot or never accepted by the transport).
 *    expiredReason text is never surfaced: it is caller-supplied free
 *    text, so only its class is folded.
 *  - Requests carry free-text `text`, `options`, `meta` and `answerText`
 *    — owner-facing message bodies that can embed URLs, handles and
 *    personal detail. This fold never reads, validates, counts or emits
 *    them; only the bounded kind/type identifiers, timestamps and counts
 *    reach a prompt.
 *  - Truncation is stated, never hidden: when the bounded tail cut older
 *    bytes, every prompt says the counts are a lower bound.
 *  - Fleet machinery only: items emit only for the fleet's own
 *    repository — the same last-segment rule the sibling fleet-evidence
 *    sources apply — since the store describes this install's owner
 *    channel and carries no repository column. Dedup is downstream: the
 *    item id hashes the cell identity, never counts or timestamps, so a
 *    refresh re-derives the same id and a recovered channel simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is types × kinds × three classes. */
export const COMMS_REQUESTS_BACKLOG_MAX_ITEMS = 12;
const COMMS_REQUESTS_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const COMMS_REQUESTS_WINDOW_HOURS = 168;
/** A cell emits only at this many in-window expiries... */
export const COMMS_REQUESTS_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days. */
export const COMMS_REQUESTS_MIN_DAYS = 2;
/**
 * Bounded no-follow tail. The writer's own read bound is 8 MiB; the fold
 * needs only the 7-day window and asks are human-paced, so 1 MiB retains
 * far more expiry history than the window can hold.
 */
export const COMMS_REQUESTS_TAIL_BYTES = 1024 * 1024;
/** The fleet's own repository label: comms evidence is this install's owner channel, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on journal timestamps. */
const SKEW_MS = 300_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded kind strings are bounded identifiers; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 80;
/** The writer's kind vocabulary is bounded; control characters and oversized text reject the row. */
const MAX_KIND_CHARS = 120;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export type CommsRequestRecordType = 'question' | 'approval' | 'report';
export type CommsExpiryClass = 'send-failure' | 'unanswered' | 'unsent';

const REQUEST_TYPES = new Set<string>(['question', 'approval', 'report']);
const REQUEST_STATUSES = new Set<string>(['pending', 'sent', 'answered', 'expired']);

export interface CommsRequestsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Store override (default: join(homeDir, '.ashlr', 'comms', 'requests.jsonl')). */
  journalPath?: string;
  /** Home the store's own resolution uses (default: homedir()); the writer honors $HOME, never $ASHLR_HOME. */
  homeDir?: string;
  /** Evidence window in hours (default COMMS_REQUESTS_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default COMMS_REQUESTS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const dayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);
const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= max &&
    !Array.from(value).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
}

function parseInstant(value: unknown, maxChars: number): number | null {
  if (!boundedString(value, maxChars)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// ---------------------------------------------------------------------------
// Row contract — one CommsRequest exactly as the store persists it
// ---------------------------------------------------------------------------

interface CommsRequestRow {
  type: CommsRequestRecordType;
  /** Bounded writer vocabulary, e.g. 'fleet-digest', 'manager-approval', 'leader-veto'. */
  kind: string;
  status: 'pending' | 'sent' | 'answered' | 'expired';
  createdAtMs: number;
  sentAtMs: number | null;
  expiredAtMs: number | null;
  /** Writer/caller-supplied expiry reason; classified, never surfaced. */
  expiredReason: string | null;
}

/**
 * Structural validation of one persisted row against the writer's
 * CommsRequest contract. Only the fields this fold reads are validated;
 * the free-text `text`, `options`, `meta` and `answerText` fields are
 * deliberately never inspected. Returns null for a corrupted or foreign
 * row so the caller counts it malformed and skips it rather than let
 * damaged evidence masquerade as a real expiry. An 'expired' row must
 * carry a parseable expiredAt — every expiry path in the writer stamps
 * one — while sentAt/expiredReason stay optional as the writer leaves
 * them.
 */
function projectRequest(row: Record<string, unknown>): CommsRequestRow | null {
  if (!boundedString(row['id'], 64)) return null;
  const kind = row['kind'];
  if (!boundedString(kind, MAX_KIND_CHARS)) return null;
  const type = row['type'];
  if (typeof type !== 'string' || !REQUEST_TYPES.has(type)) return null;
  const status = row['status'];
  if (typeof status !== 'string' || !REQUEST_STATUSES.has(status)) return null;
  const createdAtMs = parseInstant(row['createdAt'], 64);
  if (createdAtMs === null) return null;
  const sentRaw = row['sentAt'];
  const sentAtMs = sentRaw === undefined || sentRaw === null ? null : parseInstant(sentRaw, 64);
  if (sentRaw !== undefined && sentRaw !== null && sentAtMs === null) return null;
  const expiredRaw = row['expiredAt'];
  const expiredAtMs = expiredRaw === undefined || expiredRaw === null ? null : parseInstant(expiredRaw, 64);
  if (expiredRaw !== undefined && expiredRaw !== null && expiredAtMs === null) return null;
  if (status === 'expired' && expiredAtMs === null) return null;
  const reasonRaw = row['expiredReason'];
  if (reasonRaw !== undefined && reasonRaw !== null && !boundedString(reasonRaw, 200)) return null;
  return {
    type: type as CommsRequestRecordType,
    kind,
    status: status as CommsRequestRow['status'],
    createdAtMs,
    sentAtMs,
    expiredAtMs,
    expiredReason: typeof reasonRaw === 'string' ? reasonRaw : null,
  };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the store tail
// ---------------------------------------------------------------------------

/** Per-cell in-window fold before the recurring bars apply. */
export interface CommsRequestCellFold {
  type: CommsRequestRecordType;
  kind: string;
  expiryClass: CommsExpiryClass;
  /** In-window expired rows for this (type, kind, class). */
  rows: number;
  /** Distinct UTC days the expiries landed on. */
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface CommsRequestsFold {
  /** Valid CommsRequest rows parsed — live, resolved and expired alike. */
  requests: number;
  /** In-window expired rows carrying evidence — the share denominator the prompts quote. */
  expired: number;
  cells: Map<string, CommsRequestCellFold>;
  /** Non-blank lines that failed the writer's row contract. */
  malformed: number;
  /** Expired rows outside the window or beyond the future-skew tolerance. */
  outsideWindow: number;
}

/**
 * The writer's expiry taxonomy, folded to a class. 'migration:*' reasons
 * are the one-time 3.14 cleanup — designed, never friction. The
 * 'send failed N times' reason is noteSendFailure's own stamp. Every
 * other expiry splits on whether the request ever reached the owner.
 */
function expiryClassOf(row: CommsRequestRow): CommsExpiryClass | 'migration' {
  if (row.expiredReason !== null) {
    if (row.expiredReason.startsWith('migration:')) return 'migration';
    if (/^send failed \d+ times?$/.test(row.expiredReason)) return 'send-failure';
  }
  return row.sentAtMs !== null ? 'unanswered' : 'unsent';
}

/**
 * Pure: fold store text(s) — oldest first — into per-cell recurring
 * expiry evidence. Lines that fail the writer's row contract, live
 * (non-expired) rows, migration cleanups and rows outside the window are
 * skipped, never guessed.
 */
export function foldCommsRequests(
  texts: readonly string[],
  nowMs: number,
  windowHours: number,
): CommsRequestsFold {
  const fold: CommsRequestsFold = { requests: 0, expired: 0, cells: new Map(), malformed: 0, outsideWindow: 0 };
  const since = nowMs - windowHours * 3_600_000;
  const until = nowMs + SKEW_MS;
  for (const text of texts) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fold.malformed++;
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        fold.malformed++;
        continue;
      }
      const request = projectRequest(parsed as Record<string, unknown>);
      if (request === null) { fold.malformed++; continue; }
      fold.requests += 1;
      if (request.status !== 'expired' || request.expiredAtMs === null) continue;
      if (request.expiredAtMs < since || request.expiredAtMs > until) { fold.outsideWindow++; continue; }
      const expiryClass = expiryClassOf(request);
      if (expiryClass === 'migration') continue;
      fold.expired += 1;
      const key = `${request.type}|${request.kind}|${expiryClass}`;
      let cell = fold.cells.get(key);
      if (cell === undefined) {
        cell = { type: request.type, kind: request.kind, expiryClass, rows: 0, days: new Set(), firstMs: null, lastMs: null };
        fold.cells.set(key, cell);
      }
      cell.rows += 1;
      cell.days.add(dayOf(request.expiredAtMs));
      cell.firstMs = cell.firstMs === null ? request.expiredAtMs : Math.min(cell.firstMs, request.expiredAtMs);
      cell.lastMs = cell.lastMs === null ? request.expiredAtMs : Math.max(cell.lastMs, request.expiredAtMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface CommsRequestCell {
  kind: 'comms-request-expiry';
  type: CommsRequestRecordType;
  /** The writer's bounded kind vocabulary for this cell. */
  requestKind: string;
  expiryClass: CommsExpiryClass;
  /** In-window expired rows carrying the cell's evidence. */
  rows: number;
  /** Sorted distinct UTC days the expiries landed on. */
  days: string[];
  /** In-window expired rows overall — the share denominator. */
  expired: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

/**
 * The recurring bars one cell must clear: rows across distinct UTC days
 * inside the evidence window. Expiry classes need no extra dimension —
 * the writer stamps one expiredAt per row and human-paced asks make
 * three expiries on two days already a pattern.
 */
function recurring(cell: CommsRequestCellFold): boolean {
  return cell.rows >= COMMS_REQUESTS_MIN_ROWS && cell.days.size >= COMMS_REQUESTS_MIN_DAYS;
}

/** Broken transport first, then asks that reached the owner and died, then asks that never left the queue. */
const CLASS_RANK: Record<CommsExpiryClass, number> = {
  'send-failure': 0,
  unanswered: 1,
  unsent: 2,
};
/** Within a class, approvals gate work so they sort before questions and reports. */
const TYPE_RANK: Record<CommsRequestRecordType, number> = {
  approval: 0,
  question: 1,
  report: 2,
};

/**
 * Pure: recurring cells — a (type, kind, expiry-class) group at the
 * row/day bars. Sharper classes sort first, then gated types, then row
 * count.
 */
export function commsRequestCells(fold: CommsRequestsFold, lowerBound = false): CommsRequestCell[] {
  const cells: CommsRequestCell[] = [];
  for (const cell of fold.cells.values()) {
    if (!recurring(cell)) continue;
    cells.push({
      kind: 'comms-request-expiry',
      type: cell.type,
      requestKind: cell.kind,
      expiryClass: cell.expiryClass,
      rows: cell.rows,
      days: [...cell.days].sort(),
      expired: fold.expired,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) =>
    CLASS_RANK[a.expiryClass] - CLASS_RANK[b.expiryClass] ||
    TYPE_RANK[a.type] - TYPE_RANK[b.type] ||
    b.rows - a.rows ||
    `${a.type}|${a.requestKind}|${a.expiryClass}`.localeCompare(`${b.type}|${b.requestKind}|${b.expiryClass}`));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <ashlr home>/comms/requests.jsonl — storeDir() in src/core/comms/requests.ts resolves join(homedir(), \'.ashlr\', \'comms\'), honoring $HOME and never $ASHLR_HOME — the CommsRequest store behind every question, approval and report Phantom asks its owner. postRequest appends a \'pending\' row; dispatch promotes at most one question/approval to \'sent\' (reports never wait for the slot); resolveRequest records the owner\'s numbered reply; expireStaleRequests, expireRequestsWhere, noteSendFailure and markReportDelivered stamp \'expired\' or \'answered\' by rewriting the file as one snapshot, so expired rows persist as history. Callers include change-digest.ts, merge-requests.ts, handlers.ts, leader-apply.ts and cli/comms.ts. Its only readers until this feed were readCommsRequests — the comms API\'s point-in-time queue view — and listRequests behind `phm comms`, both snapshots of right now, never a recurrence fold.';

const REPRO = 'Reproduce the fold by reading <ashlr home>/comms/requests.jsonl directly, keeping rows whose status is \'expired\', anchoring on expiredAt, and grouping by (type, kind, expiry class): \'send-failure\' when expiredReason matches \'send failed N times\', excluded when it starts with \'migration:\', otherwise \'unanswered\' when sentAt is set and \'unsent\' when it is not. The writer, lifecycle and expiry rules this repository owns are src/core/comms/requests.ts.';

const NO_CHANGE = 'Some expiries are designed, not friction: leader-veto questions exist to expire when their veto window closes — the expiry IS the mechanism, the action proceeds — TTL expiry of digests and reports can be intended triage of a channel the owner does not watch, and an expired approval resolving nothing is fail-closed by design (it is never a yes). If `phm comms` dispatch or cycle is not scheduled the store is a sparse manual sample rather than a continuous record, and an expired row whose ask was genuinely moot resolves the question it asked. Report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const seenText = (cell: CommsRequestCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: CommsRequestCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const shareText = (cell: CommsRequestCell): string =>
  cell.expired > 0 ? ` (${Math.round((cell.rows / cell.expired) * 100)}% of the ${cell.expired} in-window expired rows)` : '';

function classClaim(cell: CommsRequestCell): string {
  switch (cell.expiryClass) {
    case 'send-failure':
      return 'the transport rejected the send often enough that noteSendFailure expired it — the request never reached its destination';
    case 'unanswered':
      return cell.type === 'approval'
        ? 'the request was sent but expired before any reply — an approval that never got a decision stalls the work it gated, and fail-closed means it is never a yes'
        : 'the request was sent but expired before any reply — whatever it asked never got an answer';
    case 'unsent':
      return 'the request sat pending until its TTL expired without ever being sent — it never reached the owner, typically starved behind the single outstanding-question slot or never accepted by the transport';
  }
}

function commsRequestPrompt(cell: CommsRequestCell): string {
  const kind = fieldText(cell.requestKind, MAX_NAME_CHARS);
  const typeWord = cell.type === 'approval' ? 'approval' : cell.type === 'question' ? 'question' : 'report';
  const headline = cell.expiryClass === 'send-failure'
    ? `Phantom's comms request store keeps recording '${kind}' requests expiring on send failures`
    : cell.expiryClass === 'unanswered'
      ? `Phantom's comms request store keeps recording '${kind}' ${typeWord} requests expiring unanswered`
      : `Phantom's comms request store keeps recording '${kind}' requests expiring unsent`;
  const detail = [
    headline,
    '',
    `${cell.rows} expired row(s) across ${cell.days.length} UTC day(s) (${daysText(cell.days)}) for '${kind}' ${typeWord} requests — the self-improvement work this backlog exists for.`,
    '',
    `Each row is one CommsRequest the store marked 'expired': ${classClaim(cell)}.${shareText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why '${kind}' ${cell.expiryClass === 'send-failure' ? 'sends keep failing' : cell.expiryClass === 'unanswered' ? 'asks keep expiring unanswered' : 'requests keep expiring unsent'}: trace the kind's producers (change-digest.ts, merge-requests.ts, handlers.ts, leader-apply.ts, cli/comms.ts) into postRequest, then check the dispatch path that promotes pending to sent — the single outstanding-question slot in outstanding(), the TTL from cfg.comms.requestTtlHours (default 48 hours), noteSendFailure's failure budget, and whatever transport actually delivers the iMessage. For send failures, find whether the transport credential, the message shape or the send path in the comms dispatch is broken; for unanswered expiries, find whether the asks are too frequent or too low-value to deserve the owner's attention, whether they duplicate what another channel already surfaces, or whether the reply path (resolveRequest's numbered-answer matching) is dropping answers; for unsent expiries, find whether one stuck question is starving the pending queue — the exact failure the TTL was added to bound. Fix what lives here — the ask producers, the dispatch/slot logic, the TTL policy or the reply matching — never the owner's attention itself.`,
    '',
    NO_CHANGE,
    '',
    REPRO,
  ];
  return detail.join('\n');
}

function commsRequestTitle(cell: CommsRequestCell): string {
  const kind = fieldText(cell.requestKind, MAX_NAME_CHARS);
  switch (cell.expiryClass) {
    case 'send-failure': return `Comms '${kind}' sends keep failing`.slice(0, MAX_TITLE_CHARS);
    case 'unanswered': return `Comms ${cell.type === 'approval' ? 'approval' : cell.type === 'question' ? 'question' : 'report'} '${kind}' keeps expiring unanswered`.slice(0, MAX_TITLE_CHARS);
    case 'unsent': return `Comms '${kind}' requests keep expiring unsent`.slice(0, MAX_TITLE_CHARS);
  }
}

function commsRequestArea(cell: CommsRequestCell): string {
  return `comms-${cell.expiryClass}`;
}

function commsRequestItem(cell: CommsRequestCell, repo: string): CloudBacklogItem {
  return {
    id: `comms-req-${sha(`${cell.type}|${cell.requestKind}|${cell.expiryClass}`)}`,
    title: commsRequestTitle(cell),
    prompt: commsRequestPrompt(cell),
    area: commsRequestArea(cell),
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the comms request store's recurring expiry evidence.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function commsRequestsBacklogItems(opts: CommsRequestsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? COMMS_REQUESTS_WINDOW_HOURS;
    const homeDir = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath ?? join(homeDir, '.ashlr', 'comms', 'requests.jsonl');
    const read = await readLedgerTail(journalPath, COMMS_REQUESTS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    // readLedgerTail has no time filter; the fold's per-row window check
    // drops everything older than the window, so the tail folds whole.
    const fold = foldCommsRequests([read.text], nowMs, windowHours);
    if (fold.expired === 0) return [];
    const cells = commsRequestCells(fold, read.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? COMMS_REQUESTS_BACKLOG_MAX_ITEMS, COMMS_REQUESTS_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => commsRequestItem(cell, repo));
  } catch {
    return [];
  }
}
