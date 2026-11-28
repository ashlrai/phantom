/**
 * Bot-seat handoff journal recurring churn → self-improvement backlog items.
 *
 * Phantom's external bot seats (devin-bot, grok-bot, openai-bot, local,
 * other — src/core/bots/seats.ts) hold fleet work through coordination
 * claims and node jobs. When a seat drains or goes idle with work still
 * open, `phm bots handoffs --apply` (applySeatHandoffs →
 * applySeatHandoff) journals each released work item before releasing
 * it, one `phantom-bot-handoff.v1` row per record appended to
 * ~/.phantom/bots/handoffs.jsonl:
 *
 *   {schema, handoffId, seatId, work:{kind:'node-job'|'bus-claim', ref},
 *    done:'unknown', left:'unknown', branch, pr, createdAt}
 *
 *   - handoffId  sha256 of [seatId, kind, ref, identity] — deterministic,
 *                so a re-apply dedupes and an exact replay collapses; a
 *                re-claimed item earns a NEW id because its lease or
 *                session identity changed.
 *   - seatId     the roster seat id (BOT_ID_PATTERN vocabulary).
 *   - work.ref   the coordination claim key ('queue:<id>', 'pr:<n>', …)
 *                for bus-claim records or the node job id for node-job
 *                records.
 *   - done/left  schema placeholders the writer always emits as
 *                'unknown' — they are never updated and are NOT outcome
 *                evidence; this fold never reads them.
 *   - branch/pr  the claim's recorded context at handoff time.
 *   - createdAt  the apply timestamp (ISO).
 *
 * Until now the journal's only readers were the plan side —
 * planSeatHandoffs/planSeatHandoff (the `phm bots handoffs` dry run,
 * the unified inbox seats source, `phm agents bus work mine`'s seats
 * section, fleet_seat_handoffs) — point-in-time "what would move"
 * answers, plus applySeatHandoff itself re-reading history for
 * idempotent receipts. The completed-handoff history had no trend
 * reader at all: a seat that kept exhausting quota and scattering its
 * claims fleet-wide, or one work item that kept bouncing between seats
 * that could not hold it, was invisible to the improvement loop even
 * though every handoff is recorded fleet evidence about seat fitness
 * and claim routing. botHandoffBacklogItems carries the same journal
 * into discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readLedgerTail's bounded
 *    no-follow tail at the seat store's own 4 MiB read bound
 *    (SEAT_FILE_MAX_BYTES in seats.ts — past it every seat read
 *    refuses); nothing is written and no network is touched. A
 *    missing file is the clean never-applied state; unreadable or
 *    non-file evidence yields no items, and a truncated tail folds
 *    the retained rows flagged as a lower bound in the prompts.
 *  - Rows count only under the writer's contract: schema
 *    'phantom-bot-handoff.v1', a 64-hex handoffId, a seatId inside the
 *    bot-id pattern, work.kind 'node-job'|'bus-claim' with a bounded
 *    control-free ref, string done/left (never interpreted), nullable
 *    bounded branch/pr, and a parseable ISO createdAt inside the
 *    7-day window plus the sibling folds' one-minute future-skew
 *    tolerance. Malformed lines are counted, never guessed; exact
 *    handoffId replays count once (first row wins — the writer never
 *    rewrites a record).
 *  - Pending handoffs are not evidence here: the journal records
 *    applied releases only, so a seat whose drains are never applied
 *    leaves no rows — that state belongs to the plan reads, not this
 *    fold.
 *  - Recurring means recorded across days for seat churn (the sibling
 *    feeds' RECURRING_FAILURES convention) and repeated for work
 *    re-homing: one bounce can be a legitimate quota hand-off, three
 *    recorded releases of the same work item inside the window is a
 *    pattern.
 *  - The journal describes this install's bot seats and carries no
 *    repository column, so like the sibling fleet-evidence feeds,
 *    items emit only when the backlog's repo name is the fleet's own;
 *    another repository inherits nothing.
 *  - Dedup is downstream. Item ids hash the cell kind + cell key +
 *    repo (never the tallies or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    seat that stops churning simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; seat and work cells are both naturally bounded. */
export const BOT_HANDOFF_MAX_ITEMS = 8;
const BOT_HANDOFF_ITEM_HARD_MAX = 25;
/**
 * Future-skew ceiling on journal `createdAt` stamps, the sibling feeds'
 * one-minute tolerance for same-host clock drift.
 */
export const BOT_HANDOFF_FUTURE_SKEW_MS = 60_000;
/** Analysis window: the sibling feeds' seven days. */
export const BOT_HANDOFF_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Bounded tail for the journal, the seat store's own read bound
 * (SEAT_FILE_MAX_BYTES): the file is append-only with no rotation, so
 * this bound sees everything the seat store itself would serve.
 */
export const BOT_HANDOFF_TAIL_BYTES = 4 * 1024 * 1024;
/** Contract-failing lines one corrupt-lines cell needs inside the tail. */
export const BOT_HANDOFF_CORRUPT_MIN = 3;
/** Handoff rows one seat needs across the window to count as churn. */
export const BOT_HANDOFF_SEAT_MIN_ROWS = 3;
/** Distinct UTC days that seat churn must span. */
export const BOT_HANDOFF_SEAT_MIN_DAYS = 2;
/** Recorded handoffs one work ref needs inside the window to count as re-homed. */
export const BOT_HANDOFF_REF_MIN_ROWS = 3;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: seat evidence is this install's bots. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

export interface BotHandoffItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Journal override (default: <home>/.phantom/bots/handoffs.jsonl). */
  journalPath?: string;
  /** Home for the default journal dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default BOT_HANDOFF_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated handoff row inside the analysis window. */
export interface BotHandoffFoldRow {
  handoffId: string;
  seatId: string;
  workKind: 'node-job' | 'bus-claim';
  workRef: string;
  tsMs: number;
  utcDay: string;
}

/** The journal parse result: deduped in-window rows plus the contract-failure count. */
export interface BotHandoffParse {
  rows: BotHandoffFoldRow[];
  /** Non-blank lines that failed the writer's row contract. */
  corrupt: number;
}

const HANDOFF_ID_RE = /^[a-f0-9]{64}$/;
// BOT_ID_PATTERN from src/core/agents/bot-templates.ts, inlined so this
// leaf pulls in no agent modules (same rule the outside-pr ledger applies).
const SEAT_ID_RE = /^[a-z][a-z0-9-]{1,23}$/;
const WORK_KINDS: ReadonlySet<string> = new Set(['node-job', 'bus-claim']);
const MAX_REF_CHARS = 1024;
const MAX_CONTEXT_CHARS = 512;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

// Control characters can never appear in a claim key, job id or seat
// context the writer journals; a field carrying one is a foreign or
// torn line, not evidence.
const boundedText = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ? v : null;

const nullableContext = (v: unknown): boolean =>
  v === null || v === undefined || boundedText(v, MAX_CONTEXT_CHARS) !== null;

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse journal text into deduped in-window rows plus a
 * contract-failure count. Every non-blank line must satisfy the writer's
 * row contract; lines outside the window parse fine but fold nowhere —
 * neither evidence nor corruption. handoffId replays keep the first row:
 * the ids are deterministic content hashes, so a repeated id is the same
 * record seen twice, never a second handoff.
 */
export function parseBotHandoffJournal(text: string, nowMs: number): BotHandoffParse {
  const rows: BotHandoffFoldRow[] = [];
  const seen = new Set<string>();
  let corrupt = 0;
  const windowStart = nowMs - BOT_HANDOFF_WINDOW_MS;
  const until = nowMs + BOT_HANDOFF_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      corrupt += 1;
      continue;
    }
    if (!isRecord(raw) || raw['schema'] !== 'phantom-bot-handoff.v1') {
      corrupt += 1;
      continue;
    }
    const handoffId = raw['handoffId'];
    const seatId = raw['seatId'];
    const work = raw['work'];
    const createdAt = raw['createdAt'];
    if (typeof handoffId !== 'string' || !HANDOFF_ID_RE.test(handoffId)) { corrupt += 1; continue; }
    if (typeof seatId !== 'string' || !SEAT_ID_RE.test(seatId)) { corrupt += 1; continue; }
    if (!isRecord(work) || typeof work['kind'] !== 'string' || !WORK_KINDS.has(work['kind'])) { corrupt += 1; continue; }
    const workRef = boundedText(work['ref'], MAX_REF_CHARS);
    if (workRef === null) { corrupt += 1; continue; }
    // done/left are writer placeholders ('unknown' today); they are
    // validated as strings only and never interpreted as outcomes.
    if (typeof raw['done'] !== 'string' || typeof raw['left'] !== 'string') { corrupt += 1; continue; }
    if (!nullableContext(raw['branch']) || !nullableContext(raw['pr'])) { corrupt += 1; continue; }
    const tsMs = typeof createdAt === 'string' ? Date.parse(createdAt) : NaN;
    if (!Number.isFinite(tsMs)) { corrupt += 1; continue; }
    if (tsMs < windowStart || tsMs > until) continue;
    if (seen.has(handoffId)) continue;
    seen.add(handoffId);
    rows.push({
      handoffId,
      seatId,
      workKind: work['kind'] as 'node-job' | 'bus-claim',
      workRef,
      tsMs,
      utcDay: utcDayOf(tsMs),
    });
  }
  return { rows, corrupt };
}

/** One seat's or one work ref's in-window handoff evidence. */
export interface BotHandoffCell {
  /** seatId for seat-churn cells, `${kind}:${ref}` for work-rehomed cells. */
  key: string;
  /** Display label: the seat id or the work kind+ref. */
  label: string;
  rows: number;
  /** Distinct UTC days the cell's rows landed on. */
  days: Set<string>;
  /** Distinct seat ids that handed this work off (work-rehomed cells). */
  seats: Set<string>;
  /** Newest row instant inside the window. */
  lastMs: number;
}

/** The fold's output. */
export interface BotHandoffFold {
  /** Per-seat churn cells by seatId. */
  seats: Map<string, BotHandoffCell>;
  /** Per-work-ref re-homing cells by `${kind}:${ref}`. */
  workRefs: Map<string, BotHandoffCell>;
  /** Contract-failing lines inside the retained tail. */
  corrupt: number;
}

/**
 * Pure: fold parsed rows into per-seat and per-work-ref cells. A work
 * ref key is `kind:ref` — a bus-claim 'queue:x' and a node-job 'x' are
 * different records even when the text collides.
 */
export function foldBotHandoffRows(rows: readonly BotHandoffFoldRow[], corrupt: number): BotHandoffFold {
  const seats = new Map<string, BotHandoffCell>();
  const workRefs = new Map<string, BotHandoffCell>();
  const cell = (map: Map<string, BotHandoffCell>, key: string, label: string): BotHandoffCell => {
    let c = map.get(key);
    if (c === undefined) {
      c = { key, label, rows: 0, days: new Set(), seats: new Set(), lastMs: 0 };
      map.set(key, c);
    }
    return c;
  };
  for (const row of rows) {
    const seat = cell(seats, row.seatId, row.seatId);
    seat.rows += 1;
    seat.days.add(row.utcDay);
    seat.seats.add(row.seatId);
    if (row.tsMs > seat.lastMs) seat.lastMs = row.tsMs;

    const refKey = `${row.workKind}:${row.workRef}`;
    const refCell = cell(workRefs, refKey, `${row.workKind} ${row.workRef}`);
    refCell.rows += 1;
    refCell.days.add(row.utcDay);
    refCell.seats.add(row.seatId);
    if (row.tsMs > refCell.lastMs) refCell.lastMs = row.tsMs;
  }
  return { seats, workRefs, corrupt };
}

const NO_CHANGE = 'If the window has rolled forward, the seat or work item legitimately resolved (the ref merged, the seat re-activated on fresh quota, the claim completed), `phm bots handoffs` shows nothing pending, the roster or quota evidence verifies healthy on a fresh read, or the right fix is owner-only (provider credentials, billing, a protected gate) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is handoffs.jsonl under the bot-seat directory of the user home (~/.phantom/bots/handoffs.jsonl — root() in src/core/bots/seats.ts resolves ~/.phantom/bots from os.homedir(); neither ASHLR_HOME nor ASHLR_RUNS_DIR relocates it): applySeatHandoff/applySeatHandoffs append one phantom-bot-handoff.v1 row per released work item — journal-before-release under the handoff.lock store lock, deterministic handoffId dedup, per-channel notice receipts kept separately in handoff-notices.json — when `phm bots handoffs --apply` drains a draining or idle-with-work seat. Until this feed the journal\'s only readers were the plan side — planSeatHandoffs/planSeatHandoff behind `phm bots handoffs`, the unified inbox seats source, `phm agents bus work mine`\'s seats section and the fleet_seat_handoffs MCP tool — point-in-time "what would move" reads, never a trend of what actually moved.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The journal tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

function seatChurnPrompt(cell: BotHandoffCell, truncated: boolean): string {
  return [
    `Phantom's bot seat '${cell.label}' keeps handing work off — ${cell.rows} recorded releases across ${cell.days.size} distinct UTC day(s) inside the window.`,
    '',
    `Every row is one applied seat handoff: the seat was draining or idle-with-work and applySeatHandoff journaled the release of a coordination claim or node job before letting the fleet reclaim it. Last recorded handoff ${new Date(cell.lastMs).toISOString()}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `A seat only hands off when its quota evidence says exhausted (draining) or it sits idle still holding claims — recurring handoffs mean the seat keeps hitting that state while work keeps routing to it. Check the seat's live quota evidence and lifecycle state ('phm bots seats --json', the seat-shadow evidence feed's route.quality receipts), whether its provider window keeps exhausting faster than it resets, whether its lane fit or capability profile attracts work it cannot finish, and whether the fleet's claim routing keeps re-assigning the same kinds of work back to it. If the churn verifies as legitimate quota cycling on a seat that is deliberately being drained — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function workRehomedPrompt(cell: BotHandoffCell, truncated: boolean): string {
  const seatList = [...cell.seats].sort().join(', ');
  return [
    `The same handed-off work keeps needing re-homing — ${cell.rows} recorded seat handoffs for ${cell.label} across ${cell.days.size} distinct UTC day(s) inside the window (${seatList || 'unattributed'}).`,
    '',
    `Each handoffId is a distinct applied release — the deterministic id covers the work ref plus the claim or job identity, so repeated rows mean the item was re-claimed and handed off again, not replayed. Last recorded handoff ${new Date(cell.lastMs).toISOString()}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `One handoff is a legitimate quota release; three recorded releases of the same work ref mean the item keeps landing on seats that cannot hold it — claim routing, seat capacity or the work's own size/scope may be mismatched to every seat that picks it up. Resolve the ref to its live claim or job ('phm agents bus work mine', the coordination claim store, or the node job by id for node-job refs), check which seats it cycled through and why each released it, and whether the fleet's non-seat lanes would hold it better. If the repeats verify as distinct legitimate releases of genuinely different claims that share a ref spelling — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function corruptPrompt(fold: BotHandoffFold, truncated: boolean): string {
  return [
    `Phantom's bot-seat handoff journal keeps failing its row contract — ${fold.corrupt} line(s) inside the retained tail are not phantom-bot-handoff.v1 rows applySeatHandoff would write.`,
    '',
    `The journal is append-only with no rotation and no other writer, so recurring contract failures mean torn appends (a crash mid-write leaves a partial final line the next append continues), a foreign process writing the path, or schema drift between the writer and this fold's contract check.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The contract is strict on purpose: schema literal, 64-hex handoffId, bot-pattern seatId, work.kind node-job|bus-claim with a bounded control-free ref, string done/left, nullable bounded branch/pr and a parseable createdAt. Check for partial final lines (a torn tail edge is expected once — counted failures are whole lines), confirm no second writer touches ~/.phantom/bots/handoffs.jsonl, and diff src/core/bots/seats.ts's record shape against the fold's contract if the writer recently changed. If the lines verify as expected edge noise — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

type CellKind = 'seat-churn' | 'work-rehomed' | 'corrupt-lines';

interface Candidate {
  kind: CellKind;
  /** Cell key for per-cell items, '' for journal-wide cells. */
  cell: string;
  /** Sort weight: row counts for per-cell kinds, the corrupt count for the journal cell. */
  weight: number;
  item: CloudBacklogItem;
}

function itemId(kind: CellKind, cell: string, repo: string): string {
  const hash = createHash('sha256')
    .update(`bot-handoff:${kind}:${cell}:${repo.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16);
  return `bot-handoff-${kind}-${hash}`;
}

function makeItem(kind: CellKind, cell: string, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(kind, cell, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'bot-handoff',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

const KIND_TITLE: Record<Exclude<CellKind, 'seat-churn' | 'work-rehomed'>, string> = {
  'corrupt-lines': 'Bot-seat handoff journal keeps failing its row contract',
};

/**
 * Backlog items for the bot-seat handoff journal's recurring seat
 * churn, repeated work re-homing and contract-failing lines. Total:
 * any read or fold failure yields no items rather than throwing into
 * discovery.
 */
export async function botHandoffBacklogItems(
  opts: BotHandoffItemsOptions,
): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const home = opts.homeDir ?? homedir();
    const journalPath = opts.journalPath
      ?? join(home, '.phantom', 'bots', 'handoffs.jsonl');
    const tail = await readLedgerTail(journalPath, BOT_HANDOFF_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const parsed = parseBotHandoffJournal(tail.text, nowMs);
    const fold = foldBotHandoffRows(parsed.rows, parsed.corrupt);

    const candidates: Candidate[] = [];
    for (const cell of fold.seats.values()) {
      if (cell.rows >= BOT_HANDOFF_SEAT_MIN_ROWS && cell.days.size >= BOT_HANDOFF_SEAT_MIN_DAYS) {
        candidates.push({
          kind: 'seat-churn',
          cell: cell.key,
          weight: cell.rows,
          item: makeItem(
            'seat-churn',
            cell.key,
            repo,
            `Bot seat '${cell.label}' keeps handing work off`,
            seatChurnPrompt(cell, tail.truncated),
          ),
        });
      }
    }
    for (const cell of fold.workRefs.values()) {
      if (cell.rows >= BOT_HANDOFF_REF_MIN_ROWS) {
        candidates.push({
          kind: 'work-rehomed',
          cell: cell.key,
          weight: cell.rows,
          item: makeItem(
            'work-rehomed',
            cell.key,
            repo,
            `Handed-off ${cell.label} keeps needing re-homing`,
            workRehomedPrompt(cell, tail.truncated),
          ),
        });
      }
    }
    if (fold.corrupt >= BOT_HANDOFF_CORRUPT_MIN) {
      candidates.push({
        kind: 'corrupt-lines',
        cell: '',
        weight: fold.corrupt,
        item: makeItem('corrupt-lines', '', repo, KIND_TITLE['corrupt-lines'], corruptPrompt(fold, tail.truncated)),
      });
    }
    // Strongest recorded evidence first.
    candidates.sort((a, b) =>
      b.weight - a.weight
      || a.cell.localeCompare(b.cell)
      || a.kind.localeCompare(b.kind));
    const limit = Math.max(1, Math.min(opts.limit ?? BOT_HANDOFF_MAX_ITEMS, BOT_HANDOFF_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((c) => c.item);
  } catch {
    return [];
  }
}
