/**
 * <runs>/leader/delivery-receipts.jsonl owner-thread delivery receipts →
 * self-improvement backlog items.
 *
 * Every `sendOwnerReply` fanout — `phm comms send-owner`, the MCP send
 * tool, the leader-live notices and any other caller of the guarded reply
 * path in src/core/comms/owner-thread.ts — appends one receipt row per
 * destination channel to this append-only file under the owner runs
 * dir's `leader/` folder (recordDelivery in
 * src/core/leader/delivery-receipts.ts):
 *
 *   { messageId: 'm<seq>', channel: <owner channel>, state:
 *     'delivered' | 'pending' | 'failed', reason?: <scrubbed, ≤160>,
 *     at: <ISO-8601> }
 *
 * 'failed' covers every non-delivered fanout row — a transport refusal or
 * throw ('Channel transport refused the owner reply.'), a configured
 * channel with no transport attached ('No transport is attached for this
 * channel.'), the owner-policy gate ('Replies only go to the confirmed
 * owner.') and the designed holds (KILL/pause and unconfigured adapters,
 * which write the adapterStatus reasons). Rows written before the `at`
 * stamp existed carry no timestamp and stay undated evidence.
 *
 * Until now the ledger's only reader was readReceipts — the point-in-time
 * "latest receipt per channel for these message ids" lookup behind
 * `phm comms thread`'s per-channel marks and the undelivered-replies
 * read — so a channel whose deliveries kept failing never became work.
 * deliveryReceiptsBacklogItems carries the ledger into discoverBacklog:
 *
 *  - failed-delivery cells per (channel, signal): the live transport
 *    keeps refusing or throwing, a channel keeps running with no
 *    transport attached, the owner-policy gate keeps refusing a
 *    configured channel, or a failed row carries a reason outside the
 *    writer's current vocabulary ('unclassified', quoted bounded). The
 *    designed holds — KILL, comms pause and the unconfigured-adapter
 *    reasons — never emit: they are operator state, not breakage.
 *  - The read mirrors the writer's own reader exactly: the newest
 *    DELIVERY_RECEIPTS_TAIL_BYTES via readLedgerTail's bounded no-follow
 *    tail, then the newest MAX_READ_LINES non-blank lines — the same
 *    window readReceipts sees. Lines the byte tail cut and lines the
 *    line cap drops are stated as lower bounds, never hidden.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once; nothing is written and no lock,
 *    process or network is touched. A missing or unreadable file yields
 *    no items; a malformed line is skipped, never guessed.
 *  - Rows count only under the writer's contract: a non-empty bounded
 *    messageId, a channel in the owner-channel vocabulary, the closed
 *    state vocabulary, an optional scrubbed reason, and `at` a parseable
 *    ISO timestamp when present. Dated rows window on `at`; undated
 *    legacy rows are counted as context but can never join a cell —
 *    they have no window position.
 *  - Recurring means recorded across days AND across sends: a cell emits
 *    at DELIVERY_RECEIPTS_MIN_ROWS adverse rows across
 *    DELIVERY_RECEIPTS_MIN_DAYS distinct UTC days inside the window AND
 *    DELIVERY_RECEIPTS_MIN_MESSAGES distinct message ids — a retried
 *    reply re-records the same message's receipts, so one message's
 *    retry storm is one send, not recurrence.
 *  - The ledger carries no repository column — it describes this
 *    install's comms machinery — so like the custody, self-tick and
 *    launch-cost feeds, items emit only when the backlog's repo name is
 *    the fleet's own; another repository inherits nothing.
 *  - Message ids and reason text are counted and quoted bounded — never
 *    emitted raw beyond the fixed signal vocabulary.
 *  - Dedup is downstream. The item id hashes the cell identity (channel
 *    + signal + repository — never the counts), so a refresh re-derives
 *    the same ids and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, and the brief names the writer, its callers and
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { realHome } from '../real-home.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is channel × signal. */
export const DELIVERY_RECEIPTS_BACKLOG_MAX_ITEMS = 8;
const DELIVERY_RECEIPTS_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const DELIVERY_RECEIPTS_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const DELIVERY_RECEIPTS_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a cell needs inside the window before its recurrence counts. */
export const DELIVERY_RECEIPTS_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const DELIVERY_RECEIPTS_MIN_DAYS = 2;
/** Distinct message ids those rows must span — one retried reply is one send. */
export const DELIVERY_RECEIPTS_MIN_MESSAGES = 2;
/** The fleet's own repository label: the ledger describes this install's comms, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The ledger filename inside the owner runs dir's leader/ folder — the writer's fileOf. */
const LEDGER_FILE = 'delivery-receipts.jsonl';
/**
 * The writer's own read bounds, duplicated rather than imported from
 * src/core/leader/delivery-receipts.ts so the comms module stays out of
 * this feed's Tier-1 import closure — if the reader's bounds move, move
 * these with them: tailLines reads the newest MAX_READ_BYTES (256 KiB)
 * and keeps the newest MAX_READ_LINES (500) non-blank lines.
 */
export const DELIVERY_RECEIPTS_TAIL_BYTES = 256 * 1024;
export const DELIVERY_RECEIPTS_MAX_LINES = 500;

/**
 * The writer's channel vocabulary — OwnerChannel in
 * src/core/comms/leader-mailbox.ts, duplicated for the same closure
 * reason as the read bounds. recordDelivery's channel parameter is typed
 * string, so a row outside this set is off-contract.
 */
const CHANNELS = new Set(['desktop', 'telegram', 'email', 'imessage', 'slack']);
const CHANNEL_LABEL: Record<string, string> = {
  desktop: 'Desktop', telegram: 'Telegram', email: 'Email', imessage: 'iMessage', slack: 'Slack',
};
const STATES = new Set(['delivered', 'pending', 'failed']);
type ReceiptState = 'delivered' | 'pending' | 'failed';

/**
 * The failed-receipt reason → cell signal map, keyed on the exact fixed
 * strings owner-thread.ts's delivery rows carry. Duplicated for the same
 * closure reason as the bounds — if the writer's reason vocabulary
 * moves, move this with it.
 */
const SIGNAL_BY_REASON: Record<string, DeliverySignal> = {
  'Channel transport refused the owner reply.': 'transport-refused',
  'No transport is attached for this channel.': 'no-transport',
  'Replies only go to the confirmed owner.': 'owner-policy',
};
/**
 * Failed-receipt reasons that are designed operator state, never
 * breakage: the KILL/pause holds and the unconfigured-adapter gate
 * reasons adapterStatus (src/core/comms/owner-channel.ts) emits. A cell
 * never forms on these.
 */
const DESIGNED_REASONS = new Set([
  'Kill switch halted this adapter.',
  'Communications are paused.',
  'Disabled until an owner identity is configured.',
  'Disabled until the Phantom Secrets handle is named.',
  'iMessage is loopback-only and stays disabled until the local bridge is selected.',
]);

export type DeliverySignal = 'transport-refused' | 'no-transport' | 'owner-policy' | 'unclassified';

export interface DeliveryReceiptsItemsOptions {
  /** Backlog target in owner/name form; the ledger describes the fleet install only. */
  repo: string;
  /** Ledger override (default: join(fixedOwnerRunsDir(), 'leader', 'delivery-receipts.jsonl')). */
  journalPath?: string;
  /** Runs dir for the ledger default; the writer's fixedOwnerRunsDir ignores ASHLR_RUNS_DIR. */
  runsDir?: string;
  /** Home for the default runs dir (default: realHome() then os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default DELIVERY_RECEIPTS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated ledger row. */
export interface DeliveryReceiptRow {
  /** The outbound message's id — counted, never emitted. */
  messageId: string;
  channel: string;
  state: ReceiptState;
  /** The scrubbed reason text, bounded; null when the row carries none. */
  reason: string | null;
  /** Window position; null on rows written before the `at` stamp existed. */
  atMs: number | null;
  utcDay: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
   * Pure: classify one failed row's reason into its cell signal. Exact
   * matches only — the writer's vocabulary is closed fixed strings;
   * designed holds return null, anything else is 'unclassified' so a
   * vocabulary drift still surfaces as evidence instead of vanishing.
   */
export function deliveryFailureSignal(reason: string | null): DeliverySignal | null {
  if (reason === null) return 'unclassified';
  if (DESIGNED_REASONS.has(reason)) return null;
  return SIGNAL_BY_REASON[reason] ?? 'unclassified';
}

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract — recordDelivery emits {messageId, channel, state, at,
 * reason?}: a bounded non-empty messageId, a channel in the owner-channel
 * vocabulary, the closed state vocabulary, an optional reason string, and
 * `at` a parseable ISO timestamp when present (absent = undated legacy
 * row). Anything else is not a ledger row; extra fields are ignored for
 * forward compatibility.
 */
export function parseDeliveryReceiptJournalEntry(value: unknown): DeliveryReceiptRow | null {
  if (!isRecord(value)) return null;
  const messageId = value['messageId'];
  if (typeof messageId !== 'string' || messageId === '' || messageId.length > 200) return null;
  const channel = value['channel'];
  if (typeof channel !== 'string' || !CHANNELS.has(channel)) return null;
  const state = value['state'];
  if (typeof state !== 'string' || !STATES.has(state)) return null;
  const reason = value['reason'];
  if (reason !== undefined && typeof reason !== 'string') return null;
  let atMs: number | null = null;
  let utcDay: string | null = null;
  const at = value['at'];
  if (at !== undefined) {
    // The writer stamps new Date().toISOString(); require the ISO shape so
    // a hand-edited or foreign date string cannot claim a window position.
    const parsed = typeof at === 'string' && at.includes('T') ? Date.parse(at) : NaN;
    if (!Number.isFinite(parsed)) return null;
    atMs = parsed;
    utcDay = utcDayOf(parsed);
  }
  return {
    messageId, channel, state: state as ReceiptState,
    reason: typeof reason === 'string' && reason !== '' ? reason.slice(0, 200) : null,
    atMs, utcDay,
  };
}

/**
 * Pure: parse one ledger file's text into validated rows plus the count
 * of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed. Mirrors the writer's own
 * reader: only the newest DELIVERY_RECEIPTS_MAX_LINES non-blank lines
 * are kept; `droppedLines` counts the older lines the line cap cut so
 * the fold can state the extra truncation.
 */
export function parseDeliveryReceiptJournal(text: string): { rows: DeliveryReceiptRow[]; invalidRows: number; droppedLines: number } {
  // Same non-blank filter the writer's tailLines applies (filter(Boolean)).
  const lines = text.split('\n').filter((line) => line !== '');
  const kept = lines.slice(-DELIVERY_RECEIPTS_MAX_LINES);
  const droppedLines = lines.length - kept.length;
  const rows: DeliveryReceiptRow[] = [];
  let invalidRows = 0;
  for (const line of kept) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseDeliveryReceiptJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows, droppedLines };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the ledger tail
// ---------------------------------------------------------------------------

export interface DeliveryReceiptsFold {
  /** In-window on-contract dated rows — the share/context denominator. */
  rows: number;
  /** In-window 'delivered' rows — the healthy path, context only. */
  deliveredRows: number;
  /** In-window 'pending' rows — context only; no current writer emits them. */
  pendingRows: number;
  /** In-window 'failed' rows whose reason is a designed hold — context only. */
  designedFailedRows: number;
  /** In-window 'failed' rows by (channel, signal). */
  cells: Map<string, { channel: string; signal: DeliverySignal; rows: number; days: Set<string>; messageIds: Set<string>; firstMs: number; lastMs: number; reasonText: string | null }>;
  /** Dated rows outside the window. */
  outsideWindow: number;
  /** On-contract rows with no `at` — undated legacy evidence, never windowed. */
  undatedRows: number;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
  /** On-contract lines the writer's own line cap cut before parsing. */
  droppedLines: number;
}

/**
 * Pure: fold ledger text into the failed-delivery evidence. Only dated
 * rows inside the window join cells; undated rows, designed holds and
 * non-failed states count as context. Cell keys are `${channel}${signal}`.
 */
export function foldDeliveryReceiptRows(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): DeliveryReceiptsFold {
  const parsed = parseDeliveryReceiptJournal(text);
  const fold: DeliveryReceiptsFold = {
    rows: 0, deliveredRows: 0, pendingRows: 0, designedFailedRows: 0,
    cells: new Map(), outsideWindow: 0, undatedRows: 0,
    invalidRows: parsed.invalidRows, droppedLines: parsed.droppedLines,
  };
  const windowMs = opts.windowMs ?? DELIVERY_RECEIPTS_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + DELIVERY_RECEIPTS_FUTURE_SKEW_MS;

  for (const row of parsed.rows) {
    if (row.atMs === null) { fold.undatedRows += 1; continue; }
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    fold.rows += 1;
    if (row.state === 'delivered') { fold.deliveredRows += 1; continue; }
    if (row.state === 'pending') { fold.pendingRows += 1; continue; }
    const signal = deliveryFailureSignal(row.reason);
    if (signal === null) { fold.designedFailedRows += 1; continue; }
    const key = `${row.channel}${signal}`;
    let cell = fold.cells.get(key);
    if (cell === undefined) {
      cell = { channel: row.channel, signal, rows: 0, days: new Set(), messageIds: new Set(), firstMs: row.atMs, lastMs: row.atMs, reasonText: null };
      fold.cells.set(key, cell);
    }
    cell.rows += 1;
    if (row.utcDay !== null) cell.days.add(row.utcDay);
    cell.messageIds.add(row.messageId);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
    if (cell.reasonText === null && row.reason !== null) cell.reasonText = row.reason;
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface DeliveryReceiptsCell {
  channel: string;
  signal: DeliverySignal;
  /** In-window adverse rows. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Distinct message ids the failures span — retried sends collapse to one. */
  messages: number;
  /** In-window on-contract dated rows overall — the context denominator. */
  records: number;
  /** In-window 'delivered' rows — sends the channels did deliver. */
  deliveredContext: number;
  /** In-window designed-hold failures — context only, never the cause. */
  designedContext: number;
  /** The first adverse row's recorded reason, bounded — 'unclassified' cells only. */
  reasonText: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes or lines: counts are a lower bound. */
  lowerBound: boolean;
}

const isoOrNull = (ms: number): string | null => new Date(ms).toISOString();

/**
 * Pure: recurring cells — a (channel, signal) cell emits at the row,
 * day and distinct-message bars. Sorted by rows desc, then channel and
 * signal for a stable order.
 */
export function deliveryReceiptCells(fold: DeliveryReceiptsFold, lowerBound = false): DeliveryReceiptsCell[] {
  const cells: DeliveryReceiptsCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < DELIVERY_RECEIPTS_MIN_ROWS) continue;
    if (cell.days.size < DELIVERY_RECEIPTS_MIN_DAYS) continue;
    if (cell.messageIds.size < DELIVERY_RECEIPTS_MIN_MESSAGES) continue;
    cells.push({
      channel: cell.channel,
      signal: cell.signal,
      rows: cell.rows,
      days: [...cell.days].sort(),
      messages: cell.messageIds.size,
      records: fold.rows,
      deliveredContext: fold.deliveredRows,
      designedContext: fold.designedFailedRows,
      reasonText: cell.signal === 'unclassified' ? cell.reasonText : null,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) =>
    b.rows - a.rows || a.channel.localeCompare(b.channel) || a.signal.localeCompare(b.signal));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <owner runs dir>/leader/delivery-receipts.jsonl — fixedOwnerRunsDir() in src/core/comms/owner-channel.ts resolves <real home>/.ashlr-runs (realHome(), never $HOME or ASHLR_RUNS_DIR). recordDelivery in src/core/leader/delivery-receipts.ts appends one {messageId, channel, state, reason?, at} row per fanout destination on every sendOwnerReply in src/core/comms/owner-thread.ts — `phm comms send-owner`, the MCP send tool, the leader-live notices (src/core/comms/owner-live-notice.ts) and any other caller of the guarded reply path. Callers fan out to the enabled owner channels (desktop, telegram, email, imessage, slack); a \'failed\' row means that channel\'s delivery did not land — transport refusal or throw, no transport attached, the owner-policy gate, or a designed hold (KILL, comms pause, unconfigured adapter). Its only reader until this feed was readReceipts — the point-in-time latest-receipt-per-channel lookup behind `phm comms thread`\'s marks and the undelivered-replies read — which never folds a recurrence.';

const REPRO = 'Reproduce the fold by reading <owner runs dir>/leader/delivery-receipts.jsonl directly, keeping on-contract rows ({messageId, channel, state, reason?, at} with a bounded messageId, an owner-channel name, the closed state vocabulary and a parseable ISO `at` when present) whose `at` lands inside the window, grouping \'failed\' rows by (channel, reason signal) across distinct UTC days and distinct message ids, and treating the designed hold reasons (KILL, comms pause, unconfigured adapters) as context, never signal. The writer and its fanout gates are src/core/leader/delivery-receipts.ts and src/core/comms/owner-thread.ts; the live transports are src/core/comms/owner-live-transport.ts; the per-channel adapter gates are src/core/comms/owner-channel.ts.';

const NO_CHANGE = 'If the window has rolled forward, the failures were a transient transport or host incident the later rows recovered from, the channel was deliberately held or unconfigured (the designed reasons never emit), the sends now deliver on the default branch, or this checkout is not the fleet install the ledger describes — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: DeliveryReceiptsCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: DeliveryReceiptsCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes or lines, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const WINDOW_DAYS = Math.round(DELIVERY_RECEIPTS_WINDOW_MS / 86_400_000);

const channelName = (channel: string): string => CHANNEL_LABEL[channel] ?? channel;

function contextText(cell: DeliveryReceiptsCell): string {
  const parts: string[] = [];
  if (cell.deliveredContext > 0) parts.push(`${cell.deliveredContext} other in-window row(s) recorded 'delivered', so the send path works for some channels or some sends`);
  if (cell.designedContext > 0) parts.push(`${cell.designedContext} in-window failure(s) carried designed hold reasons (KILL, pause or unconfigured adapters) and never count`);
  return parts.length === 0 ? '' : ` ${parts.join('; ')}.`;
}

const SIGNAL_TITLE: Record<DeliverySignal, string> = {
  'transport-refused': 'owner-thread replies keep being refused by the transport',
  'no-transport': 'owner-thread replies have no transport attached',
  'owner-policy': 'owner-thread replies keep failing the owner check',
  'unclassified': 'owner-thread deliveries keep failing',
};

const SIGNAL_FIND: Record<DeliverySignal, string> = {
  'transport-refused':
    `Find why ${channelName('{channel}')} owner-thread deliveries keep being refused: each 'failed' row is one sendOwnerReply fanout whose live transport returned refused or threw — 'Channel transport refused the owner reply.' is the fixed reason owner-thread.ts records for both. Check the channel's transport in src/core/comms/owner-live-transport.ts and the send it wraps — sendTelegramMessage (src/core/integrations/telegram.ts), the Mail.app outbox (src/core/comms/email-outbox.ts), the iMessage outbox (src/core/comms/imessage-outbox.ts) or the Slack leader path (src/core/agents/slack-leader.ts) — plus the fixed-home re-checks each transport applies (owner id, secret-handle name, channel ref, platform). The transports, the fanout gates and their callers are this repository's own; Mason's accounts, OS permissions and remote services are owner-only — name them rather than working around them.`,
  'no-transport':
    `Find why ${channelName('{channel}')} owner-thread deliveries run with no transport attached: 'No transport is attached for this channel.' means the channel passed the configured-owner and owner-policy gates but options.transports carried no entry for it — liveOwnerTransports (src/core/comms/owner-live-transport.ts) attaches all five channels, so recurring rows mean a caller passed a partial map or the wiring regressed. Check which sendOwnerReply callers build their own transports (src/cli/comms-owner-thread.ts, src/core/mcp-native.ts, src/core/bots/seats.ts, the leader-live notice path) and whether the channel belongs in the map.`,
  'owner-policy':
    `Find why ${channelName('{channel}')} owner-thread deliveries keep failing the owner check: 'Replies only go to the confirmed owner.' fires when checkSendPolicy refuses the recipient set or the configured owner id is not a [team] identity in agent-network.toml — a config drift between owner-adapters.toml's owners map, comms.toml's confirmedByMason and the [mason]/[team] identity lists, not a transport fault. Check src/core/comms/owner-channel.ts's loadOwnerThreadSettings, src/core/agents/channel-policy.ts's checkSendPolicy and the identity rows in ~/.ashlr/agent-network.toml (names only, never values). The gates are this repository's own; the owner identities themselves are owner-only config.`,
  'unclassified':
    `Find why ${channelName('{channel}')} owner-thread deliveries keep failing with a reason outside the writer's current vocabulary — the recorded reason is quoted in the evidence and bounded: a failed receipt is still a delivery that did not land, so treat it as breakage until proven designed. Check whether the reason strings in src/core/comms/owner-thread.ts's delivery rows or src/core/comms/owner-channel.ts's adapterStatus moved, whether a newer writer emits reasons this fold does not know, and whether the channel's transport path (src/core/comms/owner-live-transport.ts) is failing.`,
};

function deliveryItem(cell: DeliveryReceiptsCell, repo: string): CloudBacklogItem {
  const channel = cell.channel;
  const signal = cell.signal;
  const id = `delivery-receipts-${channel}-${signal}-${createHash('sha256').update(`delivery-receipts:${repo.trim().toLowerCase()}:${channel}:${signal}`).digest('hex').slice(0, 16)}`;
  const reasonBit = signal === 'unclassified' && cell.reasonText !== null
    ? ` The recorded reason — '${cell.reasonText.slice(0, 120)}' — sits outside the writer's current vocabulary.`
    : '';
  const prompt = [
    `Phantom's owner-thread delivery ledger keeps recording failed ${channelName(channel)} deliveries — ${cell.rows} 'failed' row(s) across ${cell.messages} distinct message(s) and ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each 'failed' row is one sendOwnerReply fanout whose ${channelName(channel)} delivery did not land — the owner never received that reply on that channel.${reasonBit}${seenText(cell)}${contextText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    SIGNAL_FIND[signal].replace('{channel}', channelName(channel)),
    '',
    `If the window has rolled forward, the failures were a transient transport or host incident the later rows recovered from, the channel was deliberately held or unconfigured, or deliveries now land on the default branch — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: `${channelName(channel)}: ${SIGNAL_TITLE[signal]}`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `owner-delivery-${signal}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the owner-thread delivery ledger's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function deliveryReceiptsBacklogItems(opts: DeliveryReceiptsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    // The journal describes this install's comms machinery and carries
    // no repository column — like the custody, self-tick and launch-cost
    // feeds, only the fleet's own repository inherits the items.
    if (fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    // Mirror fixedOwnerRunsDir (src/core/comms/owner-channel.ts): every
    // production caller passes it to sendOwnerReply, and it resolves
    // <realHome()>/.ashlr-runs — $HOME and ASHLR_RUNS_DIR cannot retarget
    // the ledger, so neither may this read.
    const runsDir = opts.runsDir ?? join(opts.homeDir ?? realHome() ?? homedir(), '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(runsDir, 'leader', LEDGER_FILE);
    // The tail bound mirrors the writer's own reader: the newest
    // DELIVERY_RECEIPTS_TAIL_BYTES, then the newest
    // DELIVERY_RECEIPTS_MAX_LINES non-blank lines inside parse — the same
    // window readReceipts sees. Truncation at either bound is stated as a
    // lower bound; the file has no rotation but the writer only ever
    // appends, so growth is benign and no oversize item exists.
    const read = await readLedgerTail(journalPath, DELIVERY_RECEIPTS_TAIL_BYTES);
    if (read.state !== 'read') return [];
    const fold = foldDeliveryReceiptRows(read.text, { nowMs });
    const lowerBound = read.truncated || fold.droppedLines > 0;
    const cells = deliveryReceiptCells(fold, lowerBound);
    const limit = Math.max(1, Math.min(opts.limit ?? DELIVERY_RECEIPTS_BACKLOG_MAX_ITEMS, DELIVERY_RECEIPTS_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => deliveryItem(cell, repo));
  } catch {
    return [];
  }
}
