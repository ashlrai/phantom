/**
 * <runs>/slack-bridge/journal.jsonl Slack bridge observation journal →
 * self-improvement backlog items.
 *
 * Every Socket Mode delivery the Slack bridge sees lands here as ONE
 * metadata record — recordSlackObservation in
 * src/core/agents/slack-journal.ts, called by ingestSlackSocketMessage
 * in src/core/agents/slack-inbound.ts on every unwrap, decision and bus
 * append outcome:
 *
 *   { at: <ISO-8601>, decision: 'ingested' | 'ignored',
 *     reason?: <ignore reason code>, bus?: 'posted' | 'duplicate' |
 *     'failed', channelId?, authorId?, messageTs?, threadTs?,
 *     envelopeId?, eventId?, requestId? }
 *
 * The file is capped at 256 KiB and keeps the newest ~192 KiB of whole
 * rows; message text, display names, tokens and socket URLs are never
 * written — that is what makes the "ignored and logged without
 * content" rule auditable. An 'ingested' row means the event passed
 * every gate (mapped channel, allowlisted [team] author, valid bounded
 * text) and records the local bus append outcome; an 'ignored' row
 * carries the static SlackIgnoreReason code from slack-inbound.ts.
 *
 * Until now the journal's only readers were display surfaces —
 * slackItems in src/core/comms/unified-inbox.ts, slack-request-trace
 * and slack-status — which render rows but never fold a recurrence
 * into work, so a team-message path that kept dropping traffic never
 * became a backlog item. slackBridgeBacklogItems carries the journal
 * into discoverBacklog:
 *
 *  - bus-failed cells per channel: 'ingested' rows whose bus append
 *    failed — the event was accepted and validated, then
 *    appendBusInbox returned a non-posted outcome or threw, so the
 *    message never reached the bus.
 *  - untrusted-sender cells per channel: 'ignored' rows with the
 *    untrusted-sender reason — they fire only after the channel
 *    mapped to a bus topic, so a mapped channel keeps hearing from
 *    senders outside the [team] allowlist.
 *  - oversize-text cells per channel: 'ignored' rows with the
 *    oversize-text reason — mapped-channel messages over
 *    BUS_V2_TEXT_MAX are validated then refused, never reaching the
 *    bus.
 *  - secret-shaped-text cells per channel: 'ignored' rows with the
 *    secret-shaped-text reason — secret-shaped content the bridge
 *    correctly refuses; recurring rows are a security signal (real
 *    secret-shaped posts, or scrubber false-positives on legitimate
 *    content), never the content itself.
 *  - unclassified-ignore cells per (channel, reason): 'ignored' rows
 *    whose reason is absent or outside the writer's twelve-code
 *    SlackIgnoreReason vocabulary — a newer writer's codes this fold
 *    does not know, or rows no current writer emits. The recorded
 *    reason is quoted bounded.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readSlackJournal's
 *    bounded, contract-validating reader (the same whitelist the
 *    writer's projectObservation applies); nothing is written and no
 *    lock, process or network is touched.
 *  - Rows count only under the writer's contract: readSlackJournal
 *    returns only entries that satisfy the journal's own metadata
 *    shape — a parseable `at`, the closed decision vocabulary, and
 *    optional fields that ARE present satisfying their own rules
 *    (bounded strings, Slack channel/ts ids, the closed bus
 *    vocabulary, the request-id shape). Malformed lines are dropped
 *    by that reader and mark the read degraded; the retained valid
 *    entries still fold, with the degradation stated — counts cover
 *    the retained rows, a recorded floor.
 *  - Recurring means recorded across days AND across events: a cell
 *    emits at SLACK_BRIDGE_MIN_ROWS adverse rows across
 *    SLACK_BRIDGE_MIN_DAYS distinct UTC days inside the window AND
 *    SLACK_BRIDGE_MIN_EVENTS distinct message identities — Socket
 *    Mode redelivery and retries can re-record the same message, so
 *    one message's retry storm is one event, not recurrence. The
 *    event identity prefers the Slack message ts (stable across
 *    redelivery), then the Events API event id, the envelope id, and
 *    finally the row's own timestamp.
 *  - Designed traffic never emits: 'posted'/'duplicate' bus outcomes,
 *    'ingested' rows without a failure, and the nine ignore reasons
 *    that are the bridge working as designed (unsupported envelope,
 *    event, subtype and hidden events; malformed, foreign-team,
 *    unmapped-channel, self-message and empty-text rows — the bulk
 *    of Slack's delivery stream) count as context only.
 *  - The journal describes this install's bridge configuration — the
 *    mapped channels, the [team] allowlist and the bus store are
 *    local state with no repository column — so like the sibling
 *    fleet-evidence feeds, items emit only when the backlog target's
 *    repository name is 'phantom'.
 *  - Channel ids and reason strings are quoted as recorded, scrubbed,
 *    flattened and capped; author ids are never quoted — the journal
 *    keeps them for trace joins, and a prompt needs only the channel
 *    and the reason.
 *  - Dedup is downstream. The item id hashes the cell identity
 *    (kind + channel + reason key + repository — never the counts or
 *    timestamps), so a refresh re-derives the same ids and
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

import { readSlackJournal, type SlackObservation } from '../agents/slack-journal.js';
import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the cell space is kind × channel × reason. */
export const SLACK_BRIDGE_BACKLOG_MAX_ITEMS = 8;
const SLACK_BRIDGE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const SLACK_BRIDGE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const SLACK_BRIDGE_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a cell needs inside the window before its recurrence counts. */
export const SLACK_BRIDGE_MIN_ROWS = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const SLACK_BRIDGE_MIN_DAYS = 2;
/** Distinct message identities those rows must span — one retried delivery is one event. */
export const SLACK_BRIDGE_MIN_EVENTS = 2;
/** The fleet's own repository label: the journal describes this install's bridge, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/**
 * The reader's entry cap: readSlackJournal keeps the newest `limit`
 * validated entries (hard max 4096). The journal file itself is capped
 * at 256 KiB — roughly 192 KiB of retained whole rows — so 4096 always
 * covers the whole retained window.
 */
const SLACK_JOURNAL_READ_LIMIT = 4096;
/** Quoted channel id cap — Slack ids are short; anything longer is off-contract anyway. */
const MAX_CHANNEL_CHARS = 40;
/** Reason text quoted inside unclassified cells: scrubbed, flattened, capped. */
const MAX_REASON_CHARS = 80;

export type SlackBridgeCellKind =
  | 'bus-failed'
  | 'untrusted-sender'
  | 'oversize-text'
  | 'secret-shaped-text'
  | 'unclassified-ignore';

/**
 * The ignore reasons that are the bridge working as designed — Slack's
 * delivery stream is mostly non-message events, unmapped channels,
 * self-echoes and empty posts. Duplicated from SlackIgnoreReason in
 * src/core/agents/slack-inbound.ts for the same closure reason the
 * sibling feeds duplicate their writers' vocabularies — if the writer's
 * reason set moves, move this with it. Anything outside this set AND
 * outside the three adverse reasons is 'unclassified-ignore'.
 */
const DESIGNED_IGNORE_REASONS = new Set([
  'unsupported-envelope-type',
  'unsupported-event-type',
  'unsupported-subtype',
  'hidden-event',
  'malformed-event',
  'foreign-team',
  'unmapped-channel',
  'self-message',
  'empty-text',
]);

const ADVERSE_IGNORE_KIND: Record<string, SlackBridgeCellKind> = {
  'untrusted-sender': 'untrusted-sender',
  'oversize-text': 'oversize-text',
  'secret-shaped-text': 'secret-shaped-text',
};

export interface SlackBridgeItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet install only. */
  repo: string;
  /** Runs dir for the journal; $ASHLR_RUNS_DIR wins when set (the reader's own resolution). */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default SLACK_BRIDGE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated journal row folded to its window position and cell identity. */
interface SlackBridgeRow {
  atMs: number;
  utcDay: string;
  kind: SlackBridgeCellKind;
  /** Sanitized channel id, or 'unknown' when the row carried none. */
  channel: string;
  /** Normalized reason key — set only on unclassified-ignore rows. */
  reasonKey: string | null;
  /** Reason text quoted in prompts — set only on unclassified-ignore rows. */
  reasonText: string | null;
  /** Stable message identity for the distinct-event bar. */
  eventKey: string;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** Channel text as recorded: the reader already enforces bounded control-free ids; scrub and cap before quoting. */
function cleanChannel(value: string | undefined): string {
  if (value === undefined || value === '') return 'unknown';
  const cleaned = scrubSecrets(value).replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? 'unknown' : cleaned.slice(0, MAX_CHANNEL_CHARS);
}

/** Reason text for quoting: scrubbed, flattened, capped; 'unrecorded' when absent or empty. */
function cleanReason(value: string | undefined): { key: string; text: string | null } {
  if (value === undefined) return { key: 'unrecorded', text: null };
  const cleaned = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return { key: 'unrecorded', text: null };
  const capped = cleaned.slice(0, MAX_REASON_CHARS);
  return { key: capped.toLowerCase(), text: capped };
}

/**
 * Pure: classify one validated journal entry into its cell kind, or null
 * for context rows (healthy ingested deliveries and designed ignores).
 * The entry already satisfies the journal's own contract — this fold
 * only decides which cells its evidence feeds.
 */
export function slackBridgeRowKind(entry: Pick<SlackObservation, 'decision' | 'reason' | 'bus'>): SlackBridgeCellKind | null {
  if (entry.decision === 'ingested') {
    // 'posted' and 'duplicate' are healthy; a missing bus field is a
    // legacy row — neither is adverse evidence.
    return entry.bus === 'failed' ? 'bus-failed' : null;
  }
  if (entry.decision !== 'ignored') return null;
  const reason = entry.reason;
  if (typeof reason === 'string') {
    const adverse = ADVERSE_IGNORE_KIND[reason];
    if (adverse !== undefined) return adverse;
    if (DESIGNED_IGNORE_REASONS.has(reason)) return null;
  }
  return 'unclassified-ignore';
}

/**
 * Pure: fold one validated journal entry into a row, or null when it is
 * context or outside the window.
 */
export function slackBridgeFoldRow(
  entry: SlackObservation,
  opts: { nowMs: number; windowMs?: number },
): SlackBridgeRow | null {
  const atMs = Date.parse(entry.at);
  if (!Number.isFinite(atMs)) return null;
  const windowMs = opts.windowMs ?? SLACK_BRIDGE_WINDOW_MS;
  if (atMs < opts.nowMs - windowMs || atMs > opts.nowMs + SLACK_BRIDGE_FUTURE_SKEW_MS) return null;
  const kind = slackBridgeRowKind(entry);
  if (kind === null) return null;
  const channel = cleanChannel(entry.channelId);
  const reason = kind === 'unclassified-ignore' ? cleanReason(entry.reason) : { key: null, text: null };
  // Redelivery-stable identity: the message's own ts first (Socket Mode
  // retries re-record the same message under a fresh envelope), then the
  // Events API id, the envelope id, and the row timestamp as the floor.
  const eventKey = `${channel}|${entry.messageTs ?? entry.eventId ?? entry.envelopeId ?? entry.at}`;
  return {
    atMs,
    utcDay: utcDayOf(atMs),
    kind,
    channel,
    reasonKey: reason.key,
    reasonText: reason.text,
    eventKey,
  };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the journal's retained entries
// ---------------------------------------------------------------------------

export interface SlackBridgeFold {
  /** In-window on-contract entries the reader returned. */
  entries: number;
  /** In-window entries that classified as context (healthy or designed). */
  contextRows: number;
  /** Entries outside the window — the reader guarantees a parseable `at`, so this is window overflow only. */
  outsideWindow: number;
  /** True when the journal read reported damaged lines — counts are a recorded floor. */
  degraded: boolean;
  /** Adverse cells keyed `${kind}${channel}${reasonKey}`. */
  cells: Map<string, {
    kind: SlackBridgeCellKind;
    channel: string;
    reasonKey: string | null;
    reasonText: string | null;
    rows: number;
    days: Set<string>;
    events: Set<string>;
    firstMs: number;
    lastMs: number;
  }>;
}

/**
 * Pure: fold validated journal entries into adverse cells. Only rows
 * inside the window join cells; context rows count toward the quoted
 * totals. Cell keys are `${kind}${channel}${reasonKey}`.
 */
export function foldSlackBridgeEntries(
  entries: readonly SlackObservation[],
  opts: { nowMs: number; windowMs?: number; degraded?: boolean },
): SlackBridgeFold {
  const fold: SlackBridgeFold = {
    entries: 0, contextRows: 0, outsideWindow: 0, degraded: opts.degraded === true,
    cells: new Map(),
  };
  const windowMs = opts.windowMs ?? SLACK_BRIDGE_WINDOW_MS;
  for (const entry of entries) {
    const atMs = Date.parse(entry.at);
    if (!Number.isFinite(atMs)) continue;
    if (atMs < opts.nowMs - windowMs || atMs > opts.nowMs + SLACK_BRIDGE_FUTURE_SKEW_MS) {
      fold.outsideWindow += 1;
      continue;
    }
    fold.entries += 1;
    const row = slackBridgeFoldRow(entry, opts);
    if (row === null) { fold.contextRows += 1; continue; }
    const key = `${row.kind}${row.channel}${row.reasonKey ?? ''}`;
    let cell = fold.cells.get(key);
    if (cell === undefined) {
      cell = {
        kind: row.kind, channel: row.channel, reasonKey: row.reasonKey, reasonText: row.reasonText,
        rows: 0, days: new Set(), events: new Set(), firstMs: row.atMs, lastMs: row.atMs,
      };
      fold.cells.set(key, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.events.add(row.eventKey);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
    if (cell.reasonText === null && row.reasonText !== null) cell.reasonText = row.reasonText;
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface SlackBridgeCell {
  kind: SlackBridgeCellKind;
  channel: string;
  /** Normalized reason key — set only on unclassified-ignore cells. */
  reasonKey: string | null;
  /** The first recorded reason text, bounded — unclassified-ignore cells only. */
  reasonText: string | null;
  /** In-window adverse rows. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Distinct message identities the rows span — retried deliveries collapse to one. */
  events: number;
  /** In-window on-contract entries overall — the context denominator. */
  records: number;
  /** In-window context rows — healthy deliveries and designed ignores. */
  context: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the journal read was degraded: damaged lines were dropped, counts are a recorded floor. */
  degraded: boolean;
}

const isoOrNull = (ms: number): string | null => new Date(ms).toISOString();

/**
 * Pure: recurring cells — a cell emits at the row, day and distinct-event
 * bars. Sorted by rows desc, then kind, channel and reason for a stable
 * order.
 */
export function slackBridgeCells(fold: SlackBridgeFold): SlackBridgeCell[] {
  const cells: SlackBridgeCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < SLACK_BRIDGE_MIN_ROWS) continue;
    if (cell.days.size < SLACK_BRIDGE_MIN_DAYS) continue;
    if (cell.events.size < SLACK_BRIDGE_MIN_EVENTS) continue;
    cells.push({
      kind: cell.kind,
      channel: cell.channel,
      reasonKey: cell.reasonKey,
      reasonText: cell.kind === 'unclassified-ignore' ? cell.reasonText : null,
      rows: cell.rows,
      days: [...cell.days].sort(),
      events: cell.events.size,
      records: fold.entries,
      context: fold.contextRows,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      degraded: fold.degraded,
    });
  }
  return cells.sort((a, b) =>
    b.rows - a.rows || a.kind.localeCompare(b.kind) || a.channel.localeCompare(b.channel)
    || (a.reasonKey ?? '').localeCompare(b.reasonKey ?? ''));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/slack-bridge/journal.jsonl — recordSlackObservation in src/core/agents/slack-journal.ts appends one metadata-only row per Socket Mode delivery the bridge sees, written by ingestSlackSocketMessage in src/core/agents/slack-inbound.ts on every unwrap, decision and bus append outcome (and the leader reply path in src/core/agents/slack-leader.ts): {at, decision: \'ingested\'|\'ignored\', reason?, bus?: \'posted\'|\'duplicate\'|\'failed\', channelId?, authorId?, messageTs?, threadTs?, envelopeId?, eventId?, requestId?}. The file is capped at 256 KiB with ~192 KiB of whole-row retention and never holds message text, display names, tokens or socket URLs. Its readers until this feed were display surfaces — slackItems in src/core/comms/unified-inbox.ts, slack-request-trace and slack-status — which render rows but never fold a recurrence into work.';

const REPRO = 'Reproduce the fold by reading <runs dir>/slack-bridge/journal.jsonl directly, keeping rows that satisfy the journal contract ({at parseable, decision in ingested|ignored, optional fields well-formed}) whose `at` lands inside the window, classifying ingested rows with bus \'failed\' and ignored rows by their reason code (untrusted-sender, oversize-text, secret-shaped-text, or a reason outside the twelve-code SlackIgnoreReason vocabulary), and treating posted/duplicate outcomes plus the nine designed ignore reasons as context. The writer and its gates are src/core/agents/slack-journal.ts and src/core/agents/slack-inbound.ts; the bus append is src/core/fleet/bus-inbox.ts; the allowlist and channel map live in ~/.ashlr/agent-network.toml (ids only, never values).';

const NO_CHANGE = 'If the window has rolled forward, the drops were a transient bus-store or host incident the later rows recovered from, the senders or channels were deliberately unmapped or unconfigured, the bridge is disabled or its journal is simply quiet now, or this checkout is not the fleet install the journal describes — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: SlackBridgeCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const degradedText = (cell: SlackBridgeCell): string =>
  cell.degraded ? ' The journal read reported damaged lines, so these counts cover only the retained valid rows — a recorded floor, not the full stream.' : '';

const WINDOW_DAYS = Math.round(SLACK_BRIDGE_WINDOW_MS / 86_400_000);

const KIND_TITLE: Record<SlackBridgeCellKind, string> = {
  'bus-failed': 'accepted Slack messages keep failing the bus append',
  'untrusted-sender': 'mapped Slack channels keep hearing dropped senders',
  'oversize-text': 'mapped Slack channels keep dropping oversized messages',
  'secret-shaped-text': 'mapped Slack channels keep seeing secret-shaped text',
  'unclassified-ignore': 'Slack bridge keeps ignoring events under unknown reason codes',
};

const KIND_FIND: Record<SlackBridgeCellKind, string> = {
  'bus-failed':
    `Find why accepted Slack events keep failing the bus append on channel ${'{channel}'}: each row is one event that passed every gate — mapped channel, allowlisted [team] author, valid bounded text — then appendBusInbox (src/core/fleet/bus-inbox.ts, called from ingestSlackSocketMessage in src/core/agents/slack-inbound.ts) returned a non-posted outcome or threw, so the message never reached the bus. Check the bus store root the bridge publishes to (ctx.busRoot, defaulting to the canonical ~/.ashlr/fleet inbox), the local store lock and disk pressure on that path, and whether 'duplicate' outcomes are being misrecorded as failures. Socket Mode redelivery can re-record the same message, so distinct messageTs values — not row counts — are the real failure count. The bridge, the bus store and the journal are this repository's own; Slack's service and the workspace config are owner-side — name them rather than working around them.`,
  'untrusted-sender':
    `Find why mapped Slack channel ${'{channel}'} keeps receiving messages from senders outside the [team] allowlist: 'untrusted-sender' fires only after the channel mapped to a bus topic (unmapped-channel is checked first), so these are messages in a fleet-wired channel the bridge deliberately drops — recurring rows usually mean a teammate's Slack id is missing from the allowlist or the config drifted, and occasionally mean an outsider is posting where the fleet listens. Check isSlackTeamIdentity in src/core/agents/channel-policy.ts against the [team] identity rows for slack in ~/.ashlr/agent-network.toml (ids only, never values) and the [[slack.map]] bindings in the bridge config for channels that should not be wired. The gates are this repository's own; the allowlist itself is owner config.`,
  'oversize-text':
    `Find why mapped Slack channel ${'{channel}'} keeps dropping oversized messages: 'oversize-text' fires when event text exceeds BUS_V2_TEXT_MAX (src/core/agents/bus-v2-schema.ts) — the bus envelope's text cap — so a team member's long message is validated then refused and never reaches the bus. Check whether the cap fits how the mapped channels are actually used, whether the bridge should refuse earlier or carry a different body kind for long text, and whether the drops recur on the same threads (the journal carries messageTs/threadTs, never text). The schema, the ingest path and the journal are this repository's own.`,
  'secret-shaped-text':
    `Find why mapped Slack channel ${'{channel}'} keeps receiving secret-shaped text the bridge refuses: 'secret-shaped-text' fires when scrubSecrets(text) !== text — the message may carry a credential shape and is dropped before the bus, which is the control working. Recurring rows mean either real secret-shaped posts keep arriving (a security signal worth surfacing to the owner through the normal needs-you path, never through this item) or the scrubber false-positives on legitimate content the team keeps sending. Check scrubSecrets' patterns in src/core/util/scrub.ts against the refusal rate and the channels involved; never quote or reproduce the content — the journal carries ids and reason codes only by design.`,
  'unclassified-ignore':
    `Find why the Slack bridge keeps ignoring events under reason codes outside the writer's vocabulary on channel ${'{channel}'}: each row carries a reason string that is not one of the twelve SlackIgnoreReason codes in src/core/agents/slack-inbound.ts — either a newer writer emits codes this fold does not know, or rows were appended by something else. The recorded reason is quoted bounded in the evidence. Check whether slack-inbound.ts's reason vocabulary moved, whether another writer appends to slack-bridge/journal.jsonl, and whether the unknown codes hide adverse drops (lost team messages) rather than designed ignores.`,
};

/** Id-safe fragment: backlog ids admit [A-Za-z0-9._-] only and cap at 120 chars total. */
const idSafe = (value: string, cap: number): string =>
  value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, cap) || 'unknown';

function slackBridgeItem(cell: SlackBridgeCell, repo: string): CloudBacklogItem {
  const kind = cell.kind;
  const channel = cell.channel === 'unknown' ? 'a row carrying no channel id' : `Slack channel ${cell.channel}`;
  const reasonBit = kind === 'unclassified-ignore' && cell.reasonText !== null
    ? ` The recorded reason — '${cell.reasonText.slice(0, 120)}' — sits outside the writer's current vocabulary.`
    : '';
  // The hash covers the full cell identity (kind + channel + reason key +
  // repo); the readable fragments are bounded so the id stays inside
  // ID_RE's 120-char cap even for a max-length channel and reason.
  const hash = createHash('sha256')
    .update(`slack-bridge:${repo.trim().toLowerCase()}:${kind}:${cell.channel}:${cell.reasonKey ?? ''}`)
    .digest('hex').slice(0, 16);
  const id = `slack-bridge-${kind}-${idSafe(cell.channel, 24)}-${idSafe(cell.reasonKey ?? 'na', 24)}-${hash}`;
  // The title carries the channel (and the reason for unclassified cells)
  // because appendUserBacklogItems dedupes on the normalised title — two
  // channels dropping the same way are two items, not one.
  const titleChannel = cell.channel === 'unknown' ? 'unknown channel' : cell.channel;
  const titleReason = kind === 'unclassified-ignore' && cell.reasonText !== null
    ? ` — '${cell.reasonText.slice(0, 60)}'` : '';
  const prompt = [
    `Phantom's Slack bridge observation journal keeps recording ${KIND_TITLE[kind]} — ${cell.rows} adverse row(s) across ${cell.events} distinct message(s) and ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each row is one Socket Mode delivery the bridge journaled on ${channel}.${reasonBit}${seenText(cell)} ${cell.context} in-window row(s) recorded healthy deliveries or designed ignores as context.${degradedText(cell)}`,
    '',
    EVIDENCE,
    '',
    KIND_FIND[kind].replace('{channel}', channel),
    '',
    `If the window has rolled forward, the drops were a transient bus-store or host incident the later rows recovered from, the senders or channels were deliberately unmapped or unconfigured, the bridge is disabled or its journal is simply quiet now, or this checkout is not the fleet install the journal describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: `Slack bridge ${titleChannel}: ${KIND_TITLE[kind]}${titleReason}`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `slack-bridge-${kind}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name the fleet-repo gate matches: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the Slack bridge journal's recurring adverse
 * evidence. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function slackBridgeBacklogItems(opts: SlackBridgeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    // The journal describes this install's bridge configuration and
    // carries no repository column — like the sibling fleet-evidence
    // feeds, only the fleet's own repository inherits the items.
    if (fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    // readSlackJournal resolves <runsDir>/slack-bridge/journal.jsonl
    // itself; runsDir honors $ASHLR_RUNS_DIR over homeDir, matching the
    // reader's own precedence.
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(opts.homeDir ?? homedir(), '.ashlr-runs');
    const read = readSlackJournal({ runsDir, limit: SLACK_JOURNAL_READ_LIMIT });
    if (read.state === 'missing' || read.entries.length === 0) return [];
    const fold = foldSlackBridgeEntries(read.entries, { nowMs, degraded: read.state === 'degraded' });
    const cells = slackBridgeCells(fold);
    const limit = Math.max(1, Math.min(opts.limit ?? SLACK_BRIDGE_BACKLOG_MAX_ITEMS, SLACK_BRIDGE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => slackBridgeItem(cell, repo));
  } catch {
    return [];
  }
}
