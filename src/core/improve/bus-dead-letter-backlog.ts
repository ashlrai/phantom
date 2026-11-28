/**
 * Agent-bus dead-letter sink → self-improvement backlog items.
 *
 * The file-bus transport's dead-letter sink
 * (createFileDeadLetterSink in src/core/fleet/bus-transport-file.ts)
 * files one `status` envelope addressed to the reserved
 * `bus.dead-letter` label into the same bus inbox store
 * (<ashlrHome>/fleet/bus-inbox/messages.json, read through
 * src/core/fleet/bus-inbox.ts) every time the router's bounded retry
 * budget ends without delivery — reason 'exhausted' after maxAttempts,
 * 'expired' when the message's TTL ran out first, 'no-route' when no
 * transport serves the role, or 'other' for a letter whose stored body
 * the defensive report read cannot classify. Each letter keeps the
 * original routing metadata the router recorded — original id, sender,
 * recipient, kind, failure reason and attempt count — or only that
 * metadata when the payload itself would not fit (payloadDropped),
 * and lives under its own seven-day TTL
 * (BUS_DEAD_LETTER_TTL_MS). Mail addressed there is work that provably
 * never landed.
 *
 * Until now the sink's only readers were point-in-time surfaces —
 * `agents bus dead-letters` (readBusDeadLetters), the
 * `agents bus status` deadLetters probe's live count and reason tally,
 * the unified comms inbox's `bus-dead-letter` items, `work mine`'s
 * deadLetters section, `phm comms bus read --to bus.dead-letter` and
 * the fleet_bus_dead_letters MCP read — current queue state, never a
 * trend. A route or seat that keeps losing mail was visible only to
 * someone who already suspected it and ran one of those reads.
 * busDeadLetterBacklogItems carries the same live letters into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence
 * sources beside it.
 *
 * Two cell kinds, both keyed on recorded letter evidence:
 *
 *  - Per-recipient cells: dead letters grouped by the original `to`
 *    routing label the letter's report kept. Three or more letters to
 *    the same address across two or more distinct UTC days inside the
 *    window means that route keeps failing — a retired or renamed
 *    callsign nobody unrouted, a seat whose consumer stopped polling
 *    or stopped acking, or a group topic with no live subscriber.
 *    Letters whose report never parsed carry no `to` and can never
 *    form an address cell; they stay 'other'-reason context.
 *  - Per-reason cells: dead letters grouped by the classified failure
 *    reason. The same recurring bars apply, plus a spread requirement —
 *    the letters must reach at least two distinct recipient buckets
 *    (each parseable `to` counts once; every unparseable letter counts
 *    as its own unattributable bucket, since nothing proves it shares
 *    a route). A reason concentrated on one address is that address's
 *    cell, not a fleet-wide pattern; a reason spread across recipients
 *    — or a cluster of letters no report can attribute at all, which
 *    is itself evidence the sink's wire contract drifted — is the
 *    systemic read: router route-table gaps ('no-route'), transports
 *    that accept but consumers that never ack ('exhausted'), TTLs that
 *    lose to poll cadence ('expired'), or a report shape the readers
 *    can no longer parse ('other').
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The store is walked through inspectBusInbox and
 *    listBusInboxAfter's bounded live-receipt pages — the same reads
 *    probeDeadLetters and readBusDeadLetters run — with the clock
 *    frozen once per call; nothing is written and no network is
 *    touched. listBusInboxAfter already skips expired receipts, so
 *    every counted letter is one the operator surfaces would still
 *    list; letters past their TTL are gone evidence, not history.
 *  - Degraded reads yield no items. An unavailable store or a failed
 *    first page returns nothing — unknown stays unknown, never a
 *    guessed tally — while a walk that fails mid-scan folds the pages
 *    it proved and marks every count a lower bound, matching the
 *    sibling feeds' truncation rule.
 *  - Recurring means recorded across days. A cell emits only at
 *    BUS_DEAD_LETTER_MIN_LETTERS letters spanning
 *    BUS_DEAD_LETTER_MIN_DAYS distinct UTC days of receipt inside the
 *    window — one outage burst that dead-lettered a queue is an
 *    incident the bus already reported, not a pattern. Windowing is on
 *    the receipt's own receivedAt stamp (the store's clock); letters
 *    stamped past the evaluation-time skew never reach a cell.
 *  - Fleet machinery only. The bus inbox describes this install's
 *    agent fleet and carries no repository column, and the fix —
 *    routing, enrollment, consumer health, the sink contract — lives
 *    in this repository's bus machinery, so items emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling machinery feeds apply.
 *  - Dedup is downstream. The item id hashes only the cell identity
 *    (kind + reason or kind + recipient label — never the counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; letters that expire
 *    simply stop re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, routing labels are scrubbed, flattened
 *    and capped before use, and the brief names the store, the sink,
 *    the transport and the report commands with the usual no-change
 *    escape — including designed holds (kill switch, comms pause,
 *    egress gate) the fold cannot see.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { busDeadLetterReason, busDeadLetterReport, BUS_DEAD_LETTER_ADDRESS, BUS_DEAD_LETTER_REASONS, type BusDeadLetterReason, type BusDeadLetterReport } from '../agents/bus-dead-letter.js';
import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter } from '../fleet/bus-inbox.js';
import type { BusPriority } from '../fleet/bus-envelope.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; reason cells are bounded at four, recipient cells by live-letter diversity. */
export const BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS = 8;
const BUS_DEAD_LETTER_ITEM_HARD_MAX = 25;
/** Dead letters a cell needs inside the window before its recurrence counts. */
export const BUS_DEAD_LETTER_MIN_LETTERS = 3;
/** Distinct UTC days those letters must span — recurring means recorded across days. */
export const BUS_DEAD_LETTER_MIN_DAYS = 2;
/**
 * Evidence window: seven days — the same recurrence window the sibling
 * feeds anchor on, and exactly the dead-letter TTL
 * (BUS_DEAD_LETTER_TTL_MS in bus-transport-file.ts), so every live
 * letter the store still lists is inside it by construction; the bound
 * still applies so a foreign letter posted under a longer TTL, or a
 * clock that moved, cannot reach a cell.
 */
export const BUS_DEAD_LETTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on receipt stamps, the sibling feeds' one-minute tolerance. */
const BUS_DEAD_LETTER_FUTURE_SKEW_MS = 60_000;
/** Bounded walk: enough pages to reach the store's own row cap, plus one for the short-page proof. */
const BUS_DEAD_LETTER_MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Routing labels and ids are unbounded stored text; flatten, scrub and cap before display. */
const MAX_FIELD_CHARS = 120;
/** Distinct recipients named inside one reason-cell prompt before the remainder is summarized. */
const PROMPT_RECIPIENTS_MAX = 6;
/** Distinct senders named inside one recipient-cell prompt before the remainder is summarized. */
const PROMPT_SENDERS_MAX = 5;
/** The fleet's own repository label: bus evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface BusDeadLetterItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Bus inbox root override (default: <ashlrHome>/fleet — bus-inbox.ts rootPath). */
  root?: string;
  /** Most items one call emits (default BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and the receipt filter (default: now). */
  now?: Date;
  /** Window in ms (default BUS_DEAD_LETTER_WINDOW_MS). */
  windowMs?: number;
}

/** One live dead-letter receipt: the store's own stamps plus the parsed report. */
export interface DeadLetterRow {
  cursor: number;
  /** Receipt clock (epoch ms) — the store's timestamp, never the body's claim. */
  receivedAt: number;
  /** The letter envelope's own priority band. */
  priority: BusPriority;
  /** The parsed deadLetter report, or null when the body never parsed. */
  report: BusDeadLetterReport | null;
  /** The classified failure reason every consumer tallies. */
  reasonKind: BusDeadLetterReason;
}

interface LetterTally {
  letters: number;
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
  reasons: Map<BusDeadLetterReason, number>;
  priorities: Map<string, number>;
  kinds: Map<string, number>;
  senders: Map<string, number>;
  recipients: Map<string, number>;
  payloadDropped: number;
}

/** A per-reason cell: the letter tally plus its computed recipient spread and unattributed count. */
interface ReasonCell extends LetterTally {
  /** Distinct named recipients plus one bucket per unparseable letter. */
  spread: number;
  /** Letters whose report never parsed — unattributable to any named route. */
  unparsed: number;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

const newTally = (): LetterTally => ({
  letters: 0, days: new Set(), firstAtMs: Infinity, lastAtMs: -Infinity,
  reasons: new Map(), priorities: new Map(), kinds: new Map(),
  senders: new Map(), recipients: new Map(), payloadDropped: 0,
});

const bump = (map: Map<string, number>, key: string | null): void => {
  if (key === null || key === '') return;
  map.set(key, (map.get(key) ?? 0) + 1);
};

/**
 * Pure: fold validated letter rows into per-recipient and per-reason
 * cells. Only letters whose receipt stamp lands inside the window count;
 * windowing is on receivedAt — the store's clock — never on the body's
 * own deadLetteredAt claim. Recurring bars (letters and distinct UTC
 * days) are applied here; reason cells additionally require the spread
 * rule described in the module header.
 */
export function foldBusDeadLetterCells(
  rows: readonly DeadLetterRow[],
  nowMs: number,
  windowMs: number = BUS_DEAD_LETTER_WINDOW_MS,
): { addressCells: Map<string, LetterTally>; reasonCells: Map<BusDeadLetterReason, ReasonCell> } {
  const windowStart = nowMs - windowMs;
  const futureCeil = nowMs + BUS_DEAD_LETTER_FUTURE_SKEW_MS;
  const addressCells = new Map<string, LetterTally>();
  const reasonCells = new Map<BusDeadLetterReason, ReasonCell>();
  for (const row of rows) {
    if (!Number.isFinite(row.receivedAt) || row.receivedAt < windowStart || row.receivedAt > futureCeil) continue;
    const day = utcDayOf(row.receivedAt);
    // Reason cell: every letter tallies under its classified reason.
    let reason = reasonCells.get(row.reasonKind);
    if (reason === undefined) {
      reason = { ...newTally(), spread: 0, unparsed: 0 };
      reasonCells.set(row.reasonKind, reason);
    }
    reason.letters += 1;
    reason.days.add(day);
    reason.firstAtMs = Math.min(reason.firstAtMs, row.receivedAt);
    reason.lastAtMs = Math.max(reason.lastAtMs, row.receivedAt);
    reason.reasons.set(row.reasonKind, (reason.reasons.get(row.reasonKind) ?? 0) + 1);
    bump(reason.priorities, row.priority);
    bump(reason.kinds, row.report?.kind ?? null);
    bump(reason.senders, row.report?.from ?? null);
    bump(reason.recipients, row.report?.to ?? null);
    if (row.report?.payloadDropped === true) reason.payloadDropped += 1;
    // Spread: each parseable recipient counts once; every unparseable
    // letter is its own unattributable bucket — nothing proves it
    // shares a route, so it can never be folded into a named cell.
    if (row.report?.to === null || row.report?.to === undefined || row.report.to === '') reason.unparsed += 1;
    // Recipient cell: only a report that kept the original `to` label.
    const to = row.report?.to;
    if (typeof to === 'string' && to !== '') {
      let cell = addressCells.get(to);
      if (cell === undefined) {
        cell = newTally();
        addressCells.set(to, cell);
      }
      cell.letters += 1;
      cell.days.add(day);
      cell.firstAtMs = Math.min(cell.firstAtMs, row.receivedAt);
      cell.lastAtMs = Math.max(cell.lastAtMs, row.receivedAt);
      cell.reasons.set(row.reasonKind, (cell.reasons.get(row.reasonKind) ?? 0) + 1);
      bump(cell.priorities, row.priority);
      bump(cell.kinds, row.report?.kind ?? null);
      bump(cell.senders, row.report?.from ?? null);
      bump(cell.recipients, to);
      if (row.report?.payloadDropped === true) cell.payloadDropped += 1;
    }
  }
  // Apply the recurring bars and compute each reason cell's spread.
  const recurringAddress = new Map<string, LetterTally>();
  for (const [to, cell] of addressCells) {
    if (cell.letters >= BUS_DEAD_LETTER_MIN_LETTERS && cell.days.size >= BUS_DEAD_LETTER_MIN_DAYS) {
      recurringAddress.set(to, cell);
    }
  }
  const recurringReason = new Map<BusDeadLetterReason, ReasonCell>();
  for (const [kind, cell] of reasonCells) {
    const spread = cell.recipients.size + cell.unparsed;
    if (cell.letters >= BUS_DEAD_LETTER_MIN_LETTERS && cell.days.size >= BUS_DEAD_LETTER_MIN_DAYS && spread >= 2) {
      recurringReason.set(kind, { ...cell, spread });
    }
  }
  return { addressCells: recurringAddress, reasonCells: recurringReason };
}

/** Stored routing labels are unbounded text; flatten, scrub and cap before display. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  // eslint-disable-next-line no-control-regex -- stored labels must not carry control bytes.
  return scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const REASON_LABEL: Record<BusDeadLetterReason, string> = {
  exhausted: 'exhausted',
  expired: 'expired',
  'no-route': 'no-route',
  other: 'other',
};

/** The evidence pointers every prompt shares; the store, the sink and the report surfaces are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the bus inbox store — bus-inbox/messages.json under the fleet root (<ASLHR home>/fleet by default; src/core/fleet/bus-inbox.ts rootPath) — whose live `status` envelopes addressed to the reserved `bus.dead-letter` label are the transport dead-letter sink\'s records: createFileDeadLetterSink (src/core/fleet/bus-transport-file.ts) files one per message whose bounded retry budget ended without delivery, after `exhausted` (maxAttempts), `expired` (TTL) or `no-route` (no transport serves the role), each keeping the original routing metadata and attempt count under a seven-day TTL. `agents bus dead-letters` (readBusDeadLetters in src/core/agents/bus-dead-letters.ts), the `agents bus status` deadLetters probe, the unified comms inbox\'s `bus-dead-letter` items, `work mine`\'s deadLetters section, `phm comms bus read --to bus.dead-letter` and the fleet_bus_dead_letters MCP read all fold the same live letters; this feed walks the same bounded listBusInboxAfter live-receipt pages.';

const NO_CHANGE = 'If the window has rolled forward (dead letters live only under their seven-day TTL, so an old burst ages out of the live store), the route or seat was fixed, retired or re-enrolled since, comms was disabled, paused or kill-switched during the window, the egress gate held outbound sends by design, or this checkout is not the fleet repository the bus describes — report no-change and name the evidence.';

function tallyText(map: Map<string, number>, limit: number = 4): string {
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = entries.slice(0, limit).map(([key, count]) => `${key} ${count}`);
  if (entries.length > limit) shown.push(`+${entries.length - limit} more`);
  return shown.join(', ');
}

function spanText(cell: LetterTally): string {
  if (!Number.isFinite(cell.firstAtMs) || !Number.isFinite(cell.lastAtMs)) return '';
  const first = new Date(cell.firstAtMs).toISOString();
  const last = new Date(cell.lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function coverageNote(truncated: boolean, skipped: number): string {
  const notes: string[] = [];
  if (truncated) notes.push('the bounded walk stopped before the store\'s end, so every count is a lower bound');
  if (skipped === 1) notes.push('1 page could not be read');
  else if (skipped > 1) notes.push(`${skipped} pages could not be read`);
  return notes.length === 0 ? '' : ` ${notes.join('; ')}.`;
}

function reasonBreakdown(cell: LetterTally): string {
  return BUS_DEAD_LETTER_REASONS.map((kind) => `${REASON_LABEL[kind]} ${cell.reasons.get(kind) ?? 0}`).join(', ');
}

function addressPrompt(to: string, cell: LetterTally, truncated: boolean, skippedPages: number): string {
  const label = fieldText(to);
  const senders = [...cell.senders.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shownSenders = senders.slice(0, PROMPT_SENDERS_MAX).map(([from]) => fieldText(from));
  const senderText = senders.length === 0 ? 'no parseable sender recorded'
    : senders.length > shownSenders.length
      ? `${shownSenders.join(', ')} and ${senders.length - shownSenders.length} more`
      : shownSenders.join(', ');
  const kinds = tallyText(cell.kinds);
  const priorities = tallyText(cell.priorities);
  return [
    `Phantom's agent bus dead-letter sink shows mail to '${label}' keeps failing delivery — recorded dead letters that provably never landed, the self-improvement work this backlog exists for.`,
    '',
    `Inside the ${Math.round(BUS_DEAD_LETTER_WINDOW_MS / 86_400_000)}-day window the sink recorded ${cell.letters} dead letter(s) to this recipient across ${cell.days.size} distinct UTC day(s). Failure reasons: ${reasonBreakdown(cell)}.${cell.payloadDropped > 0 ? ` ${cell.payloadDropped} letter(s) kept only routing metadata — the original payload did not fit.` : ''}${spanText(cell)}${coverageNote(truncated, skippedPages)}`,
    '',
    `Original senders recorded: ${senderText}.${kinds === '' ? '' : ` Original kinds: ${kinds}.`}${priorities === '' ? '' : ` Letter priorities: ${priorities}.`}`,
    '',
    EVIDENCE,
    '',
    `Find why this route keeps losing mail: check whether '${label}' is still a live route — agent registry enrollment and callsign changes (src/core/agents/bus-identity.ts), router transport coverage for the role (docs/AGENT-BUS.md "Dead letters"; the router returns no-route when no transport serves it), and whether the consumer behind the address stopped polling or stopped acking (the file transport's poll/ack loop and acks ledger under bus-transport/). 'expired' letters mean the message's TTL ran out before delivery — compare the letter TTLs against the consumer's poll cadence; 'exhausted' means the retry budget ended — check the transport health and any send-gate or egress hold the fold cannot see. Fix the cause in this repository's bus machinery. ${NO_CHANGE}`,
  ].join('\n');
}

function reasonPrompt(kind: BusDeadLetterReason, cell: ReasonCell, truncated: boolean, skippedPages: number): string {
  const label = REASON_LABEL[kind];
  const recipients = [...cell.recipients.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = recipients.slice(0, PROMPT_RECIPIENTS_MAX).map(([to]) => `'${fieldText(to)}'`);
  const recipientText = recipients.length === 0 ? 'no parseable recipient recorded'
    : recipients.length > shown.length
      ? `${shown.join(', ')} and ${recipients.length - shown.length} more`
      : shown.join(', ');
  const unattributed = cell.unparsed > 0 ? ` ${cell.unparsed} letter(s) carried no parseable report — unattributable to any named route.` : '';
  const guidance: Record<BusDeadLetterReason, string> = {
    'no-route': 'no transport serves the role — check the router\'s route coverage for those addresses: agent registry enrollment, callsign renames, group room/topic subscribers and channel adapter registration (src/core/agents/bus-identity.ts, src/core/fleet/bus-transport.ts, docs/AGENT-BUS.md)',
    exhausted: 'the bounded retry budget ended without delivery — check whether the consumers behind those routes stopped polling or stopped acking, transport health, and the ack ledger under bus-transport/',
    expired: 'messages outlived their TTL before landing — compare the senders\' TTL choices against the consumers\' poll cadence, or whether the addressed seats were simply absent',
    other: 'the letters\' stored bodies no longer classify — check the sink\'s wire shape in createFileDeadLetterSink against the defensive report read (busDeadLetterReport in src/core/agents/bus-dead-letter.ts): a drifted contract dead-letters evidence nobody can read, and foreign posts to the reserved address land here too',
  };
  return [
    `Phantom's agent bus dead-letter sink shows '${label}' delivery failures recurring across ${cell.spread} distinct recipient bucket(s) — a fleet-wide routing or transport pattern rather than one dead route, the self-improvement work this backlog exists for.`,
    '',
    `Inside the ${Math.round(BUS_DEAD_LETTER_WINDOW_MS / 86_400_000)}-day window the sink recorded ${cell.letters} '${label}' dead letter(s) across ${cell.days.size} distinct UTC day(s), reaching ${cell.recipients.size} named recipient(s)${cell.unparsed > 0 ? ` plus ${cell.unparsed} unattributable` : ''}.${unattributed}${spanText(cell)}${coverageNote(truncated, skippedPages)}`,
    '',
    `Recipients recorded: ${recipientText}.`,
    '',
    EVIDENCE,
    '',
    `Find the systemic cause: ${guidance[kind]}. If the spread turns out to be one renamed seat or one retired room whose mail was never re-routed, the per-recipient cells name it — report no-change only when no fleet-level cause remains. Fix the cause in this repository's bus machinery rather than suppressing the letters. ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function addressItem(to: string, cell: LetterTally, repo: string, truncated: boolean, skippedPages: number): CloudBacklogItem {
  const label = fieldText(to);
  const display = label.length > 80 ? `${label.slice(0, 79)}…` : label;
  return {
    id: `busdl-addr-${sha(`busdl:addr:${to}`)}`,
    title: `Agent-bus mail to '${display}' keeps dead-lettering — ${cell.letters} letter(s) across ${cell.days.size} day(s)`.slice(0, MAX_TITLE_CHARS),
    prompt: addressPrompt(to, cell, truncated, skippedPages),
    area: 'agent-bus',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function reasonItem(kind: BusDeadLetterReason, cell: ReasonCell, repo: string, truncated: boolean, skippedPages: number): CloudBacklogItem {
  return {
    id: `busdl-reason-${kind}-${sha(`busdl:reason:${kind}`)}`,
    title: `Agent-bus '${REASON_LABEL[kind]}' dead letters recur across ${cell.spread} recipient bucket(s)`.slice(0, MAX_TITLE_CHARS),
    prompt: reasonPrompt(kind, cell, truncated, skippedPages),
    area: 'agent-bus',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

interface WalkResult {
  rows: DeadLetterRow[];
  /** True when the bounded walk could not prove it reached the store's end. */
  truncated: boolean;
  /** Pages that failed after the first proven one — folded pages still count, marked as a gap. */
  skippedPages: number;
}

/**
 * Bounded live-receipt walk over the bus inbox, collecting only the
 * envelopes addressed to the dead-letter sink. Mirrors the paging
 * probeDeadLetters and readBusDeadLetters run: a failed first page
 * proves nothing (the caller gets no rows), a later failure folds what
 * was proven and marks the walk truncated.
 */
function walkDeadLetters(root: string, nowMs: number): WalkResult | null {
  const rows: DeadLetterRow[] = [];
  let after = 0;
  let truncated = false;
  let skippedPages = 0;
  const clock = () => nowMs;
  for (let page = 0; page < BUS_DEAD_LETTER_MAX_PAGES; page++) {
    const result = listBusInboxAfter(after, BUS_INBOX_MAX_READ, { root, now: clock });
    if (result.status !== 'ok') {
      if (page === 0) return null;
      skippedPages += 1;
      truncated = true;
      break;
    }
    for (const receipt of result.messages) {
      if (receipt.envelope.to !== BUS_DEAD_LETTER_ADDRESS) continue;
      const report = busDeadLetterReport(receipt.envelope.body);
      rows.push({
        cursor: receipt.cursor,
        receivedAt: receipt.receivedAt,
        priority: receipt.envelope.priority,
        report,
        reasonKind: busDeadLetterReason(report),
      });
    }
    if (result.messages.length < BUS_INBOX_MAX_READ) return { rows, truncated, skippedPages };
    if (result.nextCursor <= after) { truncated = true; break; }
    after = result.nextCursor;
  }
  return { rows, truncated: true, skippedPages };
}

/**
 * Backlog items for the bus dead-letter sink's recurring per-recipient
 * and per-reason cells. Total: another repository, a degraded store, a
 * failed first page or any walk failure yields no items rather than
 * throwing into discovery.
 */
export async function busDeadLetterBacklogItems(opts: BusDeadLetterItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(nowMs)) return [];
    const root = opts.root ?? join(ashlrHome(), 'fleet');
    const store = inspectBusInbox({ root, now: () => nowMs });
    if (store.source !== 'available') return [];
    const walk = walkDeadLetters(root, nowMs);
    if (walk === null) return [];
    const folded = foldBusDeadLetterCells(walk.rows, nowMs, opts.windowMs ?? BUS_DEAD_LETTER_WINDOW_MS);

    interface Candidate { letters: number; days: number; key: string; item: (repo: string) => CloudBacklogItem }
    const candidates: Candidate[] = [];
    for (const [kind, cell] of folded.reasonCells) {
      candidates.push({
        letters: cell.letters, days: cell.days.size, key: `reason:${kind}`,
        item: (target) => reasonItem(kind, cell, target, walk.truncated, walk.skippedPages),
      });
    }
    for (const [to, cell] of folded.addressCells) {
      candidates.push({
        letters: cell.letters, days: cell.days.size, key: `addr:${to}`,
        item: (target) => addressItem(to, cell, target, walk.truncated, walk.skippedPages),
      });
    }
    candidates.sort((a, b) => b.letters - a.letters || b.days - a.days || a.key.localeCompare(b.key));
    const limit = Math.max(1, Math.min(opts.limit ?? BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS, BUS_DEAD_LETTER_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((candidate) => candidate.item(repo));
  } catch {
    return [];
  }
}
