/**
 * Slack bridge OUTBOUND backlog feed — folds the outbound observation
 * journal's recurring adverse evidence into user-backlog items.
 *
 * Writer contract (src/core/agents/slack-outbound.ts):
 *  - `<runs>/slack-bridge/outbound.jsonl` is a bounded (256 KiB, ~192 KiB
 *    whole-row retention) append-only journal beside the inbound
 *    journal.jsonl. Two row kinds:
 *      { at, kind: 'delivery', status, reason?, topic?, envelopeId? }
 *        one row per deliverSlackEnvelope outcome — 'sent',
 *        'duplicate', 'uncertain' or 'refused' with the transport's
 *        static reason code — written by the deliverSlackEnvelope
 *        wrapper in src/core/agents/slack-transport.ts on EVERY
 *        outcome, including refusals that never reach the send store.
 *      { at, kind: 'notice-pass', status, reason?, planned?, sent?,
 *        failed?, skipped? }
 *        one row per claim-notice pass the channels slack run tick
 *        executed — 'completed', 'dry-run', the four unavailable
 *        halts, or 'error' when the pass threw — written by
 *        createClaimNoticeTick in src/cli/channels-slack-claim-tick.ts.
 *  - Rows carry ids, timestamps, closed status vocabularies, static
 *    reason codes, the bus topic and pass tallies only — never message
 *    text, tokens or credential references.
 *
 * Honesty rules:
 *  - Bounded reads only: readSlackOutboundJournal validates every
 *    retained row against the writer contract and reports 'missing',
 *    'ok' or 'degraded'; a degraded read still folds its valid rows
 *    and marks every emitted item so counts read as a recorded floor.
 *  - Recurrence bars: a cell emits only at SLACK_OUTBOUND_MIN_ROWS
 *    adverse rows AND SLACK_OUTBOUND_MIN_DAYS distinct UTC days AND
 *    SLACK_OUTBOUND_MIN_EVENTS distinct event identities inside the
 *    window — one retried send or one bad afternoon is not a pattern.
 *    Delivery event identity prefers the envelope id (a redelivered
 *    send re-journals under the same id); notice passes have no id, so
 *    each pass row's own timestamp is its identity.
 *  - Healthy outcomes never emit: 'sent' and 'duplicate' deliveries,
 *    'dry-run' passes and 'completed' passes with failed = 0 count as
 *    context only — the channel working is not backlog work.
 *  - The journal describes this install's Slack bridge — the mapped
 *    topics, the send store and the claim-notice state are local with
 *    no repository column — so like the sibling fleet-evidence feeds,
 *    items emit only when the backlog target's repository name is
 *    'phantom'.
 *  - Reason strings, statuses and topics are quoted as recorded,
 *    scrubbed, flattened and capped; envelope ids are never quoted —
 *    the journal keeps them for event identity only.
 *  - Dedup is downstream. The item id hashes the cell identity
 *    (kind + status + reason key + topic + repository — never the
 *    counts or timestamps), so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a cell that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, the no-change escape names transient
 *    incidents, deliberate config and owner-side causes, and the
 *    brief carries the reproduce steps.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { readSlackOutboundJournal, type SlackOutboundRow } from '../agents/slack-outbound.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is kind × status × reason × topic. */
export const SLACK_OUTBOUND_BACKLOG_MAX_ITEMS = 8;
const SLACK_OUTBOUND_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const SLACK_OUTBOUND_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const SLACK_OUTBOUND_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a cell needs inside the window before its recurrence counts. */
export const SLACK_OUTBOUND_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const SLACK_OUTBOUND_MIN_DAYS = 2;
/** Distinct event identities those rows must span — one retried send is one event. */
export const SLACK_OUTBOUND_MIN_EVENTS = 2;
/** The fleet's own repository label: the journal describes this install's bridge, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/**
 * The reader's entry cap: readSlackOutboundJournal keeps the newest
 * `limit` validated entries (hard max 4096). The journal file itself is
 * capped at 256 KiB — roughly 192 KiB of retained whole rows — so 4096
 * always covers the whole retained window.
 */
const SLACK_OUTBOUND_READ_LIMIT = 4096;
/** Quoted topic cap — bus topics are short tokens; anything longer is off-contract anyway. */
const MAX_TOPIC_CHARS = 60;
/** Reason text quoted inside cells: scrubbed, flattened, capped. */
const MAX_REASON_CHARS = 80;

export type SlackOutboundCellKind =
  | 'delivery-uncertain'
  | 'delivery-refused'
  | 'notice-pass-halted'
  | 'notice-pass-degraded';

export interface SlackOutboundItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet install only. */
  repo: string;
  /** Runs dir for the journal; $ASHLR_RUNS_DIR wins when set (the reader's own resolution). */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default SLACK_OUTBOUND_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated journal row folded to its window position and cell identity. */
interface SlackOutboundFoldRow {
  atMs: number;
  utcDay: string;
  kind: SlackOutboundCellKind;
  /** Journal row's own status — 'uncertain'/'refused' or the pass status. */
  status: string;
  /** Normalized reason key — 'unrecorded' when the row carried none. */
  reasonKey: string;
  /** Reason text quoted in prompts — null when absent or empty. */
  reasonText: string | null;
  /** Sanitized bus topic for delivery cells, 'unknown' when absent. */
  topic: string;
  /** Stable event identity for the distinct-event bar. */
  eventKey: string;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** Topic text as recorded: the reader already enforces bounded control-free strings; scrub and cap before quoting. */
function cleanTopic(value: string | undefined): string {
  if (value === undefined || value === '') return 'unknown';
  const cleaned = scrubSecrets(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? 'unknown' : cleaned.slice(0, MAX_TOPIC_CHARS);
}

/** Reason text for quoting: scrubbed, flattened, capped; 'unrecorded' when absent or empty. */
function cleanReason(value: string | undefined): { key: string; text: string | null } {
  if (value === undefined) return { key: 'unrecorded', text: null };
  const cleaned = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return { key: 'unrecorded', text: null };
  const capped = cleaned.slice(0, MAX_REASON_CHARS);
  return { key: capped.toLowerCase(), text: capped };
}

/** Pass statuses that mean the pass never ran its plan — halts and throws. */
const HALTED_PASS_STATUSES: ReadonlySet<string> = new Set([
  'board-unavailable', 'ledger-unavailable', 'bindings-unavailable', 'prev-unavailable', 'error',
]);

/**
 * Pure: classify one validated journal entry into its cell kind, or null
 * for context rows (healthy deliveries and clean passes). The entry
 * already satisfies the journal's own contract — this fold only decides
 * which cells its evidence feeds.
 */
export function slackOutboundRowKind(entry: SlackOutboundRow): { kind: SlackOutboundCellKind; status: string } | null {
  if (entry.kind === 'delivery') {
    // 'sent' and 'duplicate' are proved outcomes; only unproved and
    // refused sends are adverse evidence.
    if (entry.status === 'uncertain') return { kind: 'delivery-uncertain', status: entry.status };
    if (entry.status === 'refused') return { kind: 'delivery-refused', status: entry.status };
    return null;
  }
  if (entry.kind === 'notice-pass') {
    if (HALTED_PASS_STATUSES.has(entry.status)) return { kind: 'notice-pass-halted', status: entry.status };
    // A completed pass is degraded only when it recorded failed notices
    // or ledger/snapshot writes; failed = 0 (and dry-run) is context.
    if (entry.status === 'completed' && (entry.failed ?? 0) > 0) {
      return { kind: 'notice-pass-degraded', status: entry.status };
    }
    return null;
  }
  return null;
}

/**
 * Pure: fold one validated journal entry into a row, or null when it is
 * context or outside the window.
 */
export function slackOutboundFoldRow(
  entry: SlackOutboundRow,
  opts: { nowMs: number; windowMs?: number },
): SlackOutboundFoldRow | null {
  const atMs = Date.parse(entry.at);
  if (!Number.isFinite(atMs)) return null;
  const windowMs = opts.windowMs ?? SLACK_OUTBOUND_WINDOW_MS;
  if (atMs < opts.nowMs - windowMs || atMs > opts.nowMs + SLACK_OUTBOUND_FUTURE_SKEW_MS) return null;
  const classified = slackOutboundRowKind(entry);
  if (classified === null) return null;
  const reason = cleanReason(entry.reason);
  const topic = entry.kind === 'delivery' ? cleanTopic(entry.topic) : 'fleet-claim-notices';
  // Delivery retries of the same envelope re-journal under the same id —
  // collapse them to one event like the inbound fold's message identity.
  // Pass rows carry no id: each executed pass is its own event.
  const eventKey = entry.kind === 'delivery'
    ? `delivery|${entry.envelopeId ?? entry.at}`
    : `notice-pass|${entry.at}`;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    kind: classified.kind,
    status: classified.status,
    reasonKey: reason.key,
    reasonText: reason.text,
    topic,
    eventKey,
  };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal's retained entries
// ---------------------------------------------------------------------------

export interface SlackOutboundFold {
  /** In-window on-contract entries the reader returned. */
  entries: number;
  /** In-window entries that classified as context (healthy outcomes). */
  contextRows: number;
  /** Entries outside the window — the reader guarantees a parseable `at`, so this is window overflow only. */
  outsideWindow: number;
  /** True when the journal read reported damaged lines — counts are a recorded floor. */
  degraded: boolean;
  /** Adverse cells keyed `${kind}${status}${reasonKey}${topic}`. */
  cells: Map<string, {
    kind: SlackOutboundCellKind;
    status: string;
    reasonKey: string;
    reasonText: string | null;
    topic: string;
    rows: number;
    days: Set<string>;
    events: Set<string>;
    /** Pass tallies summed across the cell's rows; null when no row carried counts. */
    planned: number | null;
    sent: number | null;
    failed: number | null;
    skipped: number | null;
    firstMs: number;
    lastMs: number;
  }>;
}

/**
 * Pure: fold validated journal entries into adverse cells. Only rows
 * inside the window join cells; context rows count toward the quoted
 * totals. Cell keys are `${kind}${status}${reasonKey}${topic}`.
 */
export function foldSlackOutboundEntries(
  entries: readonly SlackOutboundRow[],
  opts: { nowMs: number; windowMs?: number; degraded?: boolean },
): SlackOutboundFold {
  const fold: SlackOutboundFold = {
    entries: 0, contextRows: 0, outsideWindow: 0, degraded: opts.degraded === true,
    cells: new Map(),
  };
  const windowMs = opts.windowMs ?? SLACK_OUTBOUND_WINDOW_MS;
  for (const entry of entries) {
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs)) continue;
    if (atMs < opts.nowMs - windowMs || atMs > opts.nowMs + SLACK_OUTBOUND_FUTURE_SKEW_MS) {
      fold.outsideWindow += 1;
      continue;
    }
    fold.entries += 1;
    const row = slackOutboundFoldRow(entry, opts);
    if (row === null) { fold.contextRows += 1; continue; }
    const key = `${row.kind}${row.status}${row.reasonKey}${row.topic}`;
    let cell = fold.cells.get(key);
    if (cell === undefined) {
      cell = {
        kind: row.kind, status: row.status, reasonKey: row.reasonKey, reasonText: row.reasonText,
        topic: row.topic, rows: 0, days: new Set(), events: new Set(),
        planned: null, sent: null, failed: null, skipped: null,
        firstMs: row.atMs, lastMs: row.atMs,
      };
      fold.cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.events.add(row.eventKey);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
    if (cell.reasonText === null && row.reasonText !== null) cell.reasonText = row.reasonText;
    // Pass tallies accumulate only from notice-pass rows; delivery rows
    // carry none, so a mixed key can never occur — kind fixes the source.
    if (entry.kind === 'notice-pass') {
      const add = (slot: 'planned' | 'sent' | 'failed' | 'skipped', value: number | undefined): void => {
        if (value === undefined) return;
        cell[slot] = (cell[slot] ?? 0) + value;
      };
      add('planned', entry.planned);
      add('sent', entry.sent);
      add('failed', entry.failed);
      add('skipped', entry.skipped);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface SlackOutboundCell {
  kind: SlackOutboundCellKind;
  /** Journal row status — 'uncertain'/'refused' or the pass halt/completed status. */
  status: string;
  /** Normalized reason key — 'unrecorded' when no row carried a reason. */
  reasonKey: string;
  /** The first recorded reason text, bounded — null when unrecorded. */
  reasonText: string | null;
  /** Bus topic for delivery cells; 'fleet-claim-notices' for pass cells. */
  topic: string;
  /** In-window adverse rows. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Distinct event identities the rows span — retried sends collapse to one. */
  events: number;
  /** In-window on-contract entries overall — the context denominator. */
  records: number;
  /** In-window context rows — proved sends and clean passes. */
  context: number;
  /** Summed pass tallies; each null when no row in the cell carried it. */
  planned: number | null;
  sent: number | null;
  failed: number | null;
  skipped: number | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal read was degraded: damaged lines were dropped, counts are a recorded floor. */
  degraded: boolean;
}

const isoOrNull = (ms: number): string | null => new Date(ms).toISOString();

/**
 * Pure: recurring cells — a cell emits at the row, day and distinct-event
 * bars. Sorted by rows desc, then kind, status, topic and reason for a
 * stable order.
 */
export function slackOutboundCells(fold: SlackOutboundFold): SlackOutboundCell[] {
  const cells: SlackOutboundCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < SLACK_OUTBOUND_MIN_ROWS) continue;
    if (cell.days.size < SLACK_OUTBOUND_MIN_DAYS) continue;
    if (cell.events.size < SLACK_OUTBOUND_MIN_EVENTS) continue;
    cells.push({
      kind: cell.kind,
      status: cell.status,
      reasonKey: cell.reasonKey,
      reasonText: cell.reasonKey === 'unrecorded' ? null : cell.reasonText,
      topic: cell.topic,
      rows: cell.rows,
      days: [...cell.days].sort(),
      events: cell.events.size,
      records: fold.entries,
      context: fold.contextRows,
      planned: cell.planned,
      sent: cell.sent,
      failed: cell.failed,
      skipped: cell.skipped,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      degraded: fold.degraded,
    });
  }
  return cells.sort((a, b) =>
    b.rows - a.rows || a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status)
    || a.topic.localeCompare(b.topic) || a.reasonKey.localeCompare(b.reasonKey));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/slack-bridge/outbound.jsonl — recordSlackOutbound in src/core/agents/slack-outbound.ts appends one metadata-only row per outcome: the deliverSlackEnvelope wrapper in src/core/agents/slack-transport.ts journals every send as {at, kind: \'delivery\', status: \'sent\'|\'duplicate\'|\'uncertain\'|\'refused\', reason?, topic?, envelopeId?} — including refusals that never reach the send store — and createClaimNoticeTick in src/cli/channels-slack-claim-tick.ts journals each claim-notice pass as {at, kind: \'notice-pass\', status, reason?, planned?, sent?, failed?, skipped?}. The file is capped at 256 KiB with ~192 KiB of whole-row retention and never holds message text, tokens or credential references. Until this feed the only durable outbound evidence was the send store\'s attempted→sent lifecycle (readSlackSendReceipts, surfaced as unconfirmed sends by the unified inbox and slack status) — terminal refusals, unproved sends and pass halts lived only in session memory.';

const REPRO = 'Reproduce the fold by reading <runs dir>/slack-bridge/outbound.jsonl directly, keeping rows that satisfy the journal contract ({at parseable, kind in delivery|notice-pass, status inside its kind\'s closed vocabulary, optional fields well-formed}) whose `at` lands inside the window, treating sent/duplicate deliveries, dry-run passes and completed passes with failed = 0 as context, and folding the rest by (kind, status, reason, topic for deliveries / status, reason for passes). The writers and their gates are src/core/agents/slack-outbound.ts, src/core/agents/slack-transport.ts (deliverSlackEnvelope, slackOutboundPlan and evaluateSlackAudience in src/core/agents/slack-audience.ts) and src/core/cli/channels-slack-claim-tick.ts; the send store is <state>/fleet/slack-transport/messages.json; the claim-notice state lives under the runs root\'s claim-notice files.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient Slack or network incident the later rows recovered from, the refusals or halts reflect deliberate config (bridge disabled, kill switch, audience or topic mappings intentionally closed, claim notices baselining), or this checkout is not the fleet install the journal describes — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: SlackOutboundCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const degradedText = (cell: SlackOutboundCell): string =>
  cell.degraded ? ' The journal read reported damaged lines, so these counts cover only the retained valid rows — a recorded floor, not the full stream.' : '';

const WINDOW_DAYS = Math.round(SLACK_OUTBOUND_WINDOW_MS / 86_400_000);

const KIND_TITLE: Record<SlackOutboundCellKind, string> = {
  'delivery-uncertain': 'Slack sends keep ending unproved',
  'delivery-refused': 'Slack sends keep being refused',
  'notice-pass-halted': 'claim-notice passes keep halting before planning',
  'notice-pass-degraded': 'claim-notice passes keep completing with failed notices',
};

const reasonBit = (cell: SlackOutboundCell): string =>
  cell.reasonKey === 'unrecorded' || cell.reasonText === null
    ? ''
    : ` The recorded reason — '${cell.reasonText.slice(0, 120)}' — is quoted as recorded.`;

const KIND_FIND: Record<SlackOutboundCellKind, string> = {
  'delivery-uncertain':
    `Find why Slack deliveries keep ending 'uncertain' on bus topic ${'{topic}'}: each row is one deliverSlackEnvelope outcome the transport could not prove — 'transport-or-storage-unavailable' means the send store, lock or Slack call threw, 'delivery-needs-reconciliation' means an earlier ambiguous post could not be matched to exactly one channel message on the full history scan, and 'delivery-response-unproved' means chat.postMessage returned without a verifiable channel/ts pair. Check the send store (<state>/fleet/slack-transport/messages.json) for 'attempted' receipts that never reached 'sent' — phm channels slack status reports them as uncertainSends and phm fleet slack-trace binds replies — the Slack credential and socket health, and whether the failures cluster on one topic (a poisoned envelope) or spread across the fleet. The transport, the journal and the fold are this repository's own; Slack's service and the workspace config are owner-side — name them rather than working around them.`,
  'delivery-refused':
    `Find why Slack deliveries keep being refused on bus topic ${'{topic}'}: each row is one deliverSlackEnvelope outcome stopped before any post — plan refusals (invalid-envelope, private-source, own-bridge, external-envelope, unmapped-topic, foreign-thread-ref, unsupported-body-kind, empty-text, oversize-text, secret-shaped-text), lock and store refusals (delivery-claimed, delivery-store-full, message-identity-conflict, invalid-message-lifetime), policy refusals (policy-changed-or-session-expired, audience-unproved and the SlackAudienceRefusal/Uncertainty codes, communication-not-approved) and session-expired. The recorded reason is quoted bounded in the evidence — start there: an audience or policy refusal recurring on one topic usually means the channel mapping or the confirmedByMason gate drifted, while store and lock refusals point at this host's send-store custody. Check slackOutboundPlan and evaluateSlackAudience in src/core/agents/slack-audience.ts, the [team] allowlist and [[slack.map]] bindings in the bridge config, and the send store's lock state. The gates are this repository's own; the allowlist and approvals are owner config.`,
  'notice-pass-halted':
    `Find why claim-notice passes keep halting on the channels slack run tick: each row is one pass outcome that never reached its plan — 'board-unavailable' (the fleet board state could not be read), 'ledger-unavailable' (the sent ledger was unreadable), 'bindings-unavailable' (claim bindings were unreadable), 'prev-unavailable' (the previous snapshot was unreadable) or 'error' (the pass threw). The recorded reason and pass status are quoted as recorded. A recurring halt means claim notices silently stopped flowing while the run loop looked healthy — check the claim-notice state files under the runs root (board snapshot, claim-notice-sent.jsonl, bindings, prev snapshot), their custody and lock state, and whether a single corrupt file is wedging every pass. The pass, the tick and the journal are this repository's own; the state files' corruption cause may be owner-side disk or an interrupted writer — name it rather than working around it.`,
  'notice-pass-degraded':
    `Find why claim-notice passes keep completing with failed notices: each row is one pass that ran its plan but recorded failed sends, ledger appends or a failed snapshot write — the quoted tallies (planned/sent/failed/skipped, summed across the cell's rows) show whether the losses are delivery failures (send-threw, policy refusals downstream in deliverSlackEnvelope) or durability failures (ledger-append-failed, snapshot-write-failed). Check the pass's delivery outcomes against the delivery cells this same journal records — a pass failing because every send is refused shows up here AND as delivery-refused cells — then the sent ledger append path and the snapshot write in src/core/fleet/claim-notice-send.ts. The pass and its state files are this repository's own; upstream Slack health is covered by the delivery cells.`,
};

/** Id-safe fragment: backlog ids admit [A-Za-z0-9._-] only and cap at 120 chars total. */
const idSafe = (value: string, cap: number): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, cap) || 'unknown';

const talliesText = (cell: SlackOutboundCell): string => {
  if (cell.kind !== 'notice-pass-halted' && cell.kind !== 'notice-pass-degraded') return '';
  const parts: string[] = [];
  if (cell.planned !== null) parts.push(`${cell.planned} planned`);
  if (cell.sent !== null) parts.push(`${cell.sent} sent`);
  if (cell.failed !== null) parts.push(`${cell.failed} failed`);
  if (cell.skipped !== null) parts.push(`${cell.skipped} skipped`);
  return parts.length === 0 ? '' : ` Pass tallies across the cell's rows: ${parts.join(', ')}.`;
};

function slackOutboundItem(cell: SlackOutboundCell, repo: string): CloudBacklogItem {
  const kind = cell.kind;
  const isPass = kind === 'notice-pass-halted' || kind === 'notice-pass-degraded';
  const subject = isPass
    ? `claim-notice passes (status '${cell.status}'${cell.reasonKey === 'unrecorded' ? '' : `, reason '${cell.reasonKey}'`})`
    : `Slack sends on bus topic ${cell.topic}`;
  const reason = reasonBit(cell);
  // The hash covers the full cell identity (kind + status + reason key +
  // topic + repo); the readable fragments are bounded so the id stays
  // inside ID_RE's 120-char cap even for max-length fields.
  const hash = createHash('sha256')
    .update(`slack-outbound:${repo.trim().toLowerCase()}:${kind}:${cell.status}:${cell.reasonKey}:${cell.topic}`)
    .digest('hex').slice(0, 16);
  const id = `slack-outbound-${kind}-${idSafe(cell.status, 20)}-${idSafe(cell.topic, 20)}-${idSafe(cell.reasonKey, 20)}-${hash}`;
  // The title carries the discriminators because appendUserBacklogItems
  // dedupes on the normalised title — two topics or reasons failing the
  // same way are two items, not one.
  const titleTopic = isPass ? `status ${cell.status}` : cell.topic;
  const titleReason = cell.reasonKey === 'unrecorded' || cell.reasonText === null
    ? '' : ` — '${cell.reasonText.slice(0, 60)}'`;
  const prompt = [
    `Phantom's Slack outbound journal keeps recording ${KIND_TITLE[kind]} — ${cell.rows} adverse row(s) across ${cell.events} distinct event(s) and ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window on ${subject}, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one journaled outcome for ${subject}.${reason}${talliesText(cell)}${seenText(cell)} ${cell.context} in-window row(s) recorded proved sends or clean passes as context.${degradedText(cell)}`,
    '',
    EVIDENCE,
    '',
    KIND_FIND[kind].replace('{topic}', cell.topic),
    '',
    `If the window has rolled forward, the failures were a transient Slack, network or host incident the later rows recovered from, the refusals or halts reflect deliberate config (bridge disabled, kill switch, audience or topic mappings intentionally closed, claim notices baselining), or this checkout is not the fleet install the journal describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: `Slack outbound ${titleTopic}: ${KIND_TITLE[kind]}${titleReason}`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `slack-outbound-${kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the Slack outbound journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function slackOutboundBacklogItems(opts: SlackOutboundItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    // The journal describes this install's bridge configuration and
    // carries no repository column — like the sibling fleet-evidence
    // feeds, only the fleet's own repository inherits the items.
    if (fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    // readSlackOutboundJournal resolves <runsDir>/slack-bridge/outbound.jsonl
    // itself; runsDir honors $ASHLR_RUNS_DIR over homeDir, matching the
    // reader's own precedence.
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
    const read = readSlackOutboundJournal({ runsDir, limit: SLACK_OUTBOUND_READ_LIMIT });
    if (read.state === 'missing' || read.entries.length === 0) return [];
    const fold = foldSlackOutboundEntries(read.entries, { nowMs, degraded: read.state === 'degraded' });
    const cells = slackOutboundCells(fold);
    const limit = Math.max(1, Math.min(opts.limit ?? SLACK_OUTBOUND_BACKLOG_MAX_ITEMS, SLACK_OUTBOUND_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => slackOutboundItem(cell, repo));
  } catch {
    return [];
  }
}
