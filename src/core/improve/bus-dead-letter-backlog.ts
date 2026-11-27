/**
 * Agent Bus dead-letter sink → self-improvement backlog items.
 *
 * Every envelope the transport router gives up on — delivery attempts
 * exhausted, the original TTL lapsed, or no transport candidate for the
 * recipient — is filed by createFileDeadLetterSink in
 * src/core/fleet/bus-transport-file.ts as a `status` envelope addressed
 * to the reserved `bus.dead-letter` label in the same bus inbox store
 * ordinary mail uses (<ashlr home>/fleet/bus-inbox, snapshot v2 read
 * through inspectBusInbox/listBusInboxAfter in
 * src/core/fleet/bus-inbox.ts). The letter's wire id derives from the
 * original envelope id (`dl-<sha256[:40]>`), so one retained letter is
 * one distinct lost message — a retried dead-letter of the same
 * envelope dedupes at the store rather than counting twice. Each
 * letter's body.payload.deadLetter summary keeps the original routing
 * metadata (id, from, to, kind, priority, correlationId, reason,
 * deadLetteredAt, last-50 attempts) plus payloadDropped and the kept
 * transport envelope when it fit.
 *
 * Until now the sink's only readers were point-in-time surfaces —
 * `agents bus dead-letters` (readBusDeadLetters in
 * src/core/agents/bus-dead-letters.ts), the `agents bus status`
 * deadLetters probe, the unified inbox's bus-dead-letter items and
 * work mine's deadLetters section — current queue state, never a
 * trend. A recipient whose mail keeps dead-lettering is present-tense
 * evidence the bus is losing work: a retired or unresolvable address
 * ('no-route'), a consumer whose drain cadence loses to sender TTLs
 * ('expired'), or transports that keep failing deliveries
 * ('exhausted').
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The store is walked once through the same bounded
 *    inspectBusInbox + listBusInboxAfter paging the status probe and
 *    the dead-letters reader run; nothing is written and no lock,
 *    process or network is touched. A verified-missing store yields
 *    no items (no bus traffic ever recorded is an honest empty, not
 *    unknown), an unreadable or churn-bound walk yields no items —
 *    unknown stays unknown, never a guessed tally — and a walk that
 *    cannot reach the store's end folds the retained prefix with the
 *    prompts stating every count as a lower bound.
 *  - Letters count only under the sink's wire contract: an envelope
 *    addressed to `bus.dead-letter` whose body parses through
 *    busDeadLetterReport, classified by busDeadLetterReason into the
 *    closed DeadLetterReason set ('exhausted' | 'expired' |
 *    'no-route' | 'other'). A letter whose body carries no parseable
 *    report still counts — reason 'other', recipient '(unrecorded)' —
 *    because recurring unparseable letters are themselves evidence
 *    the sink's wire shape broke or a foreign writer is posting to
 *    the address.
 *  - Recurring means recorded across days. A cell emits only after
 *    BUS_DEAD_LETTER_MIN_ROWS live letters for one (reason,
 *    recipient) pair inside the retained window span
 *    BUS_DEAD_LETTER_MIN_DAYS distinct UTC days of receipt — one dead
 *    letter is an incident, not a pattern. There is no staleness bar:
 *    a dead letter is already the terminal failure record (the mail
 *    provably never landed), so every live letter is adverse evidence
 *    the moment it is filed. listBusInboxAfter already skips expired
 *    receipts, so the fold sees exactly the population every other
 *    dead-letter surface sees.
 *  - The bus carries no repository column and the sink is this
 *    install's transport machinery, so items emit only when the
 *    backlog target's repository name is 'phantom' — the same
 *    last-segment rule the sibling fleet-evidence sources apply.
 *  - Stored envelopes are untrusted data: every report string is
 *    scrubSecrets-ed, control characters flattened, whitespace
 *    collapsed and clipped before it can reach a title or prompt,
 *    sender labels are counted never quoted, and every prompt string
 *    past the fixed scaffolding is a clipped recorded label.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    cell's (reason, recipient) identity (never the counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  BUS_DEAD_LETTER_ADDRESS,
  busDeadLetterReason,
  busDeadLetterReport,
  type BusDeadLetterReason,
} from '../agents/bus-dead-letter.js';
import { BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, inspectBusInbox, listBusInboxAfter } from '../fleet/bus-inbox.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by reasons × distinct recipients, capped for sanity. */
export const BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS = 8;
const BUS_DEAD_LETTER_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the same convention the sibling feeds anchor on — also the letters' own TTL. */
export const BUS_DEAD_LETTER_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on receipt timestamps, same convention the sibling folds tolerate. */
const BUS_DEAD_LETTER_FUTURE_SKEW_MS = 60_000;
/** Dead letters a (reason, recipient) cell needs before its recurrence counts. */
export const BUS_DEAD_LETTER_MIN_ROWS = 3;
/** Distinct UTC days those letters must span — recurring means recorded across days. */
export const BUS_DEAD_LETTER_MIN_DAYS = 2;
/**
 * Bounded walk: enough pages to reach the store's own row cap, plus one
 * for the short-page proof — the same bound readBusDeadLetters applies.
 */
const BUS_DEAD_LETTER_MAX_PAGES = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Recorded-label clip: routing labels are already bounded printable ASCII, but stored bodies are untrusted — scrub, flatten and bound before display. */
const LABEL_MAX_CHARS = 96;
/** The fleet's own repository label: bus evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Cell identity for letters whose report proves no recipient — distinct from any recorded label. */
const UNRECORDED = '(unrecorded)';

export interface BusDeadLetterItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Fleet root override (default: the bus store's own $ASHLR_HOME/fleet resolution). */
  busRoot?: string;
  /** Clock anchoring the window (default: now). */
  now?: Date;
  /** Window in ms (default BUS_DEAD_LETTER_WINDOW_MS). */
  windowMs?: number;
  /** Most items one call emits (default BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** One validated dead-letter receipt: the classified report facts plus the letter's own store stamps. */
export interface BusDeadLetterEvidence {
  /** Store cursor — the letter's stable identity inside the retained snapshot. */
  cursor: number;
  /** Receipt time in epoch ms — when the letter entered the store. */
  receivedAtMs: number;
  /** Classified failure reason (the closed DeadLetterReason set). */
  reason: BusDeadLetterReason;
  /** Clipped original-recipient routing label, or null when the report proves none. */
  to: string | null;
  /** Clipped original-sender routing label, or null. */
  from: string | null;
  /** Clipped original envelope kind, or null. */
  kind: string | null;
  /** Delivery attempts the report counted, or null. */
  attempts: number | null;
  /** Whether the router dropped the original payload to fit the letter cap. */
  payloadDropped: boolean;
  /** The letter's own P0..P3 band (inherited from the original envelope). */
  priority: string;
  /** Whether the body parsed through busDeadLetterReport — false means the letter's report facts are all absent by contract, not by guess. */
  parsed: boolean;
}

/** One evidence cell's tally: every live dead letter on one (reason, recipient) pair. */
export interface BusDeadLetterCell {
  /** The classified failure reason. */
  reason: BusDeadLetterReason;
  /** The cell's recipient identity: the clipped recorded label or UNRECORDED. */
  to: string;
  /** Stable cell identity for item ids and dedupe. */
  key: string;
  /** Live letters inside the window for this pair. */
  rows: number;
  /** Of those, letters whose body carried no parseable deadLetter report. */
  unparsed: number;
  /** Distinct UTC days (of letter receipt) those letters fall on. */
  days: Set<string>;
  firstAtMs: number;
  lastAtMs: number;
  /** Distinct clipped sender labels seen (counted, never emitted). */
  senders: Set<string>;
  /** Original envelope kinds tallied (clipped labels → count). */
  kinds: Map<string, number>;
  /** Letters whose router dropped the original payload. */
  payloadDropped: number;
  /** Letters in the P0/P1 bands — the original work's own urgency. */
  urgent: number;
  /** Delivery attempts the cell's parseable reports recorded between them. */
  attemptsTotal: number;
  /** Letters whose report recorded no attempt count. */
  attemptsUnrecorded: number;
}

/** Present-tense totals across every live letter, reported as context and never as cells. */
export interface BusDeadLetterContext {
  /** Live dead letters inside the window, all reasons and recipients. */
  letters: number;
  /** Letters whose body carried no parseable deadLetter report. */
  unparsed: number;
  /** Letters whose router dropped the original payload to fit the letter cap. */
  payloadDropped: number;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/** Scrub, flatten control characters, collapse whitespace and bound one recorded label for display. */
function clipLabel(value: string | null): string | null {
  if (value === null) return null;
  // eslint-disable-next-line no-control-regex
  const flat = scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat === '') return null;
  return flat.length > LABEL_MAX_CHARS ? `${flat.slice(0, LABEL_MAX_CHARS - 1)}…` : flat;
}

/**
 * Pure: fold validated dead-letter evidence into per-(reason,
 * recipient) adverse cells plus the fleet-wide context counts.
 * Windowing is on the letter's receipt stamp; the recurring bars and
 * the distinct-days bar are applied here.
 */
export function foldBusDeadLetterCells(
  rows: readonly BusDeadLetterEvidence[],
  nowMs: number,
  windowMs: number = BUS_DEAD_LETTER_WINDOW_MS,
): { cells: BusDeadLetterCell[]; context: BusDeadLetterContext } {
  const windowStart = nowMs - windowMs;
  const futureCeil = nowMs + BUS_DEAD_LETTER_FUTURE_SKEW_MS;
  const cells = new Map<string, BusDeadLetterCell>();
  const context: BusDeadLetterContext = { letters: 0, unparsed: 0, payloadDropped: 0 };
  const seen = new Set<number>();
  for (const row of rows) {
    if (seen.has(row.cursor)) continue;
    seen.add(row.cursor);
    if (row.receivedAtMs < windowStart || row.receivedAtMs > futureCeil) continue;
    context.letters += 1;
    if (!row.parsed) context.unparsed += 1;
    if (row.payloadDropped) context.payloadDropped += 1;
    const to = row.to ?? UNRECORDED;
    const key = `${row.reason}:${to}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = {
        reason: row.reason, to, key, rows: 0, unparsed: 0, days: new Set(),
        firstAtMs: Infinity, lastAtMs: -Infinity,
        senders: new Set(), kinds: new Map(), payloadDropped: 0, urgent: 0,
        attemptsTotal: 0, attemptsUnrecorded: 0,
      };
      cells.set(key, cell);
    }
    cell.rows += 1;
    if (!row.parsed) cell.unparsed += 1;
    cell.days.add(utcDayOf(row.receivedAtMs));
    cell.firstAtMs = Math.min(cell.firstAtMs, row.receivedAtMs);
    cell.lastAtMs = Math.max(cell.lastAtMs, row.receivedAtMs);
    if (row.from !== null) cell.senders.add(row.from);
    if (row.kind !== null) cell.kinds.set(row.kind, (cell.kinds.get(row.kind) ?? 0) + 1);
    if (row.payloadDropped) cell.payloadDropped += 1;
    if (row.priority === 'P0' || row.priority === 'P1') cell.urgent += 1;
    if (row.attempts === null) cell.attemptsUnrecorded += 1;
    else cell.attemptsTotal += row.attempts;
  }
  const recurring = [...cells.values()]
    .filter((cell) => cell.rows >= BUS_DEAD_LETTER_MIN_ROWS && cell.days.size >= BUS_DEAD_LETTER_MIN_DAYS)
    .sort((a, b) => b.rows - a.rows || b.lastAtMs - a.lastAtMs || a.key.localeCompare(b.key));
  return { cells: recurring, context };
}

type DeadLetterScan =
  | { status: 'ok'; rows: BusDeadLetterEvidence[]; truncated: boolean }
  | { status: 'missing' | 'unavailable' };

/**
 * Read the live dead-letter population through the same bounded walk the
 * status probe and the dead-letters reader run: inspectBusInbox gates the
 * store, then listBusInboxAfter pages live receipts (expired rows are
 * already skipped by the reader). A page failure after the first folds
 * the retained prefix as a lower bound; a first-page failure or an
 * unreadable store reports unavailable — never an empty page pretending
 * health.
 */
function scanDeadLetters(busRoot: string | undefined, nowMs: number): DeadLetterScan {
  const now = () => nowMs;
  const store = inspectBusInbox({ root: busRoot, now });
  if (store.source === 'missing') return { status: 'missing' };
  if (store.source !== 'available') return { status: 'unavailable' };
  const rows: BusDeadLetterEvidence[] = [];
  let cursor = 0, truncated = false;
  for (let page = 0; page < BUS_DEAD_LETTER_MAX_PAGES; page += 1) {
    const result = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, { root: busRoot, now });
    if (result.status !== 'ok') {
      if (page === 0) return { status: 'unavailable' };
      truncated = true;
      break;
    }
    for (const receipt of result.messages) {
      const envelope = receipt.envelope;
      if (envelope.to !== BUS_DEAD_LETTER_ADDRESS) continue;
      const report = busDeadLetterReport(envelope.body);
      rows.push({
        cursor: receipt.cursor,
        receivedAtMs: receipt.receivedAt,
        reason: busDeadLetterReason(report),
        to: clipLabel(report?.to ?? null),
        from: clipLabel(report?.from ?? null),
        kind: clipLabel(report?.kind ?? null),
        attempts: report?.attempts ?? null,
        payloadDropped: report?.payloadDropped ?? false,
        priority: envelope.priority,
        parsed: report !== null,
      });
    }
    cursor = result.nextCursor;
    if (result.messages.length < BUS_INBOX_MAX_READ) break;
    if (page === BUS_DEAD_LETTER_MAX_PAGES - 1) truncated = true;
  }
  return { status: 'ok', rows, truncated };
}

/** The evidence pointers every prompt shares; the writer, its store contract and its consumers are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the bus inbox store\'s live `bus.dead-letter` letters — `status` envelopes the transport router\'s dead-letter sink (createFileDeadLetterSink in src/core/fleet/bus-transport-file.ts, fed by the router\'s deadLetter path in src/core/fleet/bus-transport.ts) files when delivery gives up: \'exhausted\' (the attempt budget ran out), \'expired\' (the original TTL lapsed) or \'no-route\' (no transport candidate for the recipient). The store lives at <ashlr home>/fleet/bus-inbox — inspectBusInbox and listBusInboxAfter in src/core/fleet/bus-inbox.ts resolve $ASHLR_HOME/fleet or the default Ashlr home — and retains each letter 7 days (BUS_DEAD_LETTER_TTL_MS); listBusInboxAfter already skips expired receipts, so every counted letter is live retained evidence. Each letter\'s id derives from the original envelope id (dl-<sha256[:40]>), so one letter is one distinct lost message and a retried dead-letter of the same envelope dedupes at the store. Until this feed the sink\'s only readers were point-in-time surfaces — `agents bus dead-letters` (readBusDeadLetters in src/core/agents/bus-dead-letters.ts), the `agents bus status` deadLetters probe, the unified inbox\'s bus-dead-letter items and work mine\'s deadLetters section — current queue state, never a trend.';

const NO_CHANGE = 'If the bus carried little traffic in the window, the counted recipients were retired addresses nobody still mails, the failing transports were down for a bounded incident that has since recovered, the payloadDropped letters reflect envelopes too large for the letter cap by design, unparseable letters came from a one-off foreign write, or the recorded window no longer reproduces on the default branch — report no-change and name the evidence.';

function coverageNote(truncated: boolean): string {
  return truncated ? ' The bounded walk could not reach the store\'s end, so every count is a lower bound.' : '';
}

function spanText(cell: BusDeadLetterCell): string {
  if (!Number.isFinite(cell.firstAtMs) || !Number.isFinite(cell.lastAtMs)) return '';
  const first = new Date(cell.firstAtMs).toISOString();
  const last = new Date(cell.lastAtMs).toISOString();
  return first === last ? ` Recorded ${first}.` : ` Recorded ${first} through ${last}.`;
}

function recipientText(cell: BusDeadLetterCell): string {
  return cell.to === UNRECORDED ? 'an unrecorded recipient' : `'${cell.to}'`;
}

function reasonNote(cell: BusDeadLetterCell): string {
  const unparsedNote = cell.unparsed > 0
    ? ` ${cell.unparsed} of them carried no parseable deadLetter report — a foreign write to the address or a broken sink wire.`
    : '';
  switch (cell.reason) {
    case 'exhausted':
      return `each is a distinct original envelope whose delivery attempt budget ran out — the router retried across registered transports and none landed; the letter keeps the last attempts' transport/outcome trail for diagnosis.${unparsedNote}`;
    case 'expired':
      return `each is a distinct original envelope whose own TTL lapsed before any transport delivered it — the recipient's drain cadence lost the race against the sender's deadline.${unparsedNote}`;
    case 'no-route':
      return `each is a distinct original envelope the router found no transport candidate for — the recipient address resolves to nothing the registered transports serve: a retired seat, an unregistered channel, or an identity-resolution gap.${unparsedNote}`;
    default:
      return cell.to === UNRECORDED
        ? `each is a letter addressed to bus.dead-letter whose body carries no parseable deadLetter report — recurring unparseable letters mean a foreign writer is posting to the address or the sink's wire shape broke.${unparsedNote}`
        : `each is a distinct letter whose recorded failure reason sits outside the router's closed set — the sink's reason vocabulary and the fold's classification disagree, or a foreign writer mimics the address.${unparsedNote}`;
  }
}

function kindsText(cell: BusDeadLetterCell): string {
  const entries = [...cell.kinds.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return '';
  const shown = entries.slice(0, 3).map(([kind, count]) => `${count} '${kind}'`).join(', ');
  const rest = entries.length - Math.min(entries.length, 3);
  return ` Original kinds: ${shown}${rest > 0 ? `, +${rest} more` : ''}.`;
}

function cellTitle(cell: BusDeadLetterCell): string {
  const tail = ` — ${cell.rows} letter(s) across ${cell.days.size} day(s)`;
  if (cell.reason === 'other') {
    return ((cell.to === UNRECORDED
      ? 'Dead-letter letters keep arriving without a parseable report'
      : `Dead-letter reports to '${cell.to}' keep carrying unclassifiable reasons`) + tail).slice(0, MAX_TITLE_CHARS);
  }
  const how = cell.reason === 'exhausted' ? 'exhausting delivery attempts'
    : cell.reason === 'expired' ? 'expiring before delivery'
    : 'dead-lettering with no route';
  const what = cell.to === UNRECORDED ? 'Dead letters' : `Bus mail to '${cell.to}'`;
  return `${what} ${cell.to === UNRECORDED ? 'keep' : 'keeps'} ${how}${tail}`.slice(0, MAX_TITLE_CHARS);
}

function cellPrompt(cell: BusDeadLetterCell, context: BusDeadLetterContext, truncated: boolean): string {
  const urgentText = cell.urgent > 0 ? ` ${cell.urgent} of them sat in the P0/P1 bands — the lost work's own urgency.` : '';
  const droppedText = cell.payloadDropped > 0
    ? ` ${cell.payloadDropped} of them dropped the original payload to fit the letter cap — routing metadata only survives.`
    : '';
  const attemptsText = cell.attemptsTotal + cell.attemptsUnrecorded > 0
    ? ` The letters record ${cell.attemptsTotal} delivery attempt(s) between them${cell.attemptsUnrecorded > 0 ? `; ${cell.attemptsUnrecorded} recorded no attempt count` : ''}.`
    : '';
  const unparsedContext = context.unparsed > cell.unparsed
    ? ` ${context.unparsed - cell.unparsed} further live letter(s) elsewhere in the window also carried no parseable report.`
    : '';
  return [
    `Phantom's agent bus dead-letter sink shows ${recipientText(cell)} accumulating '${cell.reason}' dead letters — the self-improvement work this backlog exists for.`,
    '',
    `Inside the retained window the bus inbox holds ${cell.rows} live dead letter(s) for this pair across ${cell.days.size} distinct UTC day(s)${cell.senders.size > 0 ? `, from ${cell.senders.size} distinct sender(s)` : ''}.${spanText(cell)}${urgentText}${droppedText}${attemptsText}${unparsedContext}${coverageNote(truncated)}`,
    '',
    `${reasonNote(cell)}${kindsText(cell)}`,
    '',
    EVIDENCE,
    '',
    `Find why these letters keep filing: reproduce with \`agents bus dead-letters --json\` (filter --reason/--to/--channel/--topic on the same store) and read each letter's kept attempt trail — the transport names and outcomes say which leg failed. For 'no-route' check identity resolution and transport registration for the counted recipient (resolveAgent/readAgentRegistry in src/core/agents/bus-identity.ts, the channel registry, seat bindings); for 'expired' compare the recipient transport's poll/drain cadence against the original envelope TTL; for 'exhausted' check whether one transport dominates the failures and why it keeps erroring; for unparseable letters check whether anything besides createFileDeadLetterSink posts to bus.dead-letter. Fix the cause in this repository rather than muting the sink. ${NO_CHANGE}`,
  ].join('\n');
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

function cellItem(cell: BusDeadLetterCell, context: BusDeadLetterContext, repo: string, truncated: boolean): CloudBacklogItem {
  return {
    id: `busdl-${sha(`busdl:${cell.key}`)}`,
    title: cellTitle(cell),
    prompt: cellPrompt(cell, context, truncated),
    area: 'bus-dead-letter',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/**
 * Backlog items for the dead-letter sink's recurring per-(reason,
 * recipient) cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function busDeadLetterBacklogItems(opts: BusDeadLetterItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(nowMs)) return [];
    const scan = scanDeadLetters(opts.busRoot, nowMs);
    if (scan.status !== 'ok') return [];
    const folded = foldBusDeadLetterCells(scan.rows, nowMs, opts.windowMs ?? BUS_DEAD_LETTER_WINDOW_MS);
    const limit = Math.max(1, Math.min(opts.limit ?? BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS, BUS_DEAD_LETTER_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of folded.cells) {
      if (items.length >= limit) break;
      items.push(cellItem(cell, folded.context, repo, scan.truncated));
    }
    return items;
  } catch {
    return [];
  }
}
