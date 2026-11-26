/**
 * Route shadow-policy journal recurring live/shadow divergence with
 * adverse resolved outcomes → self-improvement backlog items.
 *
 * `phm route shadow eval --input <file|-> --record` (src/cli/route.ts)
 * appends one advisory `route.shadow.v1` record per evaluation to
 * <runsDir>/metrics/route.shadow.jsonl through
 * recordShadowPolicyDecision (src/core/router/shadow-policy.ts): the
 * request's repo/task_class/tier, the eligible lane set, the live
 * router's pick (live_lane), the class-failure-avoidance policy's pick
 * (shadow_lane), the support verdict and the per-lane outcome stats the
 * policy ranked on. The record is explicitly advisory — dispatched is
 * always false and nothing about live routing changes.
 *
 * Until now the journal's only readers were buildShadowPolicyReport
 * (`phm route shadow report --json`, also surfaced as
 * shadow_comparison inside `phm route explain --json`) — reports
 * someone had to run and read. The promotion gate inside the report
 * already demands prospective matched evidence before any live routing
 * change, yet recurring divergence between the two routers never
 * became work: a (repo, task_class) cell where the shadow policy keeps
 * choosing a different lane than the live router, and the jobs the live
 * router actually ran keep resolving to failures, is exactly the
 * self-improvement signal the backlog exists to carry.
 *
 * shadowRouteBacklogItems carries the journal into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it
 * exactly like the sibling fleet-evidence sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read once through readLedgerTail's
 *    bounded no-follow tail (the same 8 MiB bound the shadow report
 *    itself uses); the outcome join reads the canonical
 *    readRouterOutcomes projection — the same fold
 *    buildShadowPolicyReport joins through — and only when the journal
 *    tail already holds a cell past the disagreement/day bars, so a
 *    quiet journal never pays for the outcome read. A missing or
 *    unreadable journal yields no items.
 *  - Rows count only under the writer's contract: schema
 *    'route.shadow.v1', advisory true, dispatched false, a known
 *    shadow policy name, a routeId-shaped repo/task_class/job/lanes,
 *    a support_status inside the writer's vocabulary and a parseable
 *    `at` timestamp inside the window plus the sibling folds' five-
 *    minute future skew. Anything less is skipped — never guessed.
 *  - Only supported divergence counts. A cell's evidence is records
 *    whose support_status is 'supported' AND whose recomputed
 *    live_lane !== shadow_lane — the same disagreement rule
 *    parseShadowRecord applies (the stored disagreed flag is never
 *    trusted). insufficient_support and no_candidates rows never
 *    emit: they record absent evidence, not a routing divergence.
 *  - Adverse means resolved live failures. Each disagreed record joins
 *    its job's outcome through the same job-id map and repo-match
 *    guard buildShadowPolicyReport uses; reverted:true or merged:false
 *    is a failure, merged:true is good, anything else stays unknown.
 *    A cell emits only when failures reach the bar AND are at least
 *    half of the cell's resolved disagreed outcomes — the live lane's
 *    picks on exactly the decisions the shadow policy would have
 *    routed differently are failing at least as often as they succeed.
 *    The shadow pick's own outcome is counterfactual and unobserved;
 *    the item says so rather than claiming the alternative would have
 *    won.
 *  - Recurring means recorded across days: a cell emits only at
 *    SHADOW_ROUTE_MIN_DISAGREEMENTS supported disagreements across
 *    SHADOW_ROUTE_MIN_DAYS distinct UTC days inside the window.
 *  - Fleet machinery only: the journal describes this install's
 *    routing, so items emit only when the backlog target's repository
 *    name is 'phantom', the same last-segment rule the sibling
 *    fleet-evidence sources apply.
 *  - Truncation is stated, never hidden: when the bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Dedup is downstream: item ids hash the cell identity — never
 *    the counts or timestamps — so a refresh re-derives the same ids
 *    and appendUserBacklogItems adds only what is new; a cell whose
 *    divergence resolves simply stops re-adding.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { routeIdSchema } from '../routing/decision-schema.js';
import { readLedgerTail, readRouterOutcomes } from '../router/outcomes.js';
import {
  isShadowPolicyName,
  SHADOW_POLICY_LEDGER_LIMIT,
  SHADOW_POLICY_LEDGER_RELATIVE,
  SHADOW_POLICY_RECORD_SCHEMA,
} from '../router/shadow-policy.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; (repo, task_class) cells stay well under this on a real fleet. */
export const SHADOW_ROUTE_MAX_ITEMS = 10;
const SHADOW_ROUTE_ITEM_HARD_MAX = 25;
/** Evidence window: the sibling fleet-evidence convention, in milliseconds because the journal stamps ISO `at`. */
export const SHADOW_ROUTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded tail of the append-only journal — the same 8 MiB bound the shadow report reads. */
export const SHADOW_ROUTE_TAIL_BYTES = SHADOW_POLICY_LEDGER_LIMIT;
/** Future-skew allowance on row timestamps, the sibling folds' convention. */
const SHADOW_ROUTE_FUTURE_SKEW_MS = 300_000;
/** Supported disagreements a (repo, task_class) cell needs before it counts as recurring. */
export const SHADOW_ROUTE_MIN_DISAGREEMENTS = 3;
/** Distinct UTC days the divergence must span — recurring means recorded across days. */
export const SHADOW_ROUTE_MIN_DAYS = 2;
/** Resolved live failures a cell needs before the divergence reads as adverse. */
export const SHADOW_ROUTE_MIN_FAILURES = 2;
/** The fleet's own repository label: journal evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Ledger-recorded strings are unbounded text; flatten, scrub and cap before use. */
const MAX_NAME_CHARS = 60;
/** Distinct UTC days quoted inside one prompt before the rest is summarized. */
const MAX_PROMPT_DAYS = 4;

export interface ShadowRouteItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/route.shadow.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Evidence window in milliseconds (default SHADOW_ROUTE_WINDOW_MS). */
  windowMs?: number;
  /** Journal override (default: <runsDir>/metrics/route.shadow.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default SHADOW_ROUTE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are regex-bounded already; scrub and cap defensively before display. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const sha = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const SUPPORT_STATUSES: ReadonlySet<string> = new Set(['supported', 'insufficient_support', 'no_candidates']);

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Fold — one pass over the journal tail
// ---------------------------------------------------------------------------

/** One supported disagreement awaiting its outcome join. */
interface ShadowDisagreement {
  /** The job id the record carries, or null when the eval recorded none — unjoinable stays unresolved. */
  job: string | null;
}

/** Per-(repo, task_class) supported-divergence evidence inside the window. */
interface ShadowDivergenceCell {
  repo: string;
  task_class: string;
  /** Supported records whose recomputed live_lane !== shadow_lane. */
  disagreements: number;
  /** The disagreed records awaiting/undergoing the outcome join. */
  pending: ShadowDisagreement[];
  days: Set<string>;
  firstMs: number | null;
  lastMs: number | null;
}

export interface ShadowRouteFold {
  /** Valid in-window shadow records (rows that passed the producer contract). */
  records: number;
  /** Retained-tail lines that failed JSON parse or the producer contract. */
  invalidRows: number;
  /** (repo, task_class) cells carrying supported divergence. */
  cells: Map<string, ShadowDivergenceCell>;
}

const cellKey = (repo: string, taskClass: string): string => `${repo}\u0000${taskClass}`;

const isLane = (value: unknown): value is string => typeof value === 'string' && routeIdSchema.safeParse(value).success;

/**
 * Pure: fold one journal tail into per-(repo, task_class) supported-
 * divergence cells. Rows outside the window, malformed JSON, wrong
 * schema/advisory/dispatched envelope, unknown policy names, bad
 * routeId shapes, unsupported support_status values and unparseable
 * `at` stamps are skipped; disagreement is recomputed as
 * live_lane !== shadow_lane exactly like parseShadowRecord — the
 * stored disagreed flag is never trusted — and only 'supported'
 * records with both lanes non-null count as divergence evidence.
 */
export function foldShadowJournal(text: string, nowMs: number, windowMs: number): ShadowRouteFold {
  const fold: ShadowRouteFold = { records: 0, invalidRows: 0, cells: new Map() };
  const since = nowMs - windowMs;
  const until = nowMs + SHADOW_ROUTE_FUTURE_SKEW_MS;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // Cheap prefilter: shadow records are a minority of rows and the
    // pinned writer emits compact JSON, so '"schema":"route.shadow.v1"'
    // is verbatim.
    if (!trimmed.includes(`"schema":"${SHADOW_POLICY_RECORD_SCHEMA}"`)) continue;
    let row: unknown;
    try { row = JSON.parse(trimmed); } catch { fold.invalidRows += 1; continue; }
    if (!isRecord(row) || row['schema'] !== SHADOW_POLICY_RECORD_SCHEMA ||
        row['advisory'] !== true || row['dispatched'] !== false) {
      fold.invalidRows += 1;
      continue;
    }
    const policy = row['policy'];
    const repo = row['repo'];
    const taskClass = row['task_class'];
    const support = row['support_status'];
    const live = row['live_lane'];
    const shadow = row['shadow_lane'];
    const job = row['job'];
    const at = row['at'];
    const lanes = row['eligible_lanes'];
    if (typeof policy !== 'string' || !isShadowPolicyName(policy) ||
        typeof repo !== 'string' || !routeIdSchema.safeParse(repo).success ||
        typeof taskClass !== 'string' || taskClass === '' ||
        typeof support !== 'string' || !SUPPORT_STATUSES.has(support) ||
        (live !== null && !isLane(live)) || (shadow !== null && !isLane(shadow)) ||
        (job !== null && !isLane(job)) ||
        !Array.isArray(lanes) || !lanes.every(isLane) ||
        typeof at !== 'string') {
      fold.invalidRows += 1;
      continue;
    }
    const atMs = Date.parse(at);
    if (!Number.isFinite(atMs) || atMs < 0) {
      fold.invalidRows += 1;
      continue;
    }
    if (atMs < since || atMs > until) continue;
    fold.records += 1;
    // Only a supported record with both lanes resolved can diverge —
    // insufficient_support echoes the live pick and no_candidates has
    // no shadow pick, so neither is routing evidence.
    if (support !== 'supported' || live === null || shadow === null || live === shadow) continue;
    const key = cellKey(repo, taskClass);
    let cell = fold.cells.get(key);
    if (cell === undefined) {
      cell = { repo, task_class: taskClass, disagreements: 0, pending: [], days: new Set(), firstMs: null, lastMs: null };
      fold.cells.set(key, cell);
    }
    cell.disagreements += 1;
    cell.pending.push({ job: typeof job === 'string' ? job : null });
    const day = dayOf(atMs);
    cell.days.add(day);
    cell.firstMs = cell.firstMs === null ? atMs : Math.min(cell.firstMs, atMs);
    cell.lastMs = cell.lastMs === null ? atMs : Math.max(cell.lastMs, atMs);
  }
  return fold;
}

// ---------------------------------------------------------------------------
// Cells — recurring adverse divergence only
// ---------------------------------------------------------------------------

/** The outcome fields the join needs — a structural subset of RouterOutcome. */
export interface ShadowRouteOutcomeRef {
  merged: boolean | null;
  reverted: boolean | null;
  repo: string | null;
}

export interface ShadowRouteCell {
  repo: string;
  task_class: string;
  /** Supported disagreements inside the window. */
  disagreements: number;
  /** Disagreed records whose job resolved to a good or failure outcome. */
  resolved: number;
  /** Resolved outcomes classified failure — reverted:true or merged:false, the report's own rule. */
  failures: number;
  /** Resolved outcomes classified good — merged:true. */
  goods: number;
  /** Disagreed records with no job or no resolved outcome — unknown stays unknown. */
  unresolved: number;
  days: string[];
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

/** The report's own outcome rule: a recorded revert or an explicit unmerged close is failure; merged is good; else unknown. */
const classifyOutcome = (o: ShadowRouteOutcomeRef): 'good' | 'failure' | null => {
  if (o.reverted === true || o.merged === false) return 'failure';
  if (o.merged === true) return 'good';
  return null;
};

/**
 * Pure: the recurring adverse cells the fold justifies. A cell emits
 * only while its supported disagreements reach
 * SHADOW_ROUTE_MIN_DISAGREEMENTS across SHADOW_ROUTE_MIN_DAYS distinct
 * UTC days AND its resolved live outcomes carry at least
 * SHADOW_ROUTE_MIN_FAILURES failures that are at least half of the
 * resolved total — the live lane failing at least as often as it
 * succeeds on exactly the decisions the shadow policy routed
 * differently. `outcomes` is the job-id → outcome map readRouterOutcomes
 * produces; the repo-match guard mirrors buildShadowPolicyReport
 * (a joined outcome with a different recorded repo never counts).
 * Sorted by failures, then disagreements, then repo and task_class —
 * deterministic across refreshes.
 */
export function shadowRouteCells(
  fold: ShadowRouteFold,
  outcomes?: ReadonlyMap<string, ShadowRouteOutcomeRef>,
  lowerBound = false,
): ShadowRouteCell[] {
  const cells: ShadowRouteCell[] = [];
  for (const cell of fold.cells.values()) {
    if (cell.disagreements < SHADOW_ROUTE_MIN_DISAGREEMENTS || cell.days.size < SHADOW_ROUTE_MIN_DAYS) continue;
    let resolved = 0, failures = 0, goods = 0, unresolved = 0;
    for (const pending of cell.pending) {
      const joined = pending.job !== null ? outcomes?.get(pending.job) : undefined;
      const matched = joined !== undefined && (joined.repo === null || joined.repo === cell.repo) ? joined : undefined;
      const verdict = matched === undefined ? null : classifyOutcome(matched);
      if (verdict === 'failure') { resolved += 1; failures += 1; }
      else if (verdict === 'good') { resolved += 1; goods += 1; }
      else unresolved += 1;
    }
    if (failures < SHADOW_ROUTE_MIN_FAILURES || failures * 2 < resolved) continue;
    cells.push({
      repo: cell.repo, task_class: cell.task_class,
      disagreements: cell.disagreements, resolved, failures, goods, unresolved,
      days: [...cell.days].sort(),
      firstSeen: isoOrNull(cell.firstMs), lastSeen: isoOrNull(cell.lastMs),
      lowerBound,
    });
  }
  return cells.sort((a, b) => b.failures - a.failures || b.disagreements - a.disagreements
    || a.repo.localeCompare(b.repo) || a.task_class.localeCompare(b.task_class));
}

// ---------------------------------------------------------------------------
// Item builders
// ---------------------------------------------------------------------------

const EVIDENCE = 'The evidence is metrics/route.shadow.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): `phm route shadow eval --record` appends one advisory route.shadow.v1 record per evaluation through recordShadowPolicyDecision (src/core/router/shadow-policy.ts) — the request\'s repo/task_class/tier_hint, the eligible lane set, the live router\'s pick, the class-failure-avoidance policy\'s pick, the support verdict and the per-lane outcome stats it ranked on — always dispatched:false, never touching live routing. The journal\'s only readers were buildShadowPolicyReport (`phm route shadow report --json`) and the shadow_comparison inside `phm route explain --json` — reports someone had to run — so recurring divergence never became work.';

const NO_CHANGE = 'If the window has rolled forward, the divergence was a one-off experiment burst, the resolved failures trace to causes outside lane choice (a bad prompt, a flaky suite, an owner-side outage), the shadow policy\'s premise no longer holds (the failure-avoidance signal was fixed or removed), or this checkout is not the fleet repository the journal describes — report no-change and name the evidence.';

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : 'unknown';

const cellDays = (cell: ShadowRouteCell): string =>
  `across ${cell.days.length} UTC day(s) (${daysText(cell.days)})`;

function shadowPrompt(cell: ShadowRouteCell): string {
  const repo = fieldText(cell.repo, MAX_NAME_CHARS);
  const taskClass = fieldText(cell.task_class, MAX_NAME_CHARS);
  const failureShare = pct(cell.failures, cell.resolved);
  return [
    `Phantom's route shadow journal records recurring divergence between the live router and the class-failure-avoidance shadow policy for ${repo}/${taskClass} — ${cell.disagreements} supported disagreements inside the 7-day window ${cellDays(cell)}, where the shadow policy picked a different lane than the lane the live router actually chose and the job ran.`,
    '',
    `On the resolved subset the live lane is failing: ${cell.failures} of ${cell.resolved} resolved disagreed picks ended reverted or closed-unmerged (${failureShare}), against ${cell.goods} that merged${cell.unresolved > 0 ? `, with ${cell.unresolved} still unresolved` : ''}. The shadow pick's own outcome is counterfactual — it was never dispatched — so the evidence shows the live router's choice failing, not that the alternative would have won; what it does show is that the live router keeps choosing lanes the per-(repo, task_class, lane) outcome evidence says fail, which is exactly the signal the shadow policy exists to surface.`,
    '',
    `First recorded ${cell.firstSeen ?? 'unknown'}, last ${cell.lastSeen ?? 'unknown'}.${boundNote(cell.lowerBound)}`,
    '',
    EVIDENCE,
    '',
    `Investigate why live routing does not already avoid these lanes for this class: the decision path lives in src/core/routing/ (decision*.ts, catalog and admission) and src/core/router/ (outcomes.ts joins, weight-proposals.ts advisory weights, shadow-policy.ts itself). Check whether the failing lanes' outcomes reach the live scorer for this task_class — work_class joins come from jobs.jsonl rows and work-market route_decision rows, lane eligibility and hysteresis may exclude the evidence, and weight-proposals stays advisory with no apply path. If the outcome evidence itself is wrong (misjoined jobs, a repo-match guard dropping rows, a work_class that never populates), fix the join; if the live scorer genuinely ignores available failure evidence, propose the smallest routing change the evidence supports. ${NO_CHANGE}`,
  ].join('\n');
}

function shadowItem(cell: ShadowRouteCell, repo: string): CloudBacklogItem {
  const identity = `${cell.repo}:${cell.task_class}`;
  return {
    id: `shadow-route-${sha(identity)}`,
    title: `Live router keeps failing on ${cell.repo}/${cell.task_class} where shadow policy disagrees`.slice(0, MAX_TITLE_CHARS),
    prompt: shadowPrompt(cell),
    area: 'route-shadow',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the route shadow journal's recurring adverse
 * divergence. Total: a missing journal, another repository, a quiet
 * journal (no cell past the disagreement/day bars — the outcome read
 * is skipped entirely) or any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function shadowRouteBacklogItems(opts: ShadowRouteItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence runsRoot() applies: an absolute ASHLR_RUNS_DIR wins,
    // then ~/.ashlr-runs.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = opts.windowMs ?? SHADOW_ROUTE_WINDOW_MS;
    const path = opts.journalPath ?? join(runsDir, SHADOW_POLICY_LEDGER_RELATIVE);
    const tail = await readLedgerTail(path, SHADOW_ROUTE_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const fold = foldShadowJournal(tail.text, nowMs, windowMs);
    if (fold.cells.size === 0) return [];
    // Cheap gate before the heavy outcome read: at least one cell must
    // already be recurring on disagreements and days alone; the
    // resolved-failure bar is applied after the join.
    const recurring = [...fold.cells.values()]
      .some((c) => c.disagreements >= SHADOW_ROUTE_MIN_DISAGREEMENTS && c.days.size >= SHADOW_ROUTE_MIN_DAYS);
    if (!recurring) return [];
    const outcomesRead = await readRouterOutcomes({ runsDir });
    const outcomeMap = new Map<string, ShadowRouteOutcomeRef>(
      outcomesRead.outcomes.map((o) => [o.job_id, { merged: o.merged, reverted: o.reverted, repo: o.repo }]),
    );
    const cells = shadowRouteCells(fold, outcomeMap, tail.truncated);
    const limit = Math.max(1, Math.min(opts.limit ?? SHADOW_ROUTE_MAX_ITEMS, SHADOW_ROUTE_ITEM_HARD_MAX));
    return cells.slice(0, limit).map((cell) => shadowItem(cell, repo));
  } catch {
    return [];
  }
}
