/**
 * Drop-ingest rejection journal → self-improvement backlog items.
 *
 * The host ingest sweeps `<runsDir>/leader/drop/<lane>/RQ-PHX-<id>.md`
 * files against its own contract — the `#job repo=… lane=… tier=…`
 * header, the lane/tier/id vocabularies, the 8000-byte ceiling and the
 * denied-content tokens (the contract this repository mirrors in
 * src/core/fleet/drop-job-writer.ts: INGEST_JOB_ID, INGEST_JOB_FILE,
 * INGEST_JOB_HEADER, DENIED_TOKENS, DROP_JOB_MAX_FILE_BYTES and
 * validateDropJob's reason list). Accepted drops move to
 * `queue/prompts/` and append a row to `leader/drop/ingested.tsv`;
 * drops the ingest finishes with a recorded reason land in
 * `leader/drop/done/` as `RQ-PHX-<id>.md.<reason>` — the fleet's
 * drop-fate projection (src/core/fleet/drop-job-fate.ts
 * readDropJobFates) reports every one of them as a 'rejected' fate,
 * and `phm doctor supply` folds the last 24 hours by reason.
 *
 * A rejected ingest never becomes a job: no jobs.jsonl row, no launch,
 * no finish — invisible to every jobs-ledger feeder exactly like the
 * change-request deaths the sibling feed folds. Until now the done/
 * directory's only readers were point-in-time — the newest-50
 * drop-fate pane and the doctor's 24-hour tally — so a rejection
 * class that keeps claiming new drops (a producer minting
 * contract-violating jobs, a writer whose validation drifted from
 * the real ingest, or an ingest gate misfiring on a whole family)
 * never became work.
 *
 * dropRejectBacklogItems carries the directory's recorded rejections
 * into discoverBacklog: `phm improve discover` and the scheduler's
 * autoDiscover queue a recurring reason class exactly like the
 * precheck-skip, worktree-reap and sibling feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The done/ directory is listed once (names sorted for
 *    determinism, capped at DROP_REJECT_MAX_DONE_ENTRIES) and each
 *    candidate file's metadata is lstat'ed for its mtime — the
 *    filesystem-recorded moment the ingest finished it, treated as
 *    approximate. Nothing is written, no file body is opened, and no
 *    network is touched. A missing done/ directory yields no items.
 *  - Recorded rows only. A file counts only when its name satisfies
 *    the fleet's own done-name contract (parseDoneName: RQ-PHX-<id>
 *    with the writer's id shape and a non-empty reason suffix, no
 *    path separators) and its lstat shows a regular non-symlink file
 *    whose mtime lands inside the window. Unparseable names — plain
 *    .md archives, foreign files, anything else — are skipped, never
 *    guessed; a symlinked entry is evidence of tampering, not a
 *    rejection, and is skipped too.
 *  - Recurring means recorded across distinct drops. A reason cell
 *    emits only at DROP_REJECT_RECURRING distinct job ids inside the
 *    window, so one unlucky drop or one bad sweep never queues a
 *    session. Reasons are grouped on a digit-normalized shape — the
 *    precheck-skip feed's convention — because the ingest's labels
 *    can embed per-drop numbers (`too-large-8102` and
 *    `too-large-8221` share `too-large-#`); the raw recorded reasons
 *    are still quoted, scrubbed and capped.
 *  - The ingest is pinned ops machinery. orch-ingest.py on the host
 *    is Security-reviewed and re-pinned; agents never edit the live
 *    copy. What this repository owns is the mirror contract
 *    (drop-job-writer.ts), the validation every repo-side producer
 *    shares (writeDropJob), and every drop producer itself — gap
 *    proposals (GAP*), the recut loop (RECUT*), change requests
 *    (UIREQ*), job reissues (<stem>R<n>), red-pr fixes, spawn
 *    proposals, autofill and leader drops — so items emit only when
 *    the backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling fleet-evidence sources apply, and
 *    their prompts direct sessions to fix what this repository owns
 *    or report no-change naming pinned/owner-side causes.
 *  - Truncation is stated, never hidden. When the directory listing
 *    hit the entry cap, the cell's counts are a lower bound and the
 *    prompt says so (the fleet-controller feed's convention).
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    reason shape — never the counts, ids or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; a class that stops recurring simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example job ids must match the done-name
 *    id shape before they are quoted, reason strings are scrubbed,
 *    flattened and capped, and the brief carries the usual no-change
 *    escape.
 */
import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { parseDoneName } from '../fleet/drop-job-fate.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells are bounded by reason-shape diversity. */
export const DROP_REJECT_MAX_ITEMS = 8;
const DROP_REJECT_ITEM_HARD_MAX = 25;
/**
 * The recurring bar: a reason shape needs this many distinct job ids
 * inside the window — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const DROP_REJECT_RECURRING = 3;
/**
 * Evidence window: one week of rejections gives recurring producer
 * patterns room without letting stale evidence linger — the sibling
 * feeds' 7-day convention. The done/ directory has no recorded
 * retention contract, so anything older simply is not there.
 */
export const DROP_REJECT_WINDOW_HOURS = 168;
/**
 * Directory-listing cap, the same bound `phm doctor supply`'s
 * rejected fold applies to this directory. Names are sorted before
 * the cap so the subset — and therefore the emitted ids — is
 * deterministic across runs; a capped listing is stated as a lower
 * bound, never silently trusted.
 */
export const DROP_REJECT_MAX_DONE_ENTRIES = 5000;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Reason strings are filename-recorded text; flatten, scrub, strip control bytes and cap before use. */
const MAX_REASON_CHARS = 160;
/** Reason-shape characters quoted inside one prompt before the remainder is elided. */
const MAX_SHAPE_CHARS = 120;
/** Example job ids quoted per cell inside one prompt; each already matches the done-name id shape. */
const MAX_EXAMPLE_IDS = 3;
/** Distinct raw-reason tallies quoted inside one prompt. */
const MAX_PROMPT_REASONS = 4;
/** ±5-minute future skew, the sibling folds' tolerance for clock drift on filesystem timestamps. */
const SKEW_MS = 300_000;
/** The fleet's own repository label: rejection evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface DropRejectItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding leader/drop/done; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default DROP_REJECT_WINDOW_HOURS). */
  windowHours?: number;
  /** Most items one call emits (default DROP_REJECT_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

export interface DropRejectTally {
  /** Sanitized recorded text (a raw reason label). */
  text: string;
  count: number;
}

/** One validated done/ rejection: the bare job id, the recorded reason and when (epoch ms, file mtime). */
export interface DropRejectRow {
  id: string;
  reason: string;
  atMs: number;
}

/** One recurring rejection cell: a digit-normalized reason shape claimed by distinct drops. */
export interface DropRejectCell {
  /** The digit-normalized reason shape (`too-large-8102` → `too-large-#`). */
  shape: string;
  /** Distinct job ids the ingest finished with this reason shape inside the window. */
  count: number;
  /** Total recorded done/ files folded into the cell (one id can carry several reason files). */
  rows: number;
  /** Recorded raw reasons, scrubbed/flattened/capped, most frequent first. */
  reasons: DropRejectTally[];
  /** Up to MAX_EXAMPLE_IDS bare job ids (the done-name id shape, no RQ-PHX- prefix). */
  ids: string[];
  /** ISO bounds of the cell's recorded rejections; null when none carried a usable mtime. */
  firstSeen: string | null;
  lastSeen: string | null;
  /** True when the directory listing hit the entry cap: counts are a lower bound. */
  lowerBound: boolean;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Filename-recorded text is unbounded; scrub secrets, strip control bytes, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * The grouping shape for a recorded reason: the same digit-normalization
 * the precheck-skip feed applies — every run of digits collapses to
 * '#'. The ingest's labels can embed per-drop numbers
 * (`too-large-8102-bytes` vs `too-large-8221-bytes`); fixed reasons
 * pass through unchanged.
 */
function reasonShape(reason: string): string {
  return fieldText(reason, MAX_REASON_CHARS * 2).replace(/[0-9]+/g, '#');
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): DropRejectTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

interface CellAcc {
  shape: string;
  rows: number;
  ids: Set<string>;
  idOrder: string[];
  reasons: Map<string, number>;
  firstMs: number | null;
  lastMs: number | null;
}

/**
 * Pure: fold validated done/ rejections into per-reason-shape cells.
 * Rows are pre-validated by the directory reader (done-name contract,
 * regular non-symlink file, in-window mtime); rows whose timestamp
 * cannot be placed inside [nowMs - windowMs, nowMs + skew] never
 * reach a cell. A cell counts distinct job ids — one id refused
 * under several reasons still counts once toward the recurring bar,
 * while `rows` keeps the total file evidence honest.
 */
export function foldDropRejectCells(
  rows: readonly DropRejectRow[],
  nowMs: number,
  windowMs: number,
  lowerBound = false,
): DropRejectCell[] {
  const cells = new Map<string, CellAcc>();
  for (const row of rows) {
    if (!Number.isFinite(row.atMs) || row.atMs > nowMs + SKEW_MS || row.atMs < nowMs - windowMs) continue;
    const shape = reasonShape(row.reason);
    if (shape === '') continue;
    let cell = cells.get(shape);
    if (cell === undefined) {
      cell = { shape, rows: 0, ids: new Set(), idOrder: [], reasons: new Map(), firstMs: null, lastMs: null };
      cells.set(shape, cell);
    }
    cell.rows += 1;
    if (!cell.ids.has(row.id)) {
      cell.ids.add(row.id);
      cell.idOrder.push(row.id);
    }
    bump(cell.reasons, fieldText(row.reason, MAX_REASON_CHARS) || 'unrecorded reason');
    cell.firstMs = cell.firstMs === null ? row.atMs : Math.min(cell.firstMs, row.atMs);
    cell.lastMs = cell.lastMs === null ? row.atMs : Math.max(cell.lastMs, row.atMs);
  }
  return [...cells.values()]
    .map((cell) => ({
      shape: cell.shape,
      count: cell.ids.size,
      rows: cell.rows,
      reasons: tallyOf(cell.reasons, MAX_PROMPT_REASONS),
      ids: cell.idOrder.slice(0, MAX_EXAMPLE_IDS),
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
      lowerBound,
    }))
    .sort((a, b) => b.count - a.count || b.rows - a.rows || a.shape.localeCompare(b.shape));
}

const NO_CHANGE = 'If the window has rolled forward, the rejections were a one-off burst the producers recovered from, the ingest correctly refused malformed or hostile drops, or the cause is owner-only or pinned ops machinery (credentials, billing, host state, the Security-reviewed host ingest and the contrib/mac + ~/.ashlr-runs/bin files agents never edit live) — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the pinned boundary and the reproduction commands are named so the session can re-derive the fold. */
const EVIDENCE = 'The evidence is leader/drop/done/ under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): every RQ-PHX-<id>.md.<reason> file is one drop the ingest finished with a recorded reason — the fleet\'s drop-fate projection (readDropJobFates in src/core/fleet/drop-job-fate.ts) reports them as rejected fates, the newest-50 drop-fate pane shows the tail, and `phm doctor supply` folds the last 24 hours by reason. Sibling journals: leader/drop/ingest.log carries the sweep\'s accept/reject lines and leader/drop/ingested.tsv the accepts. A file\'s mtime is the filesystem-recorded finish time — approximate, never invented. The ingest contract this repository mirrors lives in src/core/fleet/drop-job-writer.ts (INGEST_JOB_ID, INGEST_JOB_FILE, INGEST_JOB_HEADER, DENIED_TOKENS, DROP_JOB_MAX_FILE_BYTES, validateDropJob); the ingest itself is orch-ingest.py on the host — pinned, Security-reviewed ops machinery.';

function tallyText(tallies: readonly DropRejectTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: DropRejectCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function idsText(cell: DropRejectCell): string {
  return cell.ids.length === 0 ? '' : ` Example job ids: ${cell.ids.map((id) => `RQ-PHX-${id}`).join(', ')}.`;
}

function boundText(cell: DropRejectCell): string {
  return cell.lowerBound ? ` The done/ listing was capped at ${DROP_REJECT_MAX_DONE_ENTRIES} names, so these counts are a lower bound.` : '';
}

function dropRejectPrompt(cell: DropRejectCell): string {
  const shape = fieldText(cell.shape, MAX_SHAPE_CHARS);
  return [
    `Phantom's drop ingest keeps finishing jobs with recorded rejections — ${cell.count} distinct job id(s) landed in leader/drop/done/ under reason-shape '${shape}' (${cell.rows} recorded file(s)) inside the window. A rejected ingest never becomes a queue job: no jobs.jsonl row, no launch, no finish — the self-improvement work this backlog exists for.`,
    '',
    `Each done/ file is one drop the ingest moved aside with a reason suffix — RQ-PHX-<id>.md.<reason>. Recorded reasons: ${tallyText(cell.reasons)}.${idsText(cell)}${seenText(cell)}${boundText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The ingest itself is pinned ops machinery — orch-ingest.py on the host is Security-reviewed and re-pinned, and agents never edit the live copy or anything under contrib/mac and ~/.ashlr-runs/bin. What this repository owns is the mirror contract in src/core/fleet/drop-job-writer.ts, the writeDropJob validation every repo-side producer shares, and the producers themselves: gap proposals mint GAP* ids, the recut loop RECUT*, change requests UIREQ*, job reissues <stem>R<n>, plus red-pr fixes, spawn proposals, autofill and leader drops. A rejection class usually means one of three repo-side causes: the mirror constants drifted from the real ingest so writer-accepted jobs die at the gate; a producer bypasses writeDropJob or mints ids the contract forbids; or a shared validation gap lets a whole family of malformed drops through to be refused. The example ids name the families — grep each producer's id grammar to attribute them, then check the drops against the mirrored contract (header line, lane/tier vocab, the 8000-byte ceiling, denied tokens, id shape).`,
    '',
    `Find which side owns the cause: reproduce the contract check on the named ids' prompt sources where they still exist, compare the mirror constants against what the ingest actually enforced (ingest.log's reject lines carry its own reason labels), and fix what lives here — the mirror, the producer, or the shared validation. If the ingest's own gate is refusing valid work, that is ops-pinned: report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function dropRejectItem(cell: DropRejectCell, repo: string): CloudBacklogItem {
  const id = `fleet-drop-reject-${createHash('sha256').update(`drop-reject:${cell.shape}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Drop ingest keeps rejecting jobs: ${cell.shape}`.slice(0, MAX_TITLE_CHARS),
    prompt: dropRejectPrompt(cell),
    area: 'drop-rejects',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Read the done/ directory into validated rejection rows. Total over
 * absence: a missing or non-directory done/ yields null, a listing
 * failure throws to the caller's catch — either way discovery sees
 * no items rather than an exception. Names are sorted before the cap
 * so the folded subset is deterministic; `truncated` marks a capped
 * listing so cells state their counts as lower bounds.
 */
async function readDropRejects(runsDir: string): Promise<{ rows: DropRejectRow[]; truncated: boolean } | null> {
  const dir = join(runsDir, 'leader', 'drop', 'done');
  const dirStat = await lstat(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;
  const names = (await readdir(dir)).sort();
  const truncated = names.length > DROP_REJECT_MAX_DONE_ENTRIES;
  const rows: DropRejectRow[] = [];
  for (const name of names.slice(0, DROP_REJECT_MAX_DONE_ENTRIES)) {
    const parsed = parseDoneName(name);
    if (parsed === null) continue;
    let stat;
    try {
      stat = await lstat(join(dir, name));
    } catch {
      continue; // swept or renamed between the listing and now — not evidence
    }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    rows.push({ id: parsed.id, reason: parsed.reason, atMs: stat.mtimeMs });
  }
  return { rows, truncated };
}

/**
 * Backlog items for the drop-ingest done/ journal's recurring
 * reason-shape cells. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function dropRejectBacklogItems(opts: DropRejectItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the fleet's runs readers apply: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = (opts.windowHours ?? DROP_REJECT_WINDOW_HOURS) * 3_600_000;
    const read = await readDropRejects(runsDir);
    if (read === null) return [];
    const cells = foldDropRejectCells(read.rows, nowMs, windowMs, read.truncated)
      .filter((cell) => cell.count >= DROP_REJECT_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? DROP_REJECT_MAX_ITEMS, DROP_REJECT_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => dropRejectItem(cell, repo));
  } catch {
    return [];
  }
}
