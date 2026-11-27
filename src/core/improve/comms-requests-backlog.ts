/**
 * Comms request store → self-improvement backlog items.
 *
 * Every question, approval and report the fleet raises for Mason is a
 * CommsRequest row in ~/.ashlr/comms/requests.jsonl — the protocol store
 * behind `phm comms` (src/core/comms/requests.ts). postRequest appends a
 * 'pending' row; the comms dispatch cycle (src/core/comms/dispatch.ts)
 * promotes one question/approval at a time to 'sent' behind a single
 * outstanding slot and a cooldown, delivers reports straight to
 * 'answered', and expireStaleRequests/expireRequestsWhere/noteSendFailure
 * retire rows that outlive their TTL, a migration or a send-failure
 * budget. Mutations rewrite the whole file, so each retained line is one
 * request's LATEST state — there is no per-transition history, and a
 * row's position is its creation order.
 *
 * Until now the store's only readers were the dispatch cycle itself,
 * `phm comms` listings and the unified inbox's point-in-time projection
 * — reports of current queue state, never a trend. An expired row is
 * the fleet's own recorded verdict that a request did not complete:
 *
 *  - 'unanswered': a sent question/approval whose TTL lapsed with no
 *    reply — Mason was asked and never answered. Recurring expiries of
 *    one kind mean the ask is either correctly owner-gated, raised too
 *    eagerly, or the delivery path is breaking silently.
 *  - 'never-sent': a pending request that TTL-expired before dispatch
 *    ever sent it — the single question slot stayed held (usually by an
 *    unanswered question) or reports kept failing ahead of it. Recurring
 *    expiries mean producers post faster than the channel drains, or
 *    dispatch is not cycling.
 *  - 'send-failures': a pending request expired after the transport
 *    rejected it MAX_REPORT_SEND_FAILURES times ('send failed N times')
 *    — the iMessage/Telegram path kept refusing.
 *  - 'unclassified': an expiredReason outside the writer's current
 *    vocabulary (anything not 'migration:…' or 'send failed N times') —
 *    a newer expireRequestsWhere caller's reason this fold does not
 *    know, quoted bounded.
 *
 * 'migration:…' expiredReason rows are designed one-time retirements
 * (the 3.14 comms migrations) and never emit, like the sibling feeds'
 * designed-traffic rules. 'answered' rows are the success path and fold
 * only as per-kind delivered context; 'pending'/'sent' rows are live
 * queue state — a sent request past TTL has not been retired yet and
 * becomes 'unanswered' evidence on the pass after expiry stamps it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The store is read once through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no lock, process or network
 *    is touched. A missing or unreadable file yields no items — unknown
 *    stays unknown, never a guessed tally — and a truncated tail folds
 *    the retained rows with the prompts stating the counts as lower
 *    bounds.
 *  - Rows count only under the writer's contract: the closed
 *    type/status vocabularies, a non-empty id and kind, a parseable
 *    createdAt, an array options field, string-typed optional fields,
 *    and a parseable expiredAt on every 'expired' row (the writer
 *    always stamps it; the fold windows on it). Malformed lines and
 *    off-contract rows are counted, never guessed.
 *  - Recurring means recorded across days. A (kind, class) cell emits
 *    only after COMMS_REQUESTS_MIN_ROWS adverse rows inside the
 *    retained 7-day window span COMMS_REQUESTS_MIN_DAYS distinct UTC
 *    days — one expired request is an incident, not a pattern. Every
 *    row is already a distinct request id (the store holds one row per
 *    request), so no retry-storm collapse is needed.
 *  - The store is this install's comms traffic and carries no
 *    repository dimension, and the comms pipeline is this repository's
 *    machinery, so items emit only when the backlog target's
 *    repository name is 'phantom' — the same last-segment rule the
 *    sibling fleet-evidence sources apply.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    cell's kind, class and reason key (never the counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items.
 *  - Every journal string is untrusted text: kind and reason are
 *    scrubbed, flattened, deduped, capped and quoted inside a DATA
 *    fence so recorded prose cannot read as instructions, and cell
 *    identity hashes the raw values so journal text never becomes an
 *    identifier.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (kind, class) cells are bounded by kind and reason diversity. */
export const COMMS_REQUESTS_BACKLOG_MAX_ITEMS = 8;
const COMMS_REQUESTS_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on. */
export const COMMS_REQUESTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on row timestamps, same convention the sibling folds tolerate. */
const COMMS_REQUESTS_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a cell needs before its recurrence counts. */
export const COMMS_REQUESTS_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const COMMS_REQUESTS_MIN_DAYS = 2;
/**
 * Bounded tail for the store; a request row is a few hundred bytes, so
 * 512 KiB retains over a thousand requests — far more than a week of
 * comms traffic even on a busy fleet.
 */
const COMMS_REQUESTS_TAIL_BYTES = 512 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded strings are pattern-light; flatten, scrub and cap anyway. */
const MAX_FIELD_CHARS = 80;
/** The fleet's own repository label: comms evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The writer's closed vocabularies (src/core/comms/requests.ts CommsRequest). */
const REQUEST_TYPES = new Set(['question', 'approval', 'report']);
const REQUEST_STATUSES = new Set(['pending', 'sent', 'answered', 'expired']);
/** Designed one-time retirements (src/core/comms/migrations.ts) never emit. */
const MIGRATION_REASON_PREFIX = 'migration:';
/** noteSendFailure's recorded reason: `send failed ${failures} times`. */
const SEND_FAILURE_REASON = /^send failed \d+ times$/;

export interface CommsRequestsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Store override (default: join(homeDir, '.ashlr', 'comms', 'requests.jsonl')). */
  requestsPath?: string;
  /** Home for the default store path — the writer resolves homedir()/.ashlr, ignoring ASHLR_HOME (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default COMMS_REQUESTS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
  /** Window in ms (default COMMS_REQUESTS_WINDOW_MS). */
  windowMs?: number;
}

/** One validated store row. Optional timestamps are NaN when absent or unparseable. */
export interface CommsRequestRow {
  /** The request's unique id — every row is already a distinct request. */
  id: string;
  /** The ask kind (manager-approval, leader-veto, fleet-digest, ...), normalized for cell identity. */
  kind: string;
  /** The request type (question, approval, report). */
  type: string;
  /** The lifecycle status at last write. */
  status: string;
  createdAtMs: number;
  sentAtMs: number;
  answeredAtMs: number;
  expiredAtMs: number;
  /** The recorded expiry reason ('' when the TTL path stamped none). */
  expiredReason: string;
  /** Consecutive failed send attempts on pending reports (undefined when never recorded). */
  sendFailures: number | undefined;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** Normalize a journal-recorded string for cell identity: trimmed, lowercased, bounded. */
function cellKeyText(value: unknown, max = MAX_FIELD_CHARS): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, max) : '';
}

/** Journal-recorded strings are untrusted text; scrub secrets and home paths, flatten, cap. */
function fieldText(value: string, max = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const parseIso = (value: unknown): number =>
  typeof value === 'string' ? Date.parse(value) : NaN;

/**
 * Pure: validate one parsed store line against the writer's record
 * contract. Every CommsRequest carries id, kind, type, text, options,
 * status and createdAt; the lifecycle timestamps and expiredReason are
 * optional strings the writer stamps only on the transitions that earn
 * them. An 'expired' row MUST carry a parseable expiredAt — the writer
 * always stamps it and the fold windows on it, so a row without one is
 * off-contract. Unknown extra fields (meta, answerIndex, answerText)
 * are tolerated so a writer that adds metadata later does not
 * invalidate its own history.
 */
export function parseCommsRequestEntry(value: unknown): CommsRequestRow | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  const kind = value['kind'];
  const type = value['type'];
  const status = value['status'];
  const text = value['text'];
  const options = value['options'];
  const createdAtMs = parseIso(value['createdAt']);
  if (typeof id !== 'string' || id.trim() === '') return null;
  if (typeof kind !== 'string' || kind.trim() === '') return null;
  if (typeof type !== 'string' || !REQUEST_TYPES.has(type)) return null;
  if (typeof status !== 'string' || !REQUEST_STATUSES.has(status)) return null;
  if (typeof text !== 'string') return null;
  if (!Array.isArray(options)) return null;
  if (!Number.isFinite(createdAtMs)) return null;
  for (const key of ['sentAt', 'answeredAt', 'expiredAt', 'expiredReason'] as const) {
    const field = value[key];
    if (field !== undefined && typeof field !== 'string') return null;
  }
  const sendFailures = value['sendFailures'];
  if (sendFailures !== undefined && (typeof sendFailures !== 'number' || !Number.isFinite(sendFailures))) return null;
  const expiredAtMs = parseIso(value['expiredAt']);
  if (status === 'expired' && !Number.isFinite(expiredAtMs)) return null;
  const sentAtMs = parseIso(value['sentAt']);
  const answeredAtMs = parseIso(value['answeredAt']);
  // The writer stamps these only as ISO timestamps; a present-but-
  // unparseable stamp is off-contract rather than "absent".
  if (value['sentAt'] !== undefined && !Number.isFinite(sentAtMs)) return null;
  if (value['answeredAt'] !== undefined && !Number.isFinite(answeredAtMs)) return null;
  return {
    id,
    kind: cellKeyText(kind),
    type,
    status,
    createdAtMs,
    sentAtMs,
    answeredAtMs,
    expiredAtMs,
    expiredReason: typeof value['expiredReason'] === 'string' ? value['expiredReason'] : '',
    sendFailures: sendFailures as number | undefined,
  };
}

/**
 * Pure: parse the store's text into validated rows plus the count of
 * lines that were not on-contract entries — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseCommsRequestText(text: string): { rows: CommsRequestRow[]; invalidRows: number } {
  const rows: CommsRequestRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseCommsRequestEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

/** The adverse classes an expired row can evidence. */
export type CommsRequestCellClass = 'unanswered' | 'never-sent' | 'send-failures' | 'unclassified';

/**
 * Pure: classify one 'expired' row, or null when the row is designed
 * traffic (a 'migration:…' retirement) that never emits. The writer's
 * reason vocabulary is checked first — it is explicit evidence — then
 * the sentAt stamp decides unanswered versus never-sent.
 */
export function classifyExpiredRequest(row: CommsRequestRow): { cls: CommsRequestCellClass; reasonKey: string } | null {
  const reason = row.expiredReason;
  if (reason.startsWith(MIGRATION_REASON_PREFIX)) return null;
  if (SEND_FAILURE_REASON.test(reason)) return { cls: 'send-failures', reasonKey: '' };
  if (reason !== '') return { cls: 'unclassified', reasonKey: cellKeyText(reason) };
  return { cls: Number.isFinite(row.sentAtMs) ? 'unanswered' : 'never-sent', reasonKey: '' };
}

/** One evidence cell's tally: every adverse expiry on one (kind, class[, reason]). */
export interface CommsRequestCell {
  kind: string;
  cls: CommsRequestCellClass;
  /** Normalized expiredReason for 'unclassified' cells ('' otherwise). */
  reasonKey: string;
  /** Stable cell identity for item ids and dedupe. */
  key: string;
  /** Adverse rows inside the retained window. */
  rows: number;
  /** Distinct UTC days (of expiredAt) those rows fall on. */
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
  /** Distinct request types seen (question, approval, report). */
  types: Map<string, number>;
  /** Distinct recorded expiry reasons seen (bounded use in prompts). */
  reasons: Map<string, number>;
}

/**
 * Pure: fold validated rows into per-(kind, class) adverse cells plus
 * the per-kind delivered (answered) context counts. Only 'expired'
 * rows form cells, windowed on expiredAt; 'answered' rows count as
 * delivered context windowed on answeredAt (createdAt when the stamp
 * is absent); 'pending'/'sent' rows are live queue state and skipped.
 * Windowing and the recurring bar are applied here.
 */
export function foldCommsRequestCells(
  rows: readonly CommsRequestRow[],
  nowMs: number,
  windowMs: number = COMMS_REQUESTS_WINDOW_MS,
): { cells: CommsRequestCell[]; delivered: Map<string, number>; expiredRows: number; designedRows: number } {
  const windowStart = nowMs - windowMs;
  const futureCeil = nowMs + COMMS_REQUESTS_FUTURE_SKEW_MS;
  const cells = new Map<string, CommsRequestCell>();
  const delivered = new Map<string, number>();
  let expiredRows = 0;
  let designedRows = 0;
  for (const row of rows) {
    if (row.status === 'answered') {
      const atMs = Number.isFinite(row.answeredAtMs) ? row.answeredAtMs : row.createdAtMs;
      if (atMs < windowStart || atMs > futureCeil) continue;
      delivered.set(row.kind, (delivered.get(row.kind) ?? 0) + 1);
      continue;
    }
    if (row.status !== 'expired') continue;
    const atMs = row.expiredAtMs;
    if (atMs < windowStart || atMs > futureCeil) continue;
    const classified = classifyExpiredRequest(row);
    if (classified === null) { designedRows += 1; continue; }
    expiredRows += 1;
    const key = classified.cls === 'unclassified'
      ? `${row.kind}:${classified.cls}:${classified.reasonKey}`
      : `${row.kind}:${classified.cls}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        kind: row.kind, cls: classified.cls, reasonKey: classified.reasonKey, key,
        rows: 0, days: new Set(), firstAtMs: Infinity, lastAtMs: -Infinity,
        types: new Map(), reasons: new Map(),
      };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(utcDayOf(atMs));
    cell.firstAtMs = Math.min(cell.firstAtMs, atMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, atMs);
    cell.types.set(row.type, (cell.types.get(row.type) ?? 0) + 1);
    if (row.expiredReason !== '') {
      const reason = fieldText(row.expiredReason, MAX_FIELD_CHARS);
      cell.reasons.set(reason, (cell.reasons.get(reason) ?? 0) + 1);
    }
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.rows >= COMMS_REQUESTS_MIN_ROWS && cell.days.size >= COMMS_REQUESTS_MIN_DAYS)
    .sort((a, b) => b.rows - a.rows || b.lastAtMs - a.lastAtMs || a.key.localeCompare(b.key));
  return { cells: recurring, delivered, expiredRows, designedRows };
}

/** The evidence pointers every prompt shares; the writer, its store contract and its consumers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is requests.jsonl under ~/.ashlr/comms — the writer\'s own layout (storeDir() in src/core/comms/requests.ts resolves homedir()/.ashlr/comms, ignoring ASHLR_HOME). postRequest appends each question/approval/report as a pending CommsRequest; runCommsCycle in src/core/comms/dispatch.ts promotes one question or approval at a time to \'sent\' behind the single outstanding slot and cooldown, delivers reports to \'answered\', and expireStaleRequests, noteSendFailure and the one-time migrations in src/core/comms/migrations.ts stamp \'expired\' with expiredAt and an optional expiredReason. Mutations rewrite the file, so each retained line is one request\'s latest state. Until this feed the store\'s only readers were the dispatch cycle, `phm comms` listings and the unified inbox\'s point-in-time projection — current queue state, never a trend.';

const NO_CHANGE = 'If the kind is correctly owner-gated — a credential, 2FA, device or payment ask only Mason may answer — or the recorded window no longer reproduces on the default branch, or the recurrence is pinned ops machinery this repo must not rewrite — report no-change and name the evidence.';

function coverageNote(truncated: boolean, invalidRows: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded tail dropped older rows, so every count is a lower bound');
  if (invalidRows > 0) notes.push(`${invalidRows} malformed or off-contract lines dropped`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function spanText(cell: CommsRequestCell): string {
  if (!Number.isFinite(cell.firstAtMs) || !Number.isFinite(cell.lastAtMs)) return '';
  const first = new Date(cell.firstAtMs).toISOString();
  const last = new Date(cell.lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function kindLabel(cell: CommsRequestCell): string {
  return `'${fieldText(cell.kind)}'`;
}

function typeText(cell: CommsRequestCell): string {
  return [...cell.types.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `'${fieldText(t)}' ×${n}`).join(', ');
}

function reasonText(cell: CommsRequestCell): string {
  if (cell.reasons.size === 0) return '';
  return ` Recorded reasons: ${[...cell.reasons.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `"${r}" ×${n}`).join(', ')}.`;
}

function deliveredText(kind: string, delivered: Map<string, number>): string {
  const n = delivered.get(kind) ?? 0;
  if (n === 0) return '';
  return ` The same kind recorded ${n} answered request(s) in the window — the channel has delivered for this producer before.`;
}

const CLASS_LABEL: Record<CommsRequestCellClass, string> = {
  'unanswered': 'unanswered',
  'never-sent': 'unsent',
  'send-failures': 'on send failures',
  'unclassified': 'with an unrecognized reason',
};

function classNote(cell: CommsRequestCell): string {
  switch (cell.cls) {
    case 'unanswered':
      return 'each was marked sent — dispatch delivered it into the single outstanding slot — then expired unanswered when its TTL lapsed. Mason either never saw it, chose not to answer, or the reply path dropped it; the store records only the terminal state';
    case 'never-sent':
      return 'each stayed pending until its TTL lapsed — the single outstanding question slot and the question cooldown meant later requests queued behind whatever held the slot, or the dispatch cycle was not running';
    case 'send-failures':
      return 'each was a pending report the transport rejected until noteSendFailure retired it — the iMessage or Telegram send path kept refusing, and one failing report stops the report batch for the cycle';
    case 'unclassified':
      return 'each carries an expiredReason outside the writer\'s current vocabulary — a newer expireRequestsWhere caller or migration this fold does not know; the recorded reason is quoted verbatim';
  }
}

function cellTitle(cell: CommsRequestCell): string {
  const cls = CLASS_LABEL[cell.cls];
  return `Comms '${fieldText(cell.kind)}' requests keep expiring ${cls} — ${cell.rows} request(s) across ${cell.days.size} day(s)`.slice(0, MAX_TITLE_CHARS);
}

function cellPrompt(cell: CommsRequestCell, delivered: Map<string, number>, truncated: boolean, invalidRows: number): string {
  const label = kindLabel(cell);
  const cls = CLASS_LABEL[cell.cls];
  return [
    `Phantom's comms request store shows kind ${label} requests expiring ${cls} — the self-improvement work this backlog exists for.`,
    '',
    `Inside the 7-day window the store recorded ${cell.rows} expired '${fieldText(cell.kind)}' request row(s)${cell.cls === 'unclassified' ? ` with reason '${fieldText(cell.reasonKey)}'` : ''} across ${cell.days.size} distinct UTC day(s).${spanText(cell)} Types: ${typeText(cell)}.${reasonText(cell)}${coverageNote(truncated, invalidRows)}`,
    '',
    `${classNote(cell)}.${deliveredText(cell.kind, delivered)}`,
    '',
    EVIDENCE,
    '',
    `Find why these requests keep expiring instead of completing: for 'unanswered', check whether the ask kind is correctly owner-gated or should be self-answered/deduped at its producer (merge-requests.ts, handlers.ts, leader-apply.ts, change-digest.ts), and whether the reply path is delivering Mason's answers back; for 'never-sent', check the single outstanding slot and question cooldown in dispatch.ts plus producer volume; for 'send-failures', check the configured channel's transport and credentials handling; for 'unclassified', find the expireRequestsWhere caller that wrote the reason. Fix the cause in this repository rather than suppressing the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function commsRequestCellItem(cell: CommsRequestCell, delivered: Map<string, number>, repo: string, truncated: boolean, invalidRows: number): CloudBacklogItem {
  return {
    id: `commsreq-${sha(`commsreq:${cell.key}`)}`,
    title: cellTitle(cell),
    prompt: cellPrompt(cell, delivered, truncated, invalidRows),
    area: 'comms-requests',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the comms request store's recurring expiry cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function commsRequestsBacklogItems(opts: CommsRequestsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const path = opts.requestsPath ?? join(opts.homeDir ?? homedir(), '.ashlr', 'comms', 'requests.jsonl');
    if (typeof path !== 'string' || path === '') return [];
    const read = await readLedgerTail(path, COMMS_REQUESTS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const parsed = parseCommsRequestText(read.text);
    const nowMs = (opts.now ?? new Date()).getTime();
    const folded = foldCommsRequestCells(parsed.rows, nowMs, opts.windowMs ?? COMMS_REQUESTS_WINDOW_MS);
    const limit = Math.max(1, Math.min(opts.limit ?? COMMS_REQUESTS_BACKLOG_MAX_ITEMS, COMMS_REQUESTS_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      if (items.length >= limit) break;
      items.push(commsRequestCellItem(cell, folded.delivered, repo, read.truncated, parsed.invalidRows));
    }
    return items;
  } catch {
    return [];
  }
}
