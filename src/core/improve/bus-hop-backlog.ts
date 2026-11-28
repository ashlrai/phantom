/**
 * Agent bus hoplog → self-improvement backlog items.
 *
 * Every accepted agent-bus send appends one observational hop to
 * ~/.ashlr/fleet/bus/hops.jsonl (appendBusHop in
 * src/core/fleet/bus-hoplog.ts, called by the bus-wake hook, the event
 * bus and the board publisher): {id, from, to, inputTokens,
 * outputTokens} — the send's measured token usage, null when the
 * transport did not measure it. The log is bounded at 8 MiB and every
 * consumer reads only a bounded tail.
 *
 * Until now the hoplog's only readers were point-in-time surfaces —
 * `agents bus status`, the fleet-bus web view and the hop summaries —
 * so two recorded patterns never became work:
 *
 *  - Unmeasured sends. A sender whose retained hops systematically
 *    carry no token counts is a transport path that does not measure
 *    usage: the fleet's bus coordination cost is partially unmeasured
 *    and every cost fold that reads this log (bus status totals, hop
 *    summaries) silently covers only the measured subset. Per-sender
 *    cells emit when a sender's hops inside the retained tail are
 *    mostly unmeasured.
 *  - Concentrated spend. One sender→recipient pair accounting for a
 *    dominant share of the recorded hop tokens is either warranted
 *    heavy coordination or oversized payloads and retry storms — the
 *    hoplog cannot tell which, so the item asks the session to find
 *    out. Pair cells emit only at a share-and-floor bar so a small or
 *    evenly spread log never queues a session.
 *
 * busHopBacklogItems carries both into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue them
 * like the sibling fleet-evidence sources.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The hoplog is read once through readBusHopsDetailed's
 *    bounded, custody-checked tail read; nothing is written and no
 *    network is touched. A missing log is a clean empty source — the
 *    bus simply never ran here — while an unreadable one (unsafe
 *    custody, unstable read, nonregular file) yields one degraded
 *    item, because every hop consumer is then blind.
 *  - The retained tail IS the window. Hops carry no timestamp, so no
 *    recency window can be applied honestly; cells count the hops the
 *    bounded read returned and the prompt states the read bounds and
 *    every truncation flag (byte cut, row cap, partial final row,
 *    skipped invalid rows) as covering the retained tail only.
 *  - Unknown stays unknown. A hop missing either token field is
 *    unmeasured for coverage purposes; pair token totals sum only
 *    recorded fields and are labelled lower bounds when unmeasured
 *    hops exist — never estimated, never zero-filled.
 *  - Sender and recipient ids are validated bus participant names
 *    (busMessageIds' printable non-space shape, scrub-checked at
 *    write); they are scrubbed, flattened and capped again before
 *    reaching a prompt, and hashed — never raw — into item ids.
 *  - The bus describes this install's machinery and carries no repo
 *    column, so items emit only when the backlog target's repository
 *    name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply.
 *  - Dedup is downstream. Item ids hash the cell identity — sender or
 *    pair — never the counts, so a refresh re-derives the same ids and
 *    appendUserBacklogItems adds only what is new; a pattern that
 *    clears simply stops re-adding.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { BUS_HOPLOG_MAX_BYTES, type BusHop } from '../fleet/bus-hoplog.js';
import { readBusHopsDetailed, type BusHopReadResult } from '../fleet/bus-hoplog-reader.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by distinct senders and pairs in the retained tail. */
export const BUS_HOP_MAX_ITEMS = 8;
const BUS_HOP_ITEM_HARD_MAX = 25;
/**
 * Evidence floor: below this many validated hops in the retained tail
 * no cell emits — a handful of sends cannot evidence a pattern, the
 * same role the sibling feeds' minimum-count bars play.
 */
export const BUS_HOP_MIN_HOPS = 40;
/** Per-sender floor: a sender needs this many retained hops before its coverage is judged. */
export const BUS_HOP_MIN_SENDER_HOPS = 20;
/** Unmeasured bar: strictly more than half of a sender's hops lack full token counts. */
export const BUS_HOP_UNMEASURED_SHARE = 0.5;
/** Concentration bar: the top pair's recorded tokens must reach this share of all recorded hop tokens. */
export const BUS_HOP_CONCENTRATION_SHARE = 0.6;
/** Absolute floor so a small measured total cannot read as concentration. */
export const BUS_HOP_MIN_PAIR_TOKENS = 100_000;
/** A concentrated pair must repeat: this many hops minimum. */
export const BUS_HOP_MIN_PAIR_HOPS = 8;
/** Enough measured hops (at least one token field known) for a share to mean anything. */
export const BUS_HOP_MIN_MEASURED_HOPS = 20;
/** Reader bounds: the whole retained log, capped by the reader's own row ceiling. */
const BUS_HOP_READ_MAX_ROWS = 10_000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded participant ids are unbounded text; flatten and cap before they reach a prompt. */
const MAX_FIELD_CHARS = 96;
/** The fleet's own repository label: bus evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface BusHopItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Hoplog override (default: busHoplogPath() under ASHLR_HOME or ~/.ashlr). */
  hoplogFile?: string;
  /** Tail byte bound for the read (default: the full BUS_HOPLOG_MAX_BYTES retained log). */
  maxBytes?: number;
  /** Tail row bound for the read (default: the reader's 10,000-row ceiling). */
  maxRows?: number;
  /** Most items one call emits (default BUS_HOP_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Journal-recorded fields are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;
const int = (value: number): string => value.toLocaleString('en-US');

/** A hop counts as measured only when BOTH token fields were recorded — either missing field is unmeasured usage. */
function hopMeasured(hop: BusHop): boolean {
  return hop.inputTokens !== null && hop.outputTokens !== null;
}

/** A hop reports at least one token field — partial usage still contributes recorded tokens to pair totals. */
function hopReported(hop: BusHop): boolean {
  return hop.inputTokens !== null || hop.outputTokens !== null;
}

/** Known token total of one hop: recorded fields only, missing fields contribute nothing (a lower bound, never an estimate). */
function hopKnownTokens(hop: BusHop): number {
  return (hop.inputTokens ?? 0) + (hop.outputTokens ?? 0);
}

/** One sender's retained-hop coverage cell. */
export interface BusHopSenderCell {
  kind: 'unmeasured';
  /** The sender participant id every counted hop named. */
  sender: string;
  /** The sender's hops inside the retained tail. */
  hops: number;
  /** Of those, hops lacking full token counts (either field null). */
  unmeasured: number;
}

/** One sender→recipient pair's retained spend cell. */
export interface BusHopPairCell {
  kind: 'concentrated';
  /** The sender participant id. */
  from: string;
  /** The recipient participant id. */
  to: string;
  /** The pair's hops inside the retained tail. */
  hops: number;
  /** The pair's recorded (known-field) token total — a lower bound when its hops carry unknown fields. */
  tokens: number;
  /** tokens / all recorded hop tokens in the tail. */
  share: number;
}

export type BusHopCell = BusHopSenderCell | BusHopPairCell;

/**
 * Pure: fold validated hop rows into backlog cells. `hops` is the
 * reader's retained tail in file order; no timestamp exists, so the
 * tail itself is the evidence window and callers must say so.
 */
export function foldBusHopCells(hops: readonly BusHop[]): BusHopCell[] {
  if (hops.length < BUS_HOP_MIN_HOPS) return [];
  const senders = new Map<string, { hops: number; unmeasured: number }>();
  const pairs = new Map<string, { from: string; to: string; hops: number; tokens: number }>();
  let reportedHops = 0;
  let recordedTokens = 0;
  for (const hop of hops) {
    let sender = senders.get(hop.from);
    if (sender === undefined) {
      sender = { hops: 0, unmeasured: 0 };
      senders.set(hop.from, sender);
    }
    sender.hops += 1;
    if (!hopMeasured(hop)) sender.unmeasured += 1;
    if (hopReported(hop)) reportedHops += 1;
    const known = hopKnownTokens(hop);
    recordedTokens += known;
    const key = `${hop.from} ${hop.to}`;
    let pair = pairs.get(key);
    if (pair === undefined) {
      pair = { from: hop.from, to: hop.to, hops: 0, tokens: 0 };
      pairs.set(key, pair);
    }
    pair.hops += 1;
    pair.tokens += known;
  }

  const cells: BusHopCell[] = [];
  for (const [sender, cell] of senders) {
    if (cell.hops < BUS_HOP_MIN_SENDER_HOPS) continue;
    if (cell.unmeasured / cell.hops <= BUS_HOP_UNMEASURED_SHARE) continue;
    cells.push({ kind: 'unmeasured', sender, hops: cell.hops, unmeasured: cell.unmeasured });
  }
  if (reportedHops >= BUS_HOP_MIN_MEASURED_HOPS && recordedTokens > 0) {
    const ranked = [...pairs.values()]
      .filter((pair) => pair.hops >= BUS_HOP_MIN_PAIR_HOPS && pair.tokens / recordedTokens >= BUS_HOP_CONCENTRATION_SHARE && pair.tokens >= BUS_HOP_MIN_PAIR_TOKENS)
      .sort((a, b) => b.tokens - a.tokens || (a.from === b.from ? (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) : a.from < b.from ? -1 : 1));
    for (const pair of ranked) {
      cells.push({ kind: 'concentrated', from: pair.from, to: pair.to, hops: pair.hops, tokens: pair.tokens, share: pair.tokens / recordedTokens });
    }
  }
  // Unmeasured coverage gaps outrank concentration: they decide whether the
  // token evidence itself can be trusted. Deterministic order inside each band.
  const codeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  cells.sort((a, b) => {
    const band = (c: BusHopCell) => (c.kind === 'unmeasured' ? 0 : 1);
    if (band(a) !== band(b)) return band(a) - band(b);
    if (a.kind === 'unmeasured' && b.kind === 'unmeasured') {
      return b.unmeasured - a.unmeasured || codeUnit(a.sender, b.sender);
    }
    if (a.kind === 'concentrated' && b.kind === 'concentrated') {
      return b.tokens - a.tokens || (a.from === b.from ? codeUnit(a.to, b.to) : codeUnit(a.from, b.from));
    }
    return 0;
  });
  return cells;
}

/** How the bounded read covered the log — stated in every prompt so counts are never read as complete history. */
function coverageText(result: BusHopReadResult): string {
  const parts = [`the retained tail of ${int(result.hops.length)} validated hop(s)`];
  if (result.byteTruncated) parts.push('older bytes outside the read window were not scanned');
  if (result.rowTruncated) parts.push('the row cap kept only the newest hops');
  if (result.partialFinalRow) parts.push('an unfinished final row was excluded');
  if (result.invalidRows > 0) parts.push(`${int(result.invalidRows)} malformed row(s) were skipped`);
  return parts.join('; ') + '.';
}

const EVIDENCE = 'The evidence is fleet/bus/hops.jsonl under the Phantom state directory (~/.ashlr or $ASHLR_HOME): one JSON line per accepted agent-bus send — {id, from, to, inputTokens, outputTokens} — appended by appendBusHop (src/core/fleet/bus-hoplog.ts) from the bus-wake hook (src/core/fleet/bus-wake.ts), the event bus and the board publisher, with token fields null when the transport did not measure usage. `agents bus status` and the fleet-bus surfaces read the same log for display; this fold reads it through readBusHopsDetailed (src/core/fleet/bus-hoplog-reader.ts), the same bounded custody-checked tail read. Hops carry no timestamp: the retained tail is the whole window.';

const NO_CHANGE = 'If the retained tail has rolled forward and the pattern cleared, the unmeasured hops came from a transport that legitimately reports no usage (a local or file transport with nothing to meter), the concentrated pair is warranted heavy coordination between two busy seats, or the cause is owner-only or pinned ops machinery — report no-change and name the evidence.';

function unmeasuredPrompt(cell: Extract<BusHopCell, { kind: 'unmeasured' }>, result: BusHopReadResult): string {
  const sender = fieldText(cell.sender);
  const share = cell.unmeasured / cell.hops;
  return [
    `Agent bus sender '${sender}' recorded ${cell.unmeasured} of its ${cell.hops} retained hop(s) without full token counts (${pct(share)}) — the self-improvement work this backlog exists for.`,
    '',
    `Every hop is one accepted bus send; a hop whose inputTokens or outputTokens is null is incompletely measured — the transport recorded at most one side of the send's usage. ${coverageText(result)}`,
    '',
    EVIDENCE,
    '',
    `A sender that systematically drops token counts leaves the fleet's bus coordination cost unmeasured: bus status totals and hop summaries cover only the measured subset, and any cost or efficiency fold over this log inherits the blind spot. Find which send path '${sender}' uses — sendWithBusWake callers whose send returns no counts, transports that never measure, or callers bypassing the wake hook — and wire usage reporting so the hop records real counts, or document why that transport cannot measure. If the sender is a local/file transport with legitimately nothing to meter, or the tail has since rolled to measured hops — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function concentratedPrompt(cell: Extract<BusHopCell, { kind: 'concentrated' }>, result: BusHopReadResult, reportedHops: number): string {
  const from = fieldText(cell.from);
  const to = fieldText(cell.to);
  return [
    `Agent bus pair '${from}' → '${to}' accounts for ${pct(cell.share)} of the ${int(cell.tokens)} recorded hop token(s) across its ${cell.hops} retained hop(s) — the self-improvement work this backlog exists for.`,
    '',
    `Token totals sum only recorded fields: ${int(reportedHops)} of ${int(result.hops.length)} retained hops carried at least one token count, so pair shares are lower bounds wherever hops went unmeasured. ${coverageText(result)}`,
    '',
    EVIDENCE,
    '',
    `A dominant pair is either warranted heavy coordination or a symptom — oversized message payloads (context dumps, whole-file bodies, unbounded threads), retry storms re-sending the same envelope, or a wake loop. The hoplog records counts, not bodies, so the session must trace what this pair exchanges: bus send call sites for '${from}' and '${to}', message sizes in the transports, and whether the volume is one logical exchange repeated. If the concentration is warranted coordination between two busy seats — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function degradedPrompt(result: BusHopReadResult): string {
  return [
    'The agent bus hoplog failed its custody or stability checks, so every consumer reads nothing — the self-improvement work this backlog exists for.',
    '',
    `readBusHopsDetailed returned status 'unreadable' for fleet/bus/hops.jsonl: a symlink, nonregular file, permissive or foreign-owned storage, an unstable read, or a realpath escape. ${coverageText(result)}`,
    '',
    EVIDENCE,
    '',
    `Until the log reads cleanly, bus status hop totals, fleet-bus hop summaries and this feed are all blind — bus coordination cost evidence is silently absent rather than measured zero. Find what broke custody (a writer creating the file or its bus/ directory with loose modes, a symlink swap, a same-owner directory rename the pinned-inode checks refuse) and restore the 0700 directory / 0600 singly-linked file contract appendBusHop enforces. If the file was deliberately removed and the bus is simply unused, report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(kind: string, identity: string): string {
  return `bus-hop-${kind}-${createHash('sha256').update(`${kind}:${identity}`).digest('hex').slice(0, 16)}`;
}

function toItem(cell: BusHopCell, result: BusHopReadResult, reportedHops: number, repo: string): CloudBacklogItem {
  if (cell.kind === 'unmeasured') {
    const sender = fieldText(cell.sender, 48);
    return {
      id: itemId('unmeasured', cell.sender),
      title: `Bus sender '${sender}' rarely reports token usage`.slice(0, MAX_TITLE_CHARS),
      prompt: unmeasuredPrompt(cell, result),
      area: 'agent-bus',
      priority: 3,
      ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
    };
  }
  const from = fieldText(cell.from, 48);
  const to = fieldText(cell.to, 48);
  return {
    id: itemId('concentrated', `${cell.from} ${cell.to}`),
    title: `Bus pair '${from}'→'${to}' dominates recorded hop tokens`.slice(0, MAX_TITLE_CHARS),
    prompt: concentratedPrompt(cell, result, reportedHops),
    area: 'agent-bus',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the agent bus hoplog's evidenced patterns. Total:
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function busHopBacklogItems(opts: BusHopItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    // The reader throws RangeError on out-of-contract limits; an
    // out-of-range option falls back to the default rather than
    // silently killing the feed.
    const maxBytes = typeof opts.maxBytes === 'number' && Number.isSafeInteger(opts.maxBytes)
      && opts.maxBytes >= 2 && opts.maxBytes <= BUS_HOPLOG_MAX_BYTES
      ? opts.maxBytes : BUS_HOPLOG_MAX_BYTES;
    const maxRows = typeof opts.maxRows === 'number' && Number.isSafeInteger(opts.maxRows)
      && opts.maxRows >= 1 && opts.maxRows <= BUS_HOP_READ_MAX_ROWS
      ? opts.maxRows : BUS_HOP_READ_MAX_ROWS;
    const result = readBusHopsDetailed({
      ...(opts.hoplogFile === undefined ? {} : { file: opts.hoplogFile }),
      maxBytes,
      maxRows,
    });
    if (result.status === 'missing') return [];
    if (result.status === 'unreadable') {
      return [{
        id: 'bus-hoplog-unreadable',
        title: 'Agent bus hoplog is unreadable',
        prompt: degradedPrompt(result),
        area: 'agent-bus',
        priority: 3,
        repo,
      }];
    }
    const reportedHops = result.hops.filter(hopReported).length;
    const cells = foldBusHopCells(result.hops);
    if (cells.length === 0) return [];
    const limit = Math.max(1, Math.min(opts.limit ?? BUS_HOP_MAX_ITEMS, BUS_HOP_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => toItem(cell, result, reportedHops, repo));
  } catch {
    return [];
  }
}
