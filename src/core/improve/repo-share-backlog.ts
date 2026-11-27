/**
 * Work-market share journal → self-improvement backlog items.
 *
 * Every dispatchd tick runs the shared work market
 * (contrib/mac/work_market.py, driven from dispatchd.py) and, whenever the
 * per-repo share allocation changes, appends one `repo_share` row per repo
 * to <runs>/metrics/work-market.jsonl through market_metric(): the repo's
 * market score, its share of dispatch attention, its owner-set priority
 * and the reason codes behind the score — `ready_work`,
 * `historical_solution_yield`, the declared-impact and fix-ready bonuses,
 * `owner_boost`/`owner_pause`, and the three repo-freshness verdict codes
 * `docs_freshness_drift`, `site_freshness_unhealthy` and
 * `site_freshness_stale`. Those three are the market's own record that a
 * repo's weekly freshness job — `RQ-DOCS-FRESHNESS-<repo>-<period>` or
 * `RQ-SITE-FRESHNESS-<repo>-<period>`, minted by src/core/drive/queuegen.ts
 * — reported an adverse verdict (drift, unhealthy, stale) in its
 * BRIDGE_NOTES.md FRESHNESS line, which dispatchd folds into
 * queue/repo-freshness.json and work_market.freshness_signals turns into a
 * score bonus. Until now the journal's repo_share rows had exactly one
 * reader — `phm repos`' allocation display over the queue/repo-shares.json
 * snapshot — a report someone had to run, so a freshness verdict that kept
 * coming back adverse never became work: the market kept weighting the
 * repo's share up while nothing queued the investigation. The sibling
 * folds already cover the journal's route_decision, unfed_capacity and
 * posture events; repo_share was the last unfolded event.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable file yields no items.
 *  - Rows count only under the writer's contract: schema
 *    'work-market.v1', event 'repo_share', an epoch-seconds `ts` inside
 *    the window (the same ±5-minute future skew the sibling folds
 *    tolerate), a lowercase owner/name `repo`, a priority inside the
 *    writer's boost|normal|pause vocabulary, finite score >= 0 and
 *    share inside [0, 1], and reason_codes drawn from the writer's
 *    closed set. Malformed lines, other schemas and other events are
 *    skipped, never guessed.
 *  - Only the freshness verdict codes emit. Every other reason code is
 *    either a designed positive signal (ready_work,
 *    historical_solution_yield, the fix-ready and impact bonuses) or
 *    deliberate owner state (owner_boost, owner_pause) — none is
 *    backlog evidence.
 *  - Recurring means recorded across days: a (repo, code) cell emits
 *    only at REPO_SHARE_MIN_ROWS recorded share rows across
 *    REPO_SHARE_MIN_DAYS distinct UTC days inside the window. Share
 *    rows are change-triggered — one per repo whenever the allocation
 *    moves — so the counts are recorded market decisions, not ticks.
 *  - Truncation is stated, never hidden: when the bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Items self-target the repository the evidence names — unlike the
 *    sibling lane feeds, the freshness verdict belongs to that repo's
 *    docs or site, so the fix lands where the drift lives (the
 *    outside-pr feed's own convention). Dedup is downstream: item ids
 *    hash the (repo, code) cell identity, never counts or timestamps,
 *    so refreshes re-derive the same ids.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail, ROUTER_MARKET_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; freshness cells stay well under this. */
export const REPO_SHARE_BACKLOG_MAX_ITEMS = 10;
const REPO_SHARE_BACKLOG_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention. */
export const REPO_SHARE_WINDOW_HOURS = 168;
/**
 * Bounded tail of the append-only journal — the same 32 MiB tail the
 * unfed and posture folds read; route_decision rows dominate the file,
 * so this covers the recent decision stream and prompts state any
 * truncation as a lower bound.
 */
export const REPO_SHARE_TAIL_BYTES = 32 * 1024 * 1024;
/** Future-skew allowance on row timestamps, the sibling folds' convention. */
const REPO_SHARE_FUTURE_SKEW_SECONDS = 300;
/** Share rows are change-triggered; three recorded decisions carrying the code is the recurrence bar... */
export const REPO_SHARE_MIN_ROWS = 3;
/** ...across at least this many distinct UTC days. */
export const REPO_SHARE_MIN_DAYS = 2;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

/**
 * The writer's repo vocabulary: work_market.repo_key lowercases and
 * requires owner/name — the same shape repos-manager validates.
 */
const REPO = /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9._-]{0,99}$/;
/** The writer's priority vocabulary (work_market.repo_shares' nudge values). */
const PRIORITY: ReadonlySet<string> = new Set(['boost', 'normal', 'pause']);
/** Reason codes the producer writes — the same closed shape the sibling folds validate. */
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
/** Bounded per-row collections, mirroring the sibling folds' caps. */
const MAX_REASON_CODES = 32;

/**
 * The only adverse reason codes the market records: each means the
 * repo's repo-freshness.json verdict — written from the weekly
 * RQ-DOCS-FRESHNESS/RQ-SITE-FRESHNESS job's BRIDGE_NOTES.md FRESHNESS
 * line — is currently drift/unhealthy/stale and work_market's
 * freshness_signals is adding the matching score bonus. Every other
 * code is a designed positive signal or deliberate owner state.
 */
export const REPO_SHARE_ADVERSE_CODES = [
  'docs_freshness_drift',
  'site_freshness_unhealthy',
  'site_freshness_stale',
] as const;

const ADVERSE_CODES: ReadonlySet<string> = new Set(REPO_SHARE_ADVERSE_CODES);

/** Human labels for the prompt and title — the verdict each code records. */
const CODE_LABELS: Record<string, string> = {
  'docs_freshness_drift': 'docs freshness drift',
  'site_freshness_unhealthy': 'site freshness unhealthy',
  'site_freshness_stale': 'site freshness stale',
};

export interface RepoShareBacklogOptions {
  /** Runs dir holding metrics/work-market.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default REPO_SHARE_WINDOW_HOURS). */
  windowHours?: number;
  /** Journal override (default: <runsDir>/metrics/work-market.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default REPO_SHARE_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const dayOf = (tsSeconds: number): string => new Date(tsSeconds * 1000).toISOString().slice(0, 10);

/** Ledger-recorded names are regex-bounded already; scrub and cap defensively before display. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** Per-(repo, code) adverse freshness evidence inside the window. */
interface ShareCell {
  repo: string;
  code: string;
  /** Recorded share rows carrying the code. */
  rows: number;
  days: Set<string>;
  /** The newest recorded allocation context for the prompt. */
  lastShare: number;
  lastScore: number;
  lastPriority: string;
  firstMs: number | null;
  lastMs: number | null;
}

export interface ShareFold {
  /** Valid in-window repo_share rows (rows that passed the producer contract). */
  records: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  /** Adverse (repo, code) cells. */
  cells: Map<string, ShareCell>;
}

/**
 * Pure: fold one journal tail into per-(repo, code) adverse freshness
 * cells. Rows outside the window are skipped as non-evidence; malformed
 * JSON, wrong schema/event, a missing or non-finite timestamp and a
 * repo_share row that fails the producer's shape (bad repo, priority
 * outside the vocabulary, non-finite score/share, non-array
 * reason_codes) all count as invalid — the writer's contract is
 * all-or-nothing per row.
 */
export function foldShareJournal(text: string, nowMs: number, windowHours: number): ShareFold {
  const fold: ShareFold = { records: 0, invalidRows: 0, cells: new Map() };
  const since = nowMs / 1000 - windowHours * 3600;
  const until = nowMs / 1000 + REPO_SHARE_FUTURE_SKEW_SECONDS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Cheap prefilter: share events are a minority of rows and the
    // pinned writer emits compact JSON, so '"event":"repo_share"' is verbatim.
    if (!trimmed.includes('"event":"repo_share"')) continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isRecord(row) || row['schema'] !== 'work-market.v1' || row['event'] !== 'repo_share') {
      fold.invalidRows += 1;
      continue;
    }
    const ts = row['ts'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) {
      fold.invalidRows += 1;
      continue;
    }
    if (ts < since || ts > until) continue;
    const repo = row['repo'];
    const priority = row['priority'];
    const score = row['score'];
    const share = row['share'];
    const codes = row['reason_codes'];
    if (typeof repo !== 'string' || !REPO.test(repo) ||
        typeof priority !== 'string' || !PRIORITY.has(priority) ||
        typeof score !== 'number' || !Number.isFinite(score) || score < 0 ||
        typeof share !== 'number' || !Number.isFinite(share) || share < 0 || share > 1 ||
        !Array.isArray(codes)) {
      fold.invalidRows += 1;
      continue;
    }
    fold.records += 1;
    const adverse = new Set<string>();
    for (const code of codes.slice(0, MAX_REASON_CODES)) {
      if (typeof code === 'string' && CODE.test(code) && ADVERSE_CODES.has(code)) adverse.add(code);
    }
    if (adverse.size === 0) continue;
    const atMs = ts * 1000;
    const day = dayOf(ts);
    for (const code of adverse) {
      const key = `${repo}${code}`;
      let cell = fold.cells.get(key);
      if (cell === undefined) {
        cell = {
          repo, code, rows: 0, days: new Set(),
          lastShare: share, lastScore: score, lastPriority: priority,
          firstMs: null, lastMs: null,
        };
        fold.cells.set(key, cell);
      }
      cell.rows += 1;
      cell.days.add(day);
      // The newest row's allocation context is the prompt's quote — rows
      // arrive in journal order, so later rows overwrite earlier ones.
      cell.lastShare = share;
      cell.lastScore = score;
      cell.lastPriority = priority;
      cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
      cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
    }
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring evidence only
// ---------------------------------------------------------------------------

export interface ShareBacklogCell {
  repo: string;
  code: string;
  /** Recorded share rows carrying the code inside the window. */
  rows: number;
  days: string[];
  /** The newest recorded allocation context. */
  lastShare: number;
  lastScore: number;
  lastPriority: string;
  firstSeen: string | null;
  lastSeen: string | null;
  lowerBound: boolean;
}

const isoOrNull = (ms: number | null): string | null => ms === null ? null : new Date(ms).toISOString();

const daysText = (days: readonly string[]): string => {
  const shown = days.slice(0, MAX_PROMPT_DAYS).join(', ');
  return days.length > MAX_PROMPT_DAYS ? `${shown} (+${days.length - MAX_PROMPT_DAYS} more)` : shown;
};

const boundNote = (lowerBound: boolean): string =>
  lowerBound ? ' The journal tail was truncated at the bounded read, so these counts cover only the retained window — a lower bound, not the full window.' : '';

/**
 * Pure: the recurring cells the fold justifies. A (repo, code) cell
 * emits only while its recorded share rows reach REPO_SHARE_MIN_ROWS
 * across REPO_SHARE_MIN_DAYS distinct UTC days. Sorted by rows, then
 * repo and code — deterministic across refreshes.
 */
export function shareCells(fold: ShareFold, lowerBound = false): ShareBacklogCell[] {
  const cells: ShareBacklogCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.rows < REPO_SHARE_MIN_ROWS || cell.days.size < REPO_SHARE_MIN_DAYS) continue;
    cells.push({
      repo: cell.repo, code: cell.code,
      rows: cell.rows, days: [...cell.days].sort(),
      lastShare: cell.lastShare, lastScore: cell.lastScore, lastPriority: cell.lastPriority,
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.rows - a.rows || a.repo.localeCompare(b.repo) || a.code.localeCompare(b.code));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/work-market.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): dispatchd\'s market_metric appends one work-market.v1 repo_share row per repo whenever the market\'s share allocation changes — each row\'s score, share, priority and reason_codes computed by contrib/mac/work_market.py repo_shares() from the ready queue\'s per-repo job mix, the declared job impacts, the observed merge rates and the repo-freshness verdicts. The freshness verdict itself lives in queue/repo-freshness.json, written when a weekly freshness job lands its BRIDGE_NOTES.md FRESHNESS line, and is mirrored for `phm repos` estimates by repoFreshnessBonuses in src/core/fleet/repo-market.ts. Until this feed no fold turned the recurring adverse verdict codes into work.';

const NO_CHANGE = 'If the window has rolled forward, the verdict has since cleared (the latest freshness job reports clean/healthy or its fix landed), the adverse reading traces to a deliberate operator state (an owner-paused repo whose stale verdict no longer matters, a site that is genuinely not configured) or owner-only cause (deployment credentials, billing, host capacity), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

/** Per-code fix guidance — where the verdict's producer and consumer live. */
const CODE_GUIDANCE: Record<string, string> = {
  'docs_freshness_drift': `The 'docs_freshness_drift' code means repo-freshness.json carries a 'drift' verdict for this repo's docs kind — the weekly RQ-DOCS-FRESHNESS-<repo>-<period> job (minted by enqueueFreshness in src/core/drive/queuegen.ts, goal in FRESHNESS_WORK.DOCS) checked docs, generated navigation and README examples against the code and reported drift in its BRIDGE_NOTES.md FRESHNESS line. Find the newest RQ-DOCS-FRESHNESS job for this repo in metrics/jobs.jsonl: did it finish, what did it report, and did its focused docs-update PR merge? If the job keeps reporting drift, the docs genuinely diverge from the code — fix the drift in this repository (docs/, README, generated navigation) or land the update the job proposed. If the job is failing, never running, or its verdict line is being misparsed, the defect is in the freshness pipeline this repository owns (queuegen.ts, the verdict consumer in work_market.py is pinned — document pinned-side findings for the owner).`,
  'site_freshness_unhealthy': `The 'site_freshness_unhealthy' code means repo-freshness.json carries an 'unhealthy' verdict for this repo's site kind — the weekly RQ-SITE-FRESHNESS-<repo>-<period> job (FRESHNESS_WORK.SITE in src/core/drive/queuegen.ts) found the configured production deployment or public endpoint failing its health checks. Find the newest RQ-SITE-FRESHNESS job for this repo in metrics/jobs.jsonl and its BRIDGE_NOTES evidence: is the deployment down, stale, or misconfigured? Route any repair through the repo's existing review and deployment gates — the freshness job is read-only by design. If the job itself is failing or the endpoint check is broken, the defect is in this repository's freshness or deployment machinery.`,
  'site_freshness_stale': `The 'site_freshness_stale' code means repo-freshness.json carries a 'stale' verdict for this repo's site kind — the weekly RQ-SITE-FRESHNESS-<repo>-<period> job (FRESHNESS_WORK.SITE in src/core/drive/queuegen.ts) found the production deployment behind the default branch. Find the newest RQ-SITE-FRESHNESS job for this repo in metrics/jobs.jsonl: is a release pending, did a deploy fail, or is the deployed revision simply old? Route the repair through the repo's sanctioned release workflow — the freshness job only observes. If deploys keep lagging without a failing job, the gap is in this repository's release or freshness machinery.`,
};

const pct = (share: number): string => `${(share * 100).toFixed(1)}%`;

const cellDays = (cell: ShareBacklogCell): string =>
  `across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;

const seenText = (cell: ShareBacklogCell): string => {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
};

function sharePrompt(cell: ShareBacklogCell): string {
  const repo = fieldText(cell.repo, MAX_NAME_CHARS);
  const code = fieldText(cell.code, MAX_NAME_CHARS);
  const label = CODE_LABELS[cell.code] ?? code;
  const guidance = CODE_GUIDANCE[cell.code] ??
    'Find which freshness verdict keeps coming back adverse and why nothing fixes it.';
  const priorityNote = cell.lastPriority === 'normal' ? '' : ` Its latest recorded priority is '${cell.lastPriority}' — owner-set, so the share boost may be suppressed; the verdict itself is still adverse evidence.`;
  return [
    `The work market keeps recording '${code}' for ${repo} — ${cell.rows} recorded share row${cell.rows === 1 ? '' : 's'} inside the 7-day window ${cellDays(cell)}, the self-improvement work this backlog exists for.`,
    '',
    `'${code}' is the market's own record that ${repo}'s ${label} verdict is adverse: each repo_share row is emitted when the share allocation changes, and the code appears in reason_codes only while repo-freshness.json carries the matching adverse verdict — the weekly freshness job reported it and no later verdict has cleared it.${priorityNote}`,
    '',
    `Latest recorded allocation: share ${pct(cell.lastShare)}, score ${cell.lastScore}${cell.lastPriority === 'normal' ? '' : `, priority '${cell.lastPriority}'`}.${seenText(cell)}${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    guidance,
    '',
    `Fix what lives in ${repo} — the docs or site state the verdict measured, or the freshness pipeline in this repository when the verdict itself is wrong. contrib/mac/work_market.py and contrib/mac/dispatchd.py are pinned dispatcher machinery: a fix there needs Security review and re-pin before install — prefer evidence-backed changes in this repository's src/ where the cause lives, and document pinned-side findings for the owner rather than working around them. ${NO_CHANGE}`,
  ].join('\n');
}

function shareItem(cell: ShareBacklogCell): CloudBacklogItem {
  const label = CODE_LABELS[cell.code] ?? cell.code;
  return {
    id: `repo-share-${sha(`repo-share:${cell.repo}:${cell.code}`)}`,
    title: `Work market keeps recording ${label} for ${cell.repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: sharePrompt(cell),
    area: 'repo-freshness',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(cell.repo) ? { repo: cell.repo } : {}),
  };
}

/**
 * Backlog items for repos whose work-market share evidence keeps
 * recording an adverse freshness verdict. Total: a missing journal,
 * another repository's rows only, or any read or fold failure yields
 * no items rather than throwing into discovery.
 */
export async function repoShareBacklogItems(opts: RepoShareBacklogOptions = {}): Promise<CloudBacklogItem[]> {
  try {
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling folds apply: an absolute ASHLR_RUNS_DIR
    // wins, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowHours = opts.windowHours ?? REPO_SHARE_WINDOW_HOURS;
    const path = opts.journalPath ?? join(runsDir, ROUTER_MARKET_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, REPO_SHARE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldShareJournal(tail.text, nowMs, windowHours);
    if (fold.records === 0) return [];
    const cells = shareCells(fold, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? REPO_SHARE_BACKLOG_MAX_ITEMS, REPO_SHARE_BACKLOG_ITEM_HARD_MAX));
    return cells.slice(0, limit).map(shareItem);
  } catch {
    return [];
  }
}
