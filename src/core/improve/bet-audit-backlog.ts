/**
 * Bet-audit lost-order evidence → self-improvement backlog items.
 *
 * `phm fleet bet-audit` (src/core/fleet/bet-audit.ts, schema
 * fleet.bet-audit.v1) folds the leader's order stream — BET and FIXUP
 * lines in supervisor/out.<YYYYMMDDTHHMM>.txt files under the runs dir —
 * against the two places an order can become work: `- READY`/`- CLAIMED`
 * lines in queue/router-queue.md and `RQ-` job rows in the
 * metrics/jobs.jsonl tail. An order with no queue line and no metrics
 * row reads 'lost': the leader counted it as written and nothing
 * noticed it vanished between issue and launch. Two honesty gaps keep
 * the report out of the backlog on its own: it is a report someone had
 * to run and read, and a lost order produces no job — so outcome
 * learning, `phm bets`/leader-batches and every job-level fold never
 * see the work that was ordered and never happened.
 *
 * betAuditBacklogItems carries the recurring lost cells into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue them exactly like the sibling fleet-evidence
 * sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The supervisor out-files, router-queue.md and the
 *    jobs.jsonl tail are read through readBetAudit's bounded sources
 *    (256 KiB per out-file, 2 MiB queue, 8 MiB metrics tail); nothing
 *    is written and no network is touched.
 *  - Healthy-only where it matters. A 'lost' verdict is only as good
 *    as the two sources that could have shown the order becoming
 *    work: a missing or degraded metrics/jobs.jsonl makes every
 *    launched order read lost, and a degraded router-queue.md can
 *    hide READY/CLAIMED lines — both fabricate losses, so the source
 *    stays quiet. A missing queue file is a genuinely empty upstream
 *    queue (router-queue.md is the document the restocker refills
 *    ready.tsv from), and a degraded supervisor stream only
 *    undercounts orders already parsed — its cells emit with counts
 *    stated as recorded floors.
 *  - Recurring means recorded. A repo cell emits only at
 *    BET_AUDIT_RECURRING lost orders inside the window, so one dropped
 *    order never queues a session. Cells group by the order's
 *    recorded target repo — the order→queue intake is shared fleet
 *    machinery, but orders for one repo dying while others succeed is
 *    distinct evidence.
 *  - Attribution is as recorded. The order's repo and lane labels are
 *    leader-written text; they are scrubbed, flattened and capped
 *    before use, and orders whose labels sanitize to nothing group
 *    under 'unknown' rather than being guessed. Order kinds and lanes
 *    are tallied inside the prompt as evidence.
 *  - The order stream is leader-side machinery. The supervisor
 *    out-files are the leader agent's own output and the step that
 *    turns orders into src=leader queue lines sits outside this
 *    repository. Items therefore emit only when the backlog target's
 *    repository name is 'phantom' — the same last-segment rule the
 *    sibling fleet-evidence sources apply — and their prompts direct
 *    sessions to fix what this repository owns (the queue lifecycle
 *    the orders must survive in src/core/queue, the detectors that
 *    read this evidence) or report no-change naming leader-side,
 *    pinned or owner-only causes.
 *  - Dedup is downstream. The item id hashes the cell identity (the
 *    order target repo — never the counts or timestamps), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds
 *    only what is new; a cell that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, example order ids must match the audit's
 *    own id shape before they are quoted, and the brief carries the
 *    usual no-change escape.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  readBetAudit,
  type BetAuditRow,
} from '../fleet/bet-audit.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; repo cells are bounded by repo diversity. */
export const BET_AUDIT_MAX_ITEMS = 8;
const BET_AUDIT_ITEM_HARD_MAX = 25;
/**
 * Lost orders one repo cell needs inside the window before it counts as
 * recurring — the fleet's RECURRING_FAILURES convention the sibling
 * feeds apply to their own tallies.
 */
export const BET_AUDIT_RECURRING = 3;
/** Evidence window: three days of order files gives recurring patterns room without letting stale losses linger. */
export const BET_AUDIT_WINDOW_HOURS = 72;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Repo/lane strings are leader-recorded text; flatten, scrub and cap before use. */
const MAX_REPO_CHARS = 120;
const MAX_LANE_CHARS = 60;
/** Distinct kind and lane tallies quoted inside one prompt. */
const MAX_PROMPT_TALLIES = 4;
/** Example order ids quoted per cell inside one prompt; each must match the audit id shape. */
const MAX_EXAMPLES = 3;
/** The fleet's own repository label: order evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** The order-id shape the audit constructs (RQ-<token>Q8 / RQ-FIXUP-<token>Q8); anything else is never quoted. */
const SAFE_ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface BetAuditItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding supervisor/, queue/ and metrics/; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in hours (default BET_AUDIT_WINDOW_HOURS). */
  sinceHours?: number;
  /** Most items one call emits (default BET_AUDIT_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

export interface BetAuditTally {
  /** Sanitized recorded text (an order kind or a lane label). */
  text: string;
  count: number;
}

/** One order-target repo cell: recorded lost orders plus the detail the prompt quotes. */
export interface BetAuditCell {
  /** Sanitized recorded order target, or 'unknown' when none was recorded. */
  repo: string;
  /** Lost orders inside the window — distinct order ids. */
  count: number;
  /** Recorded order kinds ('BET'/'FIXUP' by the audit's own id prefix), most frequent first. */
  kinds: BetAuditTally[];
  /** Recorded lane labels, most frequent first; orders without one tally as 'unrecorded'. */
  lanes: BetAuditTally[];
  /** Up to MAX_EXAMPLES audit-safe order ids. */
  orders: string[];
  /** ISO bounds of the cell's recorded orders; null when none carried a timestamp. */
  firstSeen: string | null;
  lastSeen: string | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Leader-recorded text is unbounded; scrub secrets, flatten to one line and cap. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function tallyOf(map: Map<string, number>, max: number): BetAuditTally[] {
  return [...map.entries()]
    .map(([text, count]) => ({ text, count }))
    .sort((a, b) => b.count - a.count || a.text.localeCompare(b.text))
    .slice(0, max);
}

/**
 * Pure: fold the bet-audit rows into per-repo lost-order cells. Only
 * 'lost' rows count — queued, claimed, launched, published and merged
 * orders became work and are evidence of health, not loss.
 */
export function foldBetAuditCells(rows: readonly BetAuditRow[]): BetAuditCell[] {
  const cells = new Map<string, {
    repo: string;
    count: number;
    kinds: Map<string, number>;
    lanes: Map<string, number>;
    orders: string[];
    firstMs: number | null;
    lastMs: number | null;
  }>();
  for (const row of rows) {
    if (row.status !== 'lost') continue;
    const repo = fieldText(row.repo, MAX_REPO_CHARS) || 'unknown';
    let cell = cells.get(repo);
    if (cell === undefined) {
      cell = { repo, count: 0, kinds: new Map(), lanes: new Map(), orders: [], firstMs: null, lastMs: null };
      cells.set(repo, cell);
    }
    cell.count += 1;
    bump(cell.kinds, row.id.startsWith('RQ-FIXUP-') ? 'FIXUP' : 'BET');
    const lane = row.lane === null || row.lane.trim() === ''
      ? 'unrecorded'
      : fieldText(row.lane, MAX_LANE_CHARS) || 'unrecorded';
    bump(cell.lanes, lane);
    if (cell.orders.length < MAX_EXAMPLES && SAFE_ORDER_ID.test(row.id) && !cell.orders.includes(row.id)) cell.orders.push(row.id);
    const at = Date.parse(row.issuedAt);
    if (Number.isFinite(at)) {
      cell.firstMs = cell.firstMs === null ? at : Math.min(cell.firstMs, at);
      cell.lastMs = cell.lastMs === null ? at : Math.max(cell.lastMs, at);
    }
  }
  return [...cells.values()]
    .map((cell) => ({
      repo: cell.repo,
      count: cell.count,
      kinds: tallyOf(cell.kinds, MAX_PROMPT_TALLIES),
      lanes: tallyOf(cell.lanes, MAX_PROMPT_TALLIES),
      orders: cell.orders,
      firstSeen: cell.firstMs === null ? null : new Date(cell.firstMs).toISOString(),
      lastSeen: cell.lastMs === null ? null : new Date(cell.lastMs).toISOString(),
    }))
    .sort((a, b) => b.count - a.count || a.repo.localeCompare(b.repo));
}

const NO_CHANGE = 'If the window has rolled forward, the losses were a one-off burst the next orders recovered from, or the cause is leader-side machinery, pinned ops files, host state or owner-only — report no-change and name the evidence.';

/** The evidence pointers every prompt shares; the audit command is named so the session can reproduce the fold. */
const EVIDENCE = 'The evidence is the fleet.bet-audit.v1 report from `phm fleet bet-audit --hours 72h --json` (src/core/fleet/bet-audit.ts): BET and FIXUP order lines parsed from supervisor/out.*.txt files under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), cross-checked against `- READY`/`- CLAIMED` lines in queue/router-queue.md and `RQ-` job rows in the metrics/jobs.jsonl tail. An order with no queue line and no metrics row reads lost; `phm fleet bet-trace` reconciles the same order stream against queue and slot state.';

function tallyText(tallies: readonly BetAuditTally[]): string {
  return tallies.map((t) => `'${t.text}' ×${t.count}`).join(', ');
}

function seenText(cell: BetAuditCell): string {
  if (cell.firstSeen === null || cell.lastSeen === null) return '';
  return cell.firstSeen === cell.lastSeen
    ? ` Recorded ${cell.firstSeen}.`
    : ` Recorded ${cell.firstSeen} through ${cell.lastSeen}.`;
}

function ordersText(cell: BetAuditCell): string {
  return cell.orders.length === 0 ? '' : ` Example order ids: ${cell.orders.join(', ')}.`;
}

function lostOrdersPrompt(cell: BetAuditCell, partial: boolean): string {
  const lead = partial
    ? `Phantom's leader keeps issuing orders that never become work — at least ${cell.count} recorded lost order(s) targeting '${cell.repo}' inside the window (part of the supervisor stream was unreadable, so the true count may be higher), the self-improvement work this backlog exists for.`
    : `Phantom's leader keeps issuing orders that never become work — ${cell.count} recorded lost order(s) targeting '${cell.repo}' inside the window, the self-improvement work this backlog exists for.`;
  return [
    lead,
    '',
    `A BET or FIXUP line in a supervisor/out.<YYYYMMDDTHHMM>.txt file under the fleet runs directory records an order the leader counted as written, but the order never appears as a - READY or - CLAIMED line in queue/router-queue.md and no RQ- job row reached metrics/jobs.jsonl — issued, then dropped somewhere between the order stream and the queue. Recorded order kinds: ${tallyText(cell.kinds)}. Recorded lanes: ${tallyText(cell.lanes)}.${ordersText(cell)}${seenText(cell)}`,
    '',
    EVIDENCE,
    '',
    `The supervisor order stream is the leader agent's own output and the step that turns orders into src=leader queue lines sits outside this repository. What this repository owns is everything the orders must survive on the way to work: the queue lifecycle in src/core/queue (router-queue.md is the upstream document the restocker refills ready.tsv from; dedupe, supersede, coalesce and visit-sync all rewrite or drop lines), the fleet code around it, and every detector that reads this evidence — bet-audit names the lost verdict and bet-trace reconciles the same commands against queue and slot state, but a lost order produces no job for either of them or for outcome learning to ever score.`,
    '',
    `Find where the orders die between issue and queue: whether the leader's order-to-queue step drops them (leader-side — report no-change naming the evidence), whether a queue pass in this repo eats the orders' lines, or whether orders are landing on a queue surface the audit does not read. Fix what lives here; if the cause is leader-side, pinned ops machinery, host state or owner-only — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function betAuditItem(cell: BetAuditCell, repo: string, partial: boolean): CloudBacklogItem {
  const title = `Leader orders keep vanishing before becoming work${cell.repo === 'unknown' ? '' : ` on ${cell.repo}`}`;
  const id = `fleet-bet-audit-${createHash('sha256').update(`bet:${cell.repo}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: lostOrdersPrompt(cell, partial),
    area: 'lost-orders',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the bet-audit report's recurring per-repo lost-order
 * cells. Total: any read or fold failure yields no items rather than
 * throwing into discovery.
 */
export async function betAuditBacklogItems(opts: BetAuditItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence readBetAudit applies through resolveDropJobRoot:
    // explicit dir, then a non-empty ASHLR_RUNS_DIR, then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR']?.trim();
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns !== '' ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const hours = opts.sinceHours ?? BET_AUDIT_WINDOW_HOURS;
    const report = await readBetAudit(runsDir, {
      hours: Number.isFinite(hours) && hours > 0 ? hours : BET_AUDIT_WINDOW_HOURS,
      now: () => nowMs,
    });
    // A 'lost' verdict needs both escape hatches readable: without a
    // healthy jobs ledger a launched order reads lost, and a degraded
    // queue can hide READY/CLAIMED lines — both fabricate losses, so the
    // source stays quiet. A missing queue file is a genuinely empty
    // upstream queue, and a degraded supervisor stream only undercounts
    // orders already parsed.
    if (report.sources.metrics !== 'healthy' || report.sources.queue === 'degraded') return [];
    const partial = report.sources.supervisor === 'degraded';
    const cells = foldBetAuditCells(report.rows)
      .filter((cell) => cell.count >= BET_AUDIT_RECURRING);
    const limit = Math.max(1, Math.min(opts.limit ?? BET_AUDIT_MAX_ITEMS, BET_AUDIT_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => betAuditItem(cell, repo, partial));
  } catch {
    return [];
  }
}
