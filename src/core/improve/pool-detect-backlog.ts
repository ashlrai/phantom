/**
 * Pool-detection receipts → self-improvement backlog items.
 *
 * dispatchd's per-tick wall radar — ratelimited() in contrib/mac/
 * dispatchd.py — scans every lane's fresh job logs (a .base whose log
 * mtime sits inside the last 30 minutes and after the lane's last slot
 * change) for provider-limit patterns and, on the first match per
 * (job, class), appends one receipt through the same metric() path
 * every other job row takes:
 *
 *   {"event":"pool","lane":<lane>,"job":<job>,"kind":<class>,
 *    "mem_free_pct":<int|null>,"swap_gb":<float|null>,"ts":<stamp>}
 *
 * The class vocabulary is the producer's closed CLS table —
 * credits_exhausted, usage_limit, model_capacity, rate_limit — and the
 * .<class>.seen marker under the runs dir caps each (job, class) pair at
 * one row ever, so distinct job ids are the recurrence measure. The
 * receipt is the detection itself, recorded before dispatchd reacts:
 * credits_exhausted holds the lane, model_capacity changes no slot,
 * rate_limit and usage_limit halve the lane's concurrency target.
 *
 * Until now the row's only reader was the router outcome fold
 * (src/core/router/outcomes.ts), which joins it as pool_kind /
 * pool_mem_free_pct / pool_swap_gb context on the job's outcome — and
 * the router-weight report tallies those joins only inside its
 * unknown-outcome cohort (jobs with no merge verdict), inside
 * `phm fleet router-weights`, a report someone had to run and read.
 * The friction fold sees the detector's *reactions* — SLOTS,
 * MODEL_CAPACITY_SEEN and LANE_HOLD lines in dispatch-events.log —
 * blended into one quota-exhaustion score that cannot say which wall
 * class keeps firing on which lane across which jobs. A lane whose
 * running jobs keep matching provider walls therefore looked like
 * ordinary provider churn: the detection was recorded and never
 * became work. poolDetectBacklogItems carries the same tail into
 * discoverBacklog.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing, unreadable or non-file ledger yields no
 *    items; a truncated tail is stated as a lower bound.
 *  - Rows count only under the writer's contract: the event name must
 *    resolve through the shared dialect to 'pool', the kind must sit
 *    inside the producer's closed CLS vocabulary, the lane inside the
 *    bounded lane-id shape and the job inside the ledger's own id
 *    shape — a row that cannot name its lane, job or wall class never
 *    counts. Malformed JSON lines are skipped, never guessed.
 *  - Recurring means recorded across distinct jobs and days: a cell
 *    emits only at POOL_DETECT_MIN_JOBS distinct job ids across
 *    POOL_DETECT_MIN_DAYS distinct UTC days inside the window, so one
 *    unlucky job's single detection and one bad day never queue a
 *    session.
 *  - Fleet machinery only: jobs.jsonl describes this install's
 *    dispatch machinery and carries no per-job repository column, so
 *    items emit only when the backlog target's repository name is
 *    'phantom' — the same last-segment rule the sibling fleet-evidence
 *    sources apply.
 *  - Dedup is downstream: the item id hashes the cell identity
 *    (lane, kind — never counts or timestamps), so a refresh
 *    re-derives the same id and a recovered cell simply stops
 *    re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { ledgerAtMs, ledgerEventName, ledgerJobId, ledgerLane } from '../fleet/empty-cause.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';

/** Items one call may emit; cells are bounded by lane x closed-vocabulary diversity. */
export const POOL_DETECT_MAX_ITEMS = 10;
const POOL_DETECT_ITEM_HARD_MAX = 25;
/** A cell emits only at this many distinct job ids inside the window... */
export const POOL_DETECT_MIN_JOBS = 3;
/** ...across at least this many distinct UTC days. */
export const POOL_DETECT_MIN_DAYS = 2;
/** Evidence window: the sibling fleet-evidence convention. */
export const POOL_DETECT_WINDOW_HOURS = 168;
/** Newest-bytes bound retained from the append-only jobs ledger — the same tail the sibling jobs-ledger feeds read. */
export const POOL_DETECT_LEDGER_LIMIT = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: pool-detect evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Lane identifiers the producer writes — the same bounded shape outcomes.ts applies to wall lanes. */
const LANE = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;
/** The job-id shape a row must carry to be attributable; a looser prompt-safe shape gates quoting. */
const LEDGER_JOB_ID = /^[A-Za-z0-9._-]{1,90}$/;
const SAFE_JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/**
 * The producer's closed detection vocabulary, mirrored from the pinned
 * CLS table (contrib/mac/dispatchd.py): the per-tick ratelimited() scan
 * matches a launched job's fresh error-line tail against these four
 * provider-limit classes and receipts the first match per (job, class).
 * A kind outside this set is not a receipt this feed recognizes.
 */
export const POOL_DETECT_KINDS: ReadonlySet<string> = new Set([
  'credits_exhausted', 'usage_limit', 'model_capacity', 'rate_limit',
]);
/** Host memory readings the producer stamps on every row; both stay optional — absent or malformed reads as unrecorded, never zero. */
const memFreePct = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const swapGb = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
/** Example job ids quoted per cell inside one prompt. */
const MAX_EXAMPLE_JOBS = 3;

export interface PoolDetectItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default POOL_DETECT_WINDOW_HOURS). */
  windowHours?: number;
  /** Newest-bytes bound on the jobs-ledger tail (default POOL_DETECT_LEDGER_LIMIT). */
  ledgerLimit?: number;
  /** Most items one call emits (default POOL_DETECT_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One recurring pool-detection cell: a (lane, kind) group of distinct jobs. */
export interface PoolDetectCell {
  /** Bounded lane identifier the producer recorded. */
  lane: string;
  /** The closed-vocabulary detection class the wall scan matched. */
  kind: string;
  /** Distinct job ids inside the window — the recurring count. */
  jobs: number;
  /** Distinct UTC days the cell's rows span inside the window. */
  days: number;
  /** Total valid rows folded into the cell. */
  rows: number;
  /** Rows carrying a usable mem_free_pct reading. */
  memRows: number;
  /** Rows carrying a usable swap_gb reading. */
  swapRows: number;
  /** Lowest recorded mem_free_pct across the cell's rows; null when none carried one. */
  memFreePctMin: number | null;
  /** Highest recorded swap_gb across the cell's rows; null when none carried one. */
  swapGbMax: number | null;
  /** Up to MAX_EXAMPLE_JOBS prompt-safe job ids. */
  examples: string[];
  /** ISO bounds of the cell's recorded rows; null when none carried a usable timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

interface PoolRow {
  lane: string;
  kind: string;
  job: string;
  mem: number | null;
  swap: number | null;
}

/**
 * Validate one ledger row under the producer's contract. Returns null
 * when the row is not a usable pool-detection receipt: the event name
 * must resolve through the shared dialect to 'pool', the kind must sit
 * inside the producer's closed CLS vocabulary, the lane must sit inside
 * the bounded lane-id shape and the job inside the ledger's id shape.
 * The timestamp placement and the optional host readings are the
 * caller's fold concerns.
 */
function parsePoolRow(row: Record<string, unknown>): PoolRow | null {
  if (ledgerEventName(row) !== 'pool') return null;
  const kind = row['kind'];
  if (typeof kind !== 'string' || !POOL_DETECT_KINDS.has(kind)) return null;
  const lane = ledgerLane(row);
  const job = ledgerJobId(row);
  if (lane === null || !LANE.test(lane) || job === null || !LEDGER_JOB_ID.test(job)) return null;
  return { lane, kind, job, mem: memFreePct(row['mem_free_pct']), swap: swapGb(row['swap_gb']) };
}

/**
 * Pure: fold jobs.jsonl text into per-(lane, kind) cells.
 * Rows are validated under the producer's contract; rows whose
 * timestamp cannot be placed inside [nowMs - windowMs, nowMs] never
 * reach a cell. `jobs` is distinct job ids — the recurring measure —
 * while `rows` keeps the raw record count.
 */
export function foldPoolDetectCells(text: string, nowMs: number, windowMs: number): PoolDetectCell[] {
  const cells = new Map<string, {
    lane: string;
    kind: string;
    jobIds: Set<string>;
    rows: number;
    days: Set<string>;
    memRows: number;
    swapRows: number;
    memMin: number | null;
    swapMax: number | null;
    examples: string[];
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // Cheap prefilter: pool receipts are a minority of rows.
    if (!line.includes('"pool"')) continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      row = parsed as Record<string, unknown>;
    } catch { continue; }
    const parsed = parsePoolRow(row);
    if (parsed === null) continue;
    const ms = ledgerAtMs(row);
    if (ms === null || ms > nowMs || ms < nowMs - windowMs) continue;
    const key = `${parsed.lane}:${parsed.kind}`;
    let cell = cells.get(key);
    if (cell === undefined) {
      cell = { lane: parsed.lane, kind: parsed.kind,
        jobIds: new Set(), rows: 0, days: new Set(), memRows: 0, swapRows: 0,
        memMin: null, swapMax: null, examples: [], firstMs: null, lastMs: null };
      cells.set(key, cell);
    }
    cell.rows += 1;
    cell.jobIds.add(parsed.job);
    cell.days.add(dayOf(ms));
    if (parsed.mem !== null) {
      cell.memRows += 1;
      cell.memMin = cell.memMin === null ? parsed.mem : Math.min(cell.memMin, parsed.mem);
    }
    if (parsed.swap !== null) {
      cell.swapRows += 1;
      cell.swapMax = cell.swapMax === null ? parsed.swap : Math.max(cell.swapMax, parsed.swap);
    }
    if (SAFE_JOB_ID.test(parsed.job)
        && cell.examples.length < MAX_EXAMPLE_JOBS && !cell.examples.includes(parsed.job)) {
      cell.examples.push(parsed.job);
    }
    cell.firstMs = cell.firstMs === null ? ms : Math.min(cell.firstMs, ms);
    cell.lastMs = cell.lastMs === null ? ms : Math.max(cell.lastMs, ms);
  }
  return [...cells.values()]
    .map((cell) => ({
      lane: cell.lane,
      kind: cell.kind,
      jobs: cell.jobIds.size,
      days: cell.days.size,
      rows: cell.rows,
      memRows: cell.memRows,
      swapRows: cell.swapRows,
      memFreePctMin: cell.memMin,
      swapGbMax: cell.swapMax,
      examples: cell.examples,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
    }))
    .sort((a, b) => b.jobs - a.jobs || a.lane.localeCompare(b.lane) || a.kind.localeCompare(b.kind));
}

const NO_CHANGE = 'If the window has rolled forward, the detections were a transient provider state that has since cleared, they trace to deliberate operator state (a lane parked on a metered seat, a quota window mid-reset, a maintenance pause) or owner-only causes — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the pinned boundary and the folding commands are named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd\'s ratelimited() per-tick scan (contrib/mac/dispatchd.py) appends one {"event":"pool","lane","job","kind","mem_free_pct","swap_gb","ts"} row per (job, class) detection — the .<class>.seen marker under the runs dir caps each pair at one row ever — always with kind inside the closed CLS vocabulary (credits_exhausted, usage_limit, model_capacity, rate_limit). The scanner, the CLS patterns, the seen markers and the per-kind reactions (credits_exhausted holds the lane, model_capacity changes no slot, rate_limit and usage_limit halve the concurrency target) are pinned, Security-reviewed ops machinery in contrib/mac/dispatchd.py that agents never edit live; source changes there still need Security review and re-pin before install. src/core/router/outcomes.ts joins the same rows as pool_kind/pool_mem_free_pct/pool_swap_gb context on each job\'s outcome and src/core/router/weight-proposals.ts tallies them inside its unknown-outcome cohort — the readers this feed complements.';

/** Per-kind reaction and hunt text: what dispatchd did and where the cause can live. */
const KIND_TEXT: Record<string, { what: string; reaction: string; hunt: string }> = {
  credits_exhausted: {
    what: 'credits-exhausted wall detections',
    reaction: 'each detection also placed a lane hold (LANE_HOLD credits exhausted), so the lane stopped launching until the hold cleared',
    hunt: 'whether the lane\'s provider account genuinely ran out of credits (the usage-readings journal and capacity evidence should agree) or the detector matched job-output text that only looks like a credits wall, whether work kept routing onto the held lane\'s class anyway, and whether this repository\'s lane placement or quota posture should keep that seat in rotation',
  },
  usage_limit: {
    what: 'usage-limit wall detections',
    reaction: 'each detection halved the lane\'s concurrency target, so the lane kept launching at reduced parallelism',
    hunt: 'whether the provider\'s usage window keeps saturating under the lane\'s real load (usage readings, reset times and seat concurrency are the evidence) or the error-line tail keeps matching text that is not a live wall — a job whose own output quotes limit errors, CI logs carrying 429s, or prompt content that trips the pattern — and whether the lane\'s offered load should shrink or rotate',
  },
  model_capacity: {
    what: 'model-capacity wall detections',
    reaction: 'each detection changed no slot — dispatchd logs MODEL_CAPACITY_SEEN and keeps the lane at its target, so these rows are pure detection evidence',
    hunt: 'whether the lane\'s pinned model endpoint keeps reporting capacity errors (provider weather that recurs on a schedule versus a model id that permanently saturates) or the tail keeps matching overload text the run recovered from, and whether lane placement or the router\'s model evidence should steer this work elsewhere while the endpoint stays saturated',
  },
  rate_limit: {
    what: 'rate-limit wall detections',
    reaction: 'each detection halved the lane\'s concurrency target alongside the usage-limit family',
    hunt: 'whether the provider\'s request-rate ceiling keeps tripping under the lane\'s launch cadence and seat fan-out, whether retries inside a single job multiply the hits the tail scan sees, and whether dispatch pacing or lane concurrency in this repository\'s routing evidence should absorb the ceiling instead of the target ratchet',
  },
};

function seenText(cell: PoolDetectCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function examplesText(cell: PoolDetectCell): string {
  return cell.examples.length === 0 ? '' : ` Example job ids: ${cell.examples.join(', ')}.`;
}

function hostText(cell: PoolDetectCell): string {
  const parts: string[] = [];
  if (cell.memRows > 0 && cell.memFreePctMin !== null) {
    parts.push(`the lowest recorded mem_free_pct across ${cell.memRows} reading(s) was ${cell.memFreePctMin}%`);
  }
  if (cell.swapRows > 0 && cell.swapGbMax !== null) {
    parts.push(`the highest recorded swap_gb across ${cell.swapRows} reading(s) was ${cell.swapGbMax} GB`);
  }
  if (parts.length === 0) return ' The rows carried no usable host memory readings.';
  return ` Host memory at detection: ${parts.join('; ')} — correlation evidence only, not proof the host caused the walls.`;
}

function poolPrompt(cell: PoolDetectCell, truncated: boolean): string {
  const kind = KIND_TEXT[cell.kind] ?? KIND_TEXT['rate_limit']!;
  return [
    `Phantom's dispatcher keeps detecting ${kind.what} on lane '${cell.lane}' — ${cell.jobs} distinct job(s) across the window (${cell.rows} recorded pool row(s), class '${cell.kind}'), the self-improvement work this backlog exists for.`,
    '',
    `Each row is dispatchd's own verdict that a running job's fresh error-line tail matched a provider-limit pattern: the per-tick ratelimited() scan found the match, the .<class>.seen marker capped it at one row per (job, class), and ${kind.reaction}. Every detection is a wall the fleet saw while work was in flight — recurring detections on one lane mean that lane's provider posture, its offered load, or the detector's own match window is producing the pattern often enough to matter.${seenText(cell)}${examplesText(cell)}${hostText(cell)}`,
    '',
    EVIDENCE,
    '',
    ...(truncated ? ['The jobs-ledger read is a bounded newest-bytes tail, so these counts are a lower bound — older detections may exist beyond the retained window.', ''] : []),
    `Find which side owns the cause: ${kind.hunt}. Fix what lives here — for example routing or lane-placement evidence in src/core/router/ and src/core/routing/ that should weigh these detections, a usage/capacity reader that should distrust wall verdicts the quota evidence contradicts, or a detector-input problem this repository can name (the scan itself is pinned contrib/mac ops machinery — report, never edit live). If the window has rolled forward or the cause is owner-side — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function poolDetectItem(cell: PoolDetectCell, repo: string, truncated: boolean): CloudBacklogItem {
  const id = `fleet-pool-detect-${createHash('sha256').update(`pool-detect:${cell.lane}:${cell.kind}`).digest('hex').slice(0, 16)}`;
  const what = KIND_TEXT[cell.kind]?.what ?? 'provider-wall detections';
  const title = `${what.charAt(0).toUpperCase()}${what.slice(1)} keep firing on lane '${cell.lane}'`
    .slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: poolPrompt(cell, truncated),
    area: 'pool-detects',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the jobs ledger's recurring pool-detection cells.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function poolDetectBacklogItems(opts: PoolDetectItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling jobs-ledger feeds apply: explicit dir,
    // then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs — an empty env
    // value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const jobsPath = join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE);
    const nowMs = (opts.now ?? new Date()).getTime();
    const read = await readLedgerTail(jobsPath, opts.ledgerLimit ?? POOL_DETECT_LEDGER_LIMIT);
    if (read.state !== 'read') return [];
    const windowMs = (opts.windowHours ?? POOL_DETECT_WINDOW_HOURS) * 3_600_000;
    const cells = foldPoolDetectCells(read.text, nowMs, windowMs)
      .filter((cell) => cell.jobs >= POOL_DETECT_MIN_JOBS && cell.days >= POOL_DETECT_MIN_DAYS);
    const limit = Math.max(1, Math.min(opts.limit ?? POOL_DETECT_MAX_ITEMS, POOL_DETECT_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => poolDetectItem(cell, repo, read.truncated));
  } catch {
    return [];
  }
}
