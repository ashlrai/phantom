/**
 * <runs>/cos/reconcile.jsonl chief-of-staff delivery reconciliations →
 * self-improvement backlog items.
 *
 * Every `phm fleet cos reconcile <id> delivered|retry` — Mason's manual
 * resolution of a chief-of-staff reply whose send ended in a non-clean
 * state — appends one row to this append-only file under the runs dir's
 * `cos/` folder (reconcileCosDelivery in src/core/cos/reconcile.ts):
 *
 *   { at: <ISO-8601>, id: <delivery id>, from: 'uncertain' | 'sending',
 *     verdict: 'delivered' | 'retry' }
 *
 * A row exists only because a send could not record its own outcome:
 * 'uncertain' means the reply's send path ended without a durable receipt
 * (a timeout or crash mid-send left the claim open), and 'sending' means
 * the delivery marker sat stale past the reconcile window. The verdict
 * records what Mason found — 'delivered' the reply had in fact landed,
 * 'retry' it had not and the claim was freed for one more approved send.
 *
 * Until now the ledger's only readers were the reconcile verb itself and
 * `phm fleet cos status`'s point-in-time delivery lookup, so a send path
 * that keeps producing deliveries needing manual reconciliation never
 * became work. cosReconcileBacklogItems carries the ledger into
 * discoverBacklog:
 *
 *  - retry cells per `from` state: the send path keeps landing replies in
 *    'uncertain' (send outcome never recorded) or stale 'sending' and
 *    Mason keeps having to free the claim by hand. 'delivered' verdicts
 *    count as context only — the reply landed, so nothing was lost — and
 *    never form a cell.
 *  - The read is the writer's own bounded tail: readLedgerTail keeps the
 *    newest COS_RECONCILE_TAIL_BYTES of the file with the same symlink and
 *    file-type refusals every other ledger read applies; a cut first line
 *    is dropped, never guessed.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read once; nothing is written and no lock,
 *    process or network is touched. A missing or unreadable file yields
 *    no items; a malformed line is skipped, never guessed.
 *  - Rows count only under the writer's contract: a parseable ISO `at`, a
 *    non-empty bounded `id`, the closed `from` and `verdict` vocabularies.
 *    Anything else is not a ledger row.
 *  - Recurring means recorded across days AND across deliveries: a cell
 *    emits at COS_RECONCILE_MIN_RETRIES adverse rows across
 *    COS_RECONCILE_MIN_DAYS distinct UTC days inside the window AND
 *    COS_RECONCILE_MIN_IDS distinct delivery ids — the same recurrence
 *    bar the sibling fleet-evidence folds apply.
 *  - The ledger carries no repository column — it describes this
 *    install's chief-of-staff send machinery — so like the custody,
 *    self-tick, local-gate and delivery-receipts feeds, items emit only
 *    when the backlog's repo name is the fleet's own; another repository
 *    inherits nothing.
 *  - Delivery ids are counted and quoted bounded — never emitted raw
 *    beyond the fixed from-state vocabulary.
 *  - Dedup is downstream. The item id hashes the cell identity (from
 *    state + repository — never the counts), so a refresh re-derives the
 *    same ids and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, and the brief names the writer, its callers and
 *    the usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { cosDir } from '../cos/intake.js';
import { readLedgerTail } from '../router/outcomes.js';

/** Items one call may emit; the cell space is the two `from` states. */
export const COS_RECONCILE_BACKLOG_MAX_ITEMS = 4;
const COS_RECONCILE_ITEM_HARD_MAX = 25;
/** Evidence window: seven days, the sibling fleet-evidence convention. */
export const COS_RECONCILE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Future-skew allowance on record timestamps, the sibling folds' clock-drift tolerance. */
const COS_RECONCILE_FUTURE_SKEW_MS = 60_000;
/** Adverse rows a cell needs inside the window before its recurrence counts. */
export const COS_RECONCILE_MIN_RETRIES = 3;
/** Distinct UTC days those rows must span — recurring means recorded across days. */
export const COS_RECONCILE_MIN_DAYS = 2;
/** Distinct delivery ids those rows must span — one retried send is one delivery. */
export const COS_RECONCILE_MIN_IDS = 2;
/** The fleet's own repository label: the ledger describes this install's comms, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The ledger filename inside the runs dir's cos/ folder — the writer's appendFile target. */
const LEDGER_FILE = 'reconcile.jsonl';
/**
 * Bounded tail read, the same 256 KiB window the sibling delivery and
 * custody folds apply — reconcile rows are small and the journal is
 * append-only, so the newest bytes carry the window.
 */
export const COS_RECONCILE_TAIL_BYTES = 256 * 1024;

/** The writer's closed vocabularies, duplicated for the same closure reason the sibling folds duplicate theirs. */
const FROM_STATES = new Set(['uncertain', 'sending']);
const VERDICTS = new Set(['delivered', 'retry']);
type ReconcileFrom = 'uncertain' | 'sending';
type ReconcileVerdict = 'delivered' | 'retry';

export interface CosReconcileItemsOptions {
  /** Backlog target in owner/name form; the ledger describes the fleet install only. */
  repo: string;
  /** Ledger override (default: join(cosDir(runsDir), 'reconcile.jsonl')). */
  journalPath?: string;
  /** Runs dir for the ledger default; $ASHLR_RUNS_DIR wins when set, matching resolveCosRunsDir. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default COS_RECONCILE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One validated ledger row. */
export interface CosReconcileRow {
  /** The delivery's id — counted, never emitted. */
  id: string;
  from: ReconcileFrom;
  verdict: ReconcileVerdict;
  /** Window position. */
  atMs: number;
  utcDay: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: validate one parsed ledger line against the writer's record
 * contract — reconcileCosDelivery emits {at, id, from, verdict}: a
 * parseable ISO `at`, a non-empty bounded `id`, and the closed `from` and
 * `verdict` vocabularies. Anything else is not a ledger row; extra fields
 * are ignored for forward compatibility.
 */
export function parseCosReconcileJournalEntry(value: unknown): CosReconcileRow | null {
  if (!isRecord(value)) return null;
  const id = value['id'];
  if (typeof id !== 'string' || id === '' || id.length > 200) return null;
  const from = value['from'];
  if (typeof from !== 'string' || !FROM_STATES.has(from)) return null;
  const verdict = value['verdict'];
  if (typeof verdict !== 'string' || !VERDICTS.has(verdict)) return null;
  const at = value['at'];
  // The writer stamps new Date().toISOString(); require the ISO shape so a
  // hand-edited or foreign date string cannot claim a window position.
  const parsed = typeof at === 'string' && at.includes('T') ? Date.parse(at) : NaN;
  if (!Number.isFinite(parsed)) return null;
  return {
    id,
    from: from as ReconcileFrom,
    verdict: verdict as ReconcileVerdict,
    atMs: parsed,
    utcDay: utcDayOf(parsed),
  };
}

/**
 * Pure: parse one ledger file's text into validated rows plus the count
 * of lines that were not on-contract records — malformed JSON and
 * off-contract rows are counted, never guessed.
 */
export function parseCosReconcileJournal(text: string): { rows: CosReconcileRow[]; invalidRows: number } {
  const rows: CosReconcileRow[] = [];
  let invalidRows = 0;
  for (const line of text.split('\n')) {
    if (line === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidRows += 1;
      continue;
    }
    const row = parseCosReconcileJournalEntry(value);
    if (row === null) { invalidRows += 1; continue; }
    rows.push(row);
  }
  return { rows, invalidRows };
}

// ---------------------------------------------------------------------------
// Fold — one pass over the ledger tail
// ---------------------------------------------------------------------------

export interface CosReconcileFold {
  /** In-window on-contract rows — the share/context denominator. */
  rows: number;
  /** In-window 'delivered' verdicts — reconciles that confirmed a landed reply, context only. */
  deliveredRows: number;
  /** In-window 'retry' verdicts by `from` state. */
  cells: Map<ReconcileFrom, { from: ReconcileFrom; rows: number; days: Set<string>; ids: Set<string>; firstMs: number; lastMs: number }>;
  /** On-contract rows outside the window. */
  outsideWindow: number;
  /** Non-blank lines the writer's contract rejected. */
  invalidRows: number;
}

/**
 * Pure: fold ledger text into the reconcile evidence. Only dated rows
 * inside the window join cells; 'delivered' verdicts count as context and
 * never form a cell. Cell keys are the `from` state.
 */
export function foldCosReconcileRows(
  text: string,
  opts: { nowMs: number; windowMs?: number },
): CosReconcileFold {
  const parsed = parseCosReconcileJournal(text);
  const fold: CosReconcileFold = {
    rows: 0, deliveredRows: 0, cells: new Map(), outsideWindow: 0,
    invalidRows: parsed.invalidRows,
  };
  const windowMs = opts.windowMs ?? COS_RECONCILE_WINDOW_MS;
  const windowStart = opts.nowMs - windowMs;
  const until = opts.nowMs + COS_RECONCILE_FUTURE_SKEW_MS;

  for (const row of parsed.rows) {
    if (row.atMs < windowStart || row.atMs > until) { fold.outsideWindow += 1; continue; }
    fold.rows += 1;
    if (row.verdict === 'delivered') { fold.deliveredRows += 1; continue; }
    let cell = fold.cells.get(row.from);
    if (cell === undefined) {
      cell = { from: row.from, rows: 0, days: new Set(), ids: new Set(), firstMs: row.atMs, lastMs: row.atMs };
      fold.cells.set(row.from, cell);
    }
    cell.rows += 1;
    cell.days.add(row.utcDay);
    cell.ids.add(row.id);
    cell.firstMs = Math.min(cell.firstMs, row.atMs);
    cell.lastMs = Math.max(cell.lastMs, row.atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface CosReconcileCell {
  from: ReconcileFrom;
  /** In-window 'retry' rows. */
  rows: number;
  /** Sorted distinct UTC days. */
  days: string[];
  /** Distinct delivery ids the retries span. */
  ids: number;
  /** In-window on-contract rows overall — the context denominator. */
  records: number;
  /** In-window 'delivered' reconciles — context only, never the cause. */
  deliveredContext: number;
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the bounded tail cut older bytes: counts are a lower bound. */
  lowerBound: boolean;
}

const isoOrNull = (ms: number): string | null => new Date(ms).toISOString();

/**
 * Pure: recurring cells — a `from` cell emits at the row, day and
 * distinct-id bars. Sorted by rows desc, then from state for a stable
 * order.
 */
export function cosReconcileCells(fold: CosReconcileFold, lowerBound = false): CosReconcileCell[] {
  const cells: CosReconcileCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < COS_RECONCILE_MIN_RETRIES) continue;
    if (cell.days.size < COS_RECONCILE_MIN_DAYS) continue;
    if (cell.ids.size < COS_RECONCILE_MIN_IDS) continue;
    cells.push({
      from: cell.from,
      rows: cell.rows,
      days: [...cell.days].sort(),
      ids: cell.ids.size,
      records: fold.rows,
      deliveredContext: fold.deliveredRows,
      firstSeen: isoOrNull(cell.firstMs),
      lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.rows - a.rows || a.from.localeCompare(b.from));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is <runs dir>/cos/reconcile.jsonl — resolveCosRunsDir in src/core/cos/intake.ts resolves $ASHLR_RUNS_DIR then ~/.ashlr-runs. reconcileCosDelivery in src/core/cos/reconcile.ts appends one {at, id, from, verdict} row per manual resolution of a chief-of-staff reply whose send ended in a non-clean state — `from` \'uncertain\' when the send path never recorded an outcome (a timeout or crash mid-send left the claim open) and \'sending\' when the delivery marker sat stale past the reconcile window, \'verdict\' \'delivered\' when the reply had in fact landed and \'retry\' when it had not and the claim was freed for one more approved send. Its only readers until this feed were the reconcile verb itself and `phm fleet cos status`\'s point-in-time delivery lookup — neither folds a recurrence.';

const REPRO = 'Reproduce the fold by reading <runs dir>/cos/reconcile.jsonl directly, keeping on-contract rows ({at, id, from, verdict} with a parseable ISO `at`, a bounded id and the closed from/verdict vocabularies) whose `at` lands inside the window, grouping \'retry\' verdicts by `from` state across distinct UTC days and distinct delivery ids, and treating \'delivered\' verdicts as context, never signal. The writer and its delivery-state machine are src/core/cos/reconcile.ts and src/core/cos/intake.ts.';

const NO_CHANGE = 'If the window has rolled forward, the reconciles were a transient send-path incident the later rows recovered from, the deliveries now record clean outcomes on the default branch, or this checkout is not the fleet install the ledger describes — report no-change and name the evidence.';

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, 4).join(', ');
  return days.length > 4 ? `${shown} (+${days.length - 4} more)` : shown;
};

const seenText = (cell: CosReconcileCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

const boundText = (cell: CosReconcileCell): string =>
  cell.lowerBound ? ' A bounded tail cut older bytes, so these counts cover only the retained window — a lower bound, not the full window.' : '';

const WINDOW_DAYS = Math.round(COS_RECONCILE_WINDOW_MS / 86_400_000);

const FROM_TITLE: Record<ReconcileFrom, string> = {
  uncertain: 'chief-of-staff sends keep ending uncertain and needing manual reconcile',
  sending: 'chief-of-staff sends keep sticking in sending and needing manual reconcile',
};

const FROM_FIND: Record<ReconcileFrom, string> = {
  uncertain:
    `Find why chief-of-staff reply sends keep ending 'uncertain' and needing Mason's manual reconcile: an 'uncertain' delivery means the send path never recorded a durable outcome — the reply may or may not have reached the owner, so the claim stayed open until reconcileCosDelivery resolved it. Trace the send path that writes the delivery marker (src/core/cos/intake.ts's cosDeliveryPath and the reply send it guards) for the timeout, crash or missing-receipt case that leaves 'uncertain' instead of 'sent' or 'failed', and check whether a retry-safe outcome write exists. The send machinery is this repository's own; Mason's channels and approvals are owner-only — name them rather than working around them.`,
  sending:
    `Find why chief-of-staff reply sends keep sticking in 'sending' past the stale window and needing Mason's manual reconcile: a 'sending' delivery that never reaches 'sent' means the send path crashed or hung after claiming the delivery but before recording its outcome, so reconcileCosDelivery only fires once the marker is stale. Trace the send path that writes and clears the delivery marker (src/core/cos/intake.ts's cosDeliveryPath and the reply send it guards) for the crash, hang or missing-finalize case, and check whether the stale-'sending' sweep and the outcome write are ordered so a completed send can never be left 'sending'. The send machinery is this repository's own; Mason's channels and approvals are owner-only — name them rather than working around them.`,
};

function cosReconcileItem(cell: CosReconcileCell, repo: string): CloudBacklogItem {
  const from = cell.from;
  const id = `cos-reconcile-${from}-${createHash('sha256').update(`cos-reconcile:${repo.trim().toLowerCase()}:${from}`).digest('hex').slice(0, 16)}`;
  const prompt = [
    `Phantom's chief-of-staff delivery ledger keeps recording manual reconciles — ${cell.rows} 'retry' verdict(s) on '${from}' deliveries across ${cell.ids} distinct delivery(ies) and ${cell.days.length} UTC day(s) (${daysText(cell.days)}) inside the ${WINDOW_DAYS}-day window, the self-improvement work this backlog exists for.`,
    '',
    `Each 'retry' row is one chief-of-staff reply Mason had to reconcile by hand because its send ended '${from}' and never recorded a clean outcome — the claim stayed open until he freed it for one more approved send, so the owner-facing reply path is not reliably finishing its own bookkeeping.${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    FROM_FIND[from],
    '',
    `If the window has rolled forward, the reconciles were a transient send-path incident the later rows recovered from, the deliveries now record clean outcomes on the default branch, or this checkout is not the fleet install the ledger describes — report no-change and name the evidence. ${NO_CHANGE}`,
    '',
    REPRO,
  ].join('\n');
  return {
    id,
    title: `CoS: ${FROM_TITLE[from]}`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: `cos-reconcile-${from}`,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the chief-of-staff reconcile ledger's recurring retry
 * verdicts, worst cell first. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function cosReconcileBacklogItems(opts: CosReconcileItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || (repo.split('/').pop() ?? repo).trim().toLowerCase() !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const journalPath = opts.journalPath ?? join(cosDir(runsDir), LEDGER_FILE);
    const read = await readLedgerTail(journalPath, COS_RECONCILE_TAIL_BYTES);
    // Healthy-only evidence bar: a missing, unreadable or non-file ledger
    // is unknown, never a guessed tally — the same rule the sibling
    // sources apply to their own degraded corpora.
    if (read.state !== 'read' || read.text.trim() === '') return [];
    const fold = foldCosReconcileRows(read.text, { nowMs: (opts.now ?? new Date()).getTime() });
    if (fold.invalidRows > 0 && fold.rows === 0) return [];
    const lowerBound = read.truncated;
    const limit = Math.max(1, Math.min(opts.limit ?? COS_RECONCILE_BACKLOG_MAX_ITEMS, COS_RECONCILE_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const cell of cosReconcileCells(fold, lowerBound)) {
      if (items.length >= limit) break;
      items.push(cosReconcileItem(cell, repo));
    }
    return items;
  } catch {
    return [];
  }
}
