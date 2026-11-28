/**
 * Self-awareness loop diagnosis → self-improvement backlog items.
 *
 * `phm metrics loop` (src/cli/metrics-loop.ts, listed under the daily
 * checks in docs/AGENT-OPERATIONS.md) folds the fleet's own telemetry —
 * the jobs ledger, queue slots/status/ready, the cost ledger, GitHub
 * merges and releases, the installed bundle's Info.plist and the node
 * inventory — into one metrics.loop.v1 report per run
 * (src/core/metrics/loop-collect.ts writeLoop). Each run persists three
 * artifacts under <runs>/metrics/:
 *
 *   - loop-YYYYMMDD.json: the full LoopReport for that local day —
 *     throughput, idea-to-merged / merged-to-installed / feedback-loop
 *     distributions, per-lane and per-node rows, and the sources map;
 *   - selection-hints.json: the compact metrics.selection-hints.v1
 *     advisory — lanes ranked by merged-per-lane-hour, nodes with
 *     spare, bets share, the loop_wait stage summary, and
 *     top_constraint, the report's named binding constraint with its
 *     evidence sentence (topConstraint in src/core/metrics/loop.ts);
 *   - bets-share.json: the reserved/usable bet-slot split.
 *
 * Until now the diagnosis reached exactly one surface: `phm ideas
 * list` reads selection-hints.json through bottleneck-ideas.ts and
 * ranks a loop-constraint / loop-wait idea for a human to click
 * "queue it" on. The improvement backlog — the queue autonomous
 * self-improvement sessions actually launch from — never saw it, so
 * the loop's own verdict about where the fleet is stuck stayed
 * advisory-only: a binding constraint that persisted for days, or a
 * pipeline stage whose median wait stayed over an hour, produced no
 * work until someone read the Ideas pane and queued it by hand.
 *
 * loopHintsBacklogItems carries both signals into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue them
 * exactly like the sibling evidence feeds beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The metrics dir is listed and each candidate report is
 *    read through readSource's bounded no-follow read; nothing is
 *    written and no gh call, probe or lock is touched. A missing or
 *    unreadable metrics dir yields no items — a host that never ran
 *    the loop and a healthy one look identical to an absent series,
 *    and both correctly emit nothing.
 *  - Reports count only under the writer's contract: schema
 *    'metrics.loop.v1', a parseable `at`, and every field
 *    topConstraint reads in its measured-or-missing shape —
 *    throughput with finite merged_6h/opened_6h, the two loop-time
 *    distributions with finite p50s, and capacity_per_node rows whose
 *    spare is a finite number or a {missing} marker. A malformed
 *    report is dropped, never guessed; a report whose constraint
 *    computes to 'unknown' is a valid read but carries no diagnosis,
 *    so it can neither recur nor be current.
 *  - Recurring means recorded across days. The constraint item emits
 *    only when the NEWEST in-window report's actionable constraint
 *    name also appears on at least LOOP_CONSTRAINT_MIN_DAYS distinct
 *    report filenames (the writer's own local-day bucketing) inside
 *    LOOP_REPORT_WINDOW_MS — one bad 6-hour window never queues a
 *    session, and a constraint the newest report no longer names has
 *    resolved and emits nothing.
 *  - Fresh means current. The newest in-window report must be no older
 *    than LOOP_REPORT_MAX_AGE_MS — the same 72-hour bound
 *    bottleneck-ideas applies to selection-hints.json, since a loop
 *    report is a snapshot of trailing windows and stops describing the
 *    fleet once the loop stops running. The hints file is validated by
 *    the Ideas list's own parseSelectionHints, which enforces the same
 *    freshness and future-skew bounds plus the schema and advisory
 *    flags.
 *  - The stage item keeps the Ideas list's own bar: loop_wait.slowest
 *    at p50 >= LOOP_HINTS_MIN_STAGE_P50_MINUTES on a fresh hints
 *    report. The p50 is already a median across every job finished in
 *    the report's window — recurrence is intrinsic to the statistic,
 *    and jobs_truncated is quoted so a cut ledger tail is stated, not
 *    hidden.
 *  - Fleet machinery only. The reports describe this install's loop —
 *    they carry no repository column — so items emit only when the
 *    backlog target's repository name is 'phantom', the same
 *    last-segment rule the sibling feeds apply.
 *  - Dedup is downstream. Item ids key on the cell — the constraint
 *    name or the stage id — never the counts or timestamps, so a
 *    refresh re-derives the same ids and appendUserBacklogItems adds
 *    only what is new; a resolved constraint or a faster stage simply
 *    stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, report evidence sentences are scrubbed,
 *    flattened and capped, and each brief carries the usual no-change
 *    escape for host-side causes this repository does not own.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  LOOP_HINTS_MIN_STAGE_P50_MINUTES,
  parseSelectionHints,
} from '../fleet/bottleneck-ideas.js';
import { readSource } from '../fleet/runs-parked-queue.js';
import {
  isMissing,
  isPlainRecord,
  LOOP_SCHEMA,
  missing,
  topConstraint,
  type LoopReport,
  type Missing,
  type NodeCapacityRow,
} from '../metrics/loop.js';
import { minutesText, STAGE_NAMES, stageWords, type StageName } from '../metrics/loop-stages.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the evidence yields at most one constraint and one stage item. */
export const LOOP_HINTS_BACKLOG_MAX_ITEMS = 4;
const LOOP_HINTS_ITEM_HARD_MAX = 25;
/**
 * Evidence window for the report series: 14 days. `phm metrics loop` is a
 * daily check, so two weeks holds roughly two scheduled observations per
 * side of the recurrence bar — long enough to prove a constraint is not a
 * one-off window, short enough that resolved history cannot pile up.
 */
export const LOOP_REPORT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/**
 * Freshness bound on the newest report and (through parseSelectionHints)
 * the hints file: 72 hours, the same staleness bound bottleneck-ideas
 * applies — older than this the loop's snapshot no longer describes the
 * fleet.
 */
export const LOOP_REPORT_MAX_AGE_MS = 72 * 60 * 60 * 1000;
/** Distinct report days (filename buckets) a constraint needs before it counts as recurring. */
export const LOOP_CONSTRAINT_MIN_DAYS = 2;
/** Future-skew tolerance on report timestamps, the sibling feeds' one-minute convention. */
const LOOP_REPORT_FUTURE_SKEW_MS = 60_000;
/** Newest report files opened per call; daily cadence makes 16 ≈ over two weeks of history. */
const LOOP_REPORT_MAX_FILES = 16;
/** Per-report read bound; a LoopReport with per-lane and per-node rows stays far below this. */
const LOOP_REPORT_MAX_BYTES = 512 * 1024;
/** selection-hints.json read bound, mirrored from bottleneck-ideas' LOOP_HINTS_MAX_BYTES. */
const LOOP_HINTS_MAX_BYTES = 256 * 1024;
/** The writer's filename: loop-<local YYYYMMDD>.json, zero-padded so lexical order is chronological. */
const REPORT_FILE_PATTERN = /^loop-(\d{8})\.json$/;
/** Constraint names topConstraint can return that name an actionable in-repo diagnosis — 'unknown' carries none. */
const ACTIONABLE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'merge', 'supply', 'capacity', 'measurement', 'install', 'idea-to-merge',
]);
/** Stage ids are writer vocabulary but treated as untrusted text: only this shape reaches an id. */
const SAFE_STAGE_ID = /^[a-z0-9_]{1,60}$/;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-produced strings are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 200;
/** The fleet's own repository label: loop evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface LoopHintsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/; default $ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LOOP_HINTS_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window and freshness bounds (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const finiteNonNeg = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** One validated report: its stamp and the binding constraint topConstraint computes from it. */
export interface LoopConstraintReport {
  atMs: number;
  name: string;
  evidence: string;
}

/**
 * Pure: validate one parsed metrics.loop.v1 document down to the fields
 * topConstraint reads, then recompute its constraint verdict. Returns
 * null for foreign shapes and malformed measured fields — a report the
 * fold cannot trust is dropped, never guessed. The 'unknown' verdict is
 * returned like any other: it is a valid read carrying no diagnosis.
 */
export function parseLoopReport(value: unknown): LoopConstraintReport | null {
  if (!isPlainRecord(value)) return null;
  if (value['schema'] !== LOOP_SCHEMA) return null;
  const at = value['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : NaN;
  if (!Number.isFinite(atMs)) return null;

  const throughput = value['throughput'];
  const ideaToMerged = value['idea_to_merged_minutes'];
  const mergedToInstalled = value['merged_to_installed_minutes'];
  const capacity = value['capacity_per_node'];
  if (!isMissing(throughput)) {
    if (!isPlainRecord(throughput) || !finiteNonNeg(throughput['merged_6h']) || !finiteNonNeg(throughput['opened_6h'])) return null;
  }
  if (!isMissing(ideaToMerged)) {
    if (!isPlainRecord(ideaToMerged) || !finiteNonNeg(ideaToMerged['p50'])) return null;
  }
  if (!isMissing(mergedToInstalled)) {
    if (!isPlainRecord(mergedToInstalled)) return null;
    const distribution = mergedToInstalled['distribution'];
    if (distribution !== null && distribution !== undefined
      && (!isPlainRecord(distribution) || !finiteNonNeg(distribution['p50']))) return null;
  }
  if (!Array.isArray(capacity)) return null;
  const rows: NodeCapacityRow[] = [];
  for (const row of capacity) {
    if (!isPlainRecord(row)) return null;
    const spare = row['spare'];
    if (!isMissing(spare) && !finiteNonNeg(spare)) return null;
    // Only `spare` reaches topConstraint (via loopMetricValue 'spare_slots');
    // the rest of the row is carried for shape, never read.
    rows.push({
      node: typeof row['node'] === 'string' ? row['node'] : '',
      source: 'local',
      status: '',
      max: missing('not read by the constraint fold'),
      live: missing('not read by the constraint fold'),
      spare: spare as number | Missing,
    });
  }

  const report: LoopReport = {
    schema: LOOP_SCHEMA,
    at: at as string,
    sources: {},
    truncated_sources: [],
    throughput: throughput as LoopReport['throughput'],
    idea_to_merged_minutes: ideaToMerged as LoopReport['idea_to_merged_minutes'],
    merged_to_installed_minutes: mergedToInstalled as LoopReport['merged_to_installed_minutes'],
    feedback_loop_minutes: missing('not read by the constraint fold'),
    cost_per_merged_pr: missing('not read by the constraint fold'),
    lanes: [],
    capacity_per_node: rows,
    resources: [],
    bets: missing('not read by the constraint fold'),
  };
  const constraint = topConstraint(report);
  return { atMs, name: constraint.name, evidence: constraint.evidence };
}

/** One report's contribution to the recurrence fold: filename day plus the parsed verdict. */
export interface LoopConstraintEvidence {
  /** The writer's local-day bucket, loop-YYYYMMDD — distinct filenames are distinct run days. */
  dayKey: string;
  atMs: number;
  name: string;
  evidence: string;
}

/** The single constraint cell: the recurring verdict plus the coverage the prompt quotes. */
export interface LoopConstraintCell {
  name: string;
  /** The newest in-window report's own evidence sentence. */
  evidence: string;
  /** In-window reports whose constraint verdict equals the cell's name. */
  reports: number;
  /** Distinct report days those reports fall on. */
  days: number;
  firstDay: string;
  lastDay: string;
  /** ISO stamp of the newest contributing report. */
  newestAt: string;
}

/**
 * Pure: fold validated in-window reports (any order) into the recurring
 * constraint cell. A cell emits only when the NEWEST in-window report's
 * constraint is actionable and the same name appears on at least
 * LOOP_CONSTRAINT_MIN_DAYS distinct dayKeys — recurrence across days,
 * still current. Returns null below the bars or when the newest verdict
 * is 'unknown' (no diagnosis to act on).
 */
export function foldLoopConstraints(
  input: readonly LoopConstraintEvidence[],
  opts: { nowMs: number; windowMs?: number; maxAgeMs?: number },
): LoopConstraintCell | null {
  const windowMs = opts.windowMs ?? LOOP_REPORT_WINDOW_MS;
  const maxAgeMs = opts.maxAgeMs ?? LOOP_REPORT_MAX_AGE_MS;
  const sinceMs = opts.nowMs - windowMs;
  const freshFloorMs = opts.nowMs - maxAgeMs;
  const untilMs = opts.nowMs + LOOP_REPORT_FUTURE_SKEW_MS;
  const reports = input
    .filter((r) => r.atMs <= untilMs && r.atMs > sinceMs)
    .sort((a, b) => a.atMs - b.atMs || a.dayKey.localeCompare(b.dayKey));
  if (reports.length === 0) return null;
  const newest = reports[reports.length - 1]!;
  if (newest.atMs < freshFloorMs) return null;
  if (!ACTIONABLE_CONSTRAINTS.has(newest.name)) return null;
  const matching = reports.filter((r) => r.name === newest.name);
  const days = new Set(matching.map((r) => r.dayKey));
  if (days.size < LOOP_CONSTRAINT_MIN_DAYS) return null;
  return {
    name: newest.name,
    evidence: newest.evidence,
    reports: matching.length,
    days: days.size,
    firstDay: matching[0]!.dayKey,
    lastDay: matching[matching.length - 1]!.dayKey,
    newestAt: new Date(newest.atMs).toISOString(),
  };
}

/** Journal-produced strings are untrusted text; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** Per-constraint pointers at the in-repo machinery the verdict measures; quoted inside the prompt. */
const CONSTRAINT_HINTS: Record<string, string> = {
  merge: 'the merge path — merge-queue waits, required-check conclusions and review latency recorded in metrics/merge-events.jsonl and the jobs ledger\'s outcome rows',
  supply: 'queue supply and admission — why producers mint too little runnable work (queue/ready.tsv depth, admission holds, upstream planning)',
  capacity: 'slot accounting — which lanes and nodes report zero spare and what holds their slots (queue/slots.json targets and holds, node heartbeats)',
  measurement: 'the metrics/jobs.jsonl read path every loop metric folds — a ledger the loop cannot read makes every verdict unknown',
  install: 'the release/install drain — merges reaching master faster than the installed bundle (release cadence and install markers)',
  'idea-to-merge': 'the stage boundaries `phm metrics loop --json` reports — find the largest p50 wait and the ledger rows that stamp it',
};

const EVIDENCE = 'The evidence is metrics/loop-YYYYMMDD.json under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), one metrics.loop.v1 report per `phm metrics loop` run (src/core/metrics/loop-collect.ts writeLoop) whose top_constraint verdict is recomputed per report by topConstraint in src/core/metrics/loop.ts; the sibling metrics/selection-hints.json carries the same run\'s compact advisory (schema metrics.selection-hints.v1) read through parseSelectionHints in src/core/fleet/bottleneck-ideas.ts — the only other reader of either file is `phm ideas list`\'s bottleneck ranking.';

const NO_CHANGE = 'If the window has rolled forward, the newest report names a different constraint or none, the recurring verdict was correct measurements of a transient window, the cause is host- or GitHub-side state this repository does not own (runner capacity, credentials, merge-queue rules, a sleeping Mac, pinned contrib/mac machinery), or the constraint already has an open fix — report no-change and name the evidence.';

function loopConstraintPrompt(cell: LoopConstraintCell): string {
  const evidence = fieldText(cell.evidence);
  const hint = CONSTRAINT_HINTS[cell.name] ?? 'the machinery its evidence sentence names';
  return [
    `The self-awareness loop keeps naming '${cell.name}' as the fleet's binding constraint — the self-improvement work this backlog exists for.`,
    '',
    `topConstraint (src/core/metrics/loop.ts) computed '${cell.name}' on ${cell.days} distinct days across ${cell.reports} in-window daily reports (${cell.firstDay} through ${cell.lastDay}, newest ${cell.newestAt}), and the newest report still names it. Its own evidence sentence: "${evidence === '' ? 'the report carried no evidence sentence' : evidence}".`,
    '',
    `Each report is a snapshot of trailing windows — throughput and loop times folded from metrics/jobs.jsonl, spare slots across queue/slots.json lanes and the node inventory, merge-to-install timing against GitHub releases and the installed Info.plist — so the constraint is measured, not anecdotal. Look at ${hint}, and at what changed between the first and newest reports (per-lane merged_per_lane_hour and capacity_per_node rows in the same files) before changing anything.`,
    '',
    EVIDENCE,
    '',
    `Fix what lives in this repository's loop machinery — the producers and consumers of the measured signal — not the measurement itself: ` + NO_CHANGE,
  ].join('\n');
}

function loopConstraintItem(cell: LoopConstraintCell, repo: string): CloudBacklogItem {
  const title = `Self-awareness loop keeps naming '${cell.name}' its binding constraint`;
  return {
    id: `loop-constraint-${cell.name}`,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: loopConstraintPrompt(cell),
    area: 'loop-hints',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function loopStageLabel(stage: string): string {
  return (STAGE_NAMES as readonly string[]).includes(stage) ? stageWords(stage as StageName) : stage;
}

function loopWaitPrompt(stage: string, p50Minutes: number, since: string | null, jobsTruncated: boolean | null, hintsAgeHours: number): string {
  const label = loopStageLabel(stage);
  return [
    `The self-awareness loop measures '${label}' as the fleet pipeline's slowest stage — the self-improvement work this backlog exists for.`,
    '',
    `loop_wait.slowest in metrics/selection-hints.json (written by \`phm metrics loop\`, ${hintsAgeHours}h old at read time) records p50 ${minutesText(p50Minutes)}${since === null ? '' : ` over jobs finished since ${fieldText(since)}`} — a median across every job finished in the report's window, so the wait is measured, not anecdotal.${jobsTruncated === true ? ' The jobs.jsonl tail was cut at the read cap, so the stage times cover only the newest bytes.' : jobsTruncated === false ? '' : ' The report did not say whether the jobs.jsonl tail was cut.'}`,
    '',
    `Profile that stage's ledger boundaries — the timestamps buildLoopStages (src/core/metrics/loop-stages.ts) joins per finished job: enqueue/launch/finish rows in the jobs ledger dialect, publish/opened and merged/closed outcome rows, and the release tag time for merged-to-released — and remove the largest wait. ` + EVIDENCE,
    '',
    NO_CHANGE,
  ].join('\n');
}

function loopWaitItem(stage: string, p50Minutes: number, since: string | null, jobsTruncated: boolean | null, hintsAgeHours: number, repo: string): CloudBacklogItem {
  const title = `Self-awareness loop's slowest stage is ${loopStageLabel(stage)} (p50 ${minutesText(p50Minutes)})`;
  const id = `loop-wait-${stage.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'unknown'}`;
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt: loopWaitPrompt(stage, p50Minutes, since, jobsTruncated, hintsAgeHours),
    area: 'loop-hints',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the self-awareness loop's recurring binding
 * constraint and slowest pipeline stage. Total: a missing or
 * unreadable metrics dir, off-contract reports, another repository,
 * or any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function loopHintsBacklogItems(opts: LoopHintsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const metricsDir = join(runsDir, 'metrics');
    const nowMs = (opts.now ?? new Date()).getTime();

    const names = await readdir(metricsDir).catch(() => null);
    if (names === null) return [];
    const reportNames = names
      .map((name) => ({ name, match: REPORT_FILE_PATTERN.exec(name) }))
      .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
      .sort((a, b) => b.name.localeCompare(a.name))
      .slice(0, LOOP_REPORT_MAX_FILES);

    const evidence: LoopConstraintEvidence[] = [];
    for (const { name, match } of reportNames) {
      const read = await readSource(join(metricsDir, name), LOOP_REPORT_MAX_BYTES, false);
      if (read.state !== 'healthy') continue;
      let parsed: unknown;
      try { parsed = JSON.parse(read.text); } catch { continue; }
      const report = parseLoopReport(parsed);
      if (report === null) continue;
      evidence.push({ dayKey: match[1]!, atMs: report.atMs, name: report.name, evidence: report.evidence });
    }
    const cell = foldLoopConstraints(evidence, { nowMs });

    const items: CloudBacklogItem[] = [];
    if (cell !== null) items.push(loopConstraintItem(cell, repo));

    const hintsRead = await readSource(join(metricsDir, 'selection-hints.json'), LOOP_HINTS_MAX_BYTES, false);
    if (hintsRead.state === 'healthy') {
      const hints = parseSelectionHints(hintsRead.text, nowMs);
      if (hints.ok && hints.data.slowest !== null
        && hints.data.slowest.p50Minutes >= LOOP_HINTS_MIN_STAGE_P50_MINUTES
        && SAFE_STAGE_ID.test(hints.data.slowest.stage)) {
        items.push(loopWaitItem(
          hints.data.slowest.stage,
          hints.data.slowest.p50Minutes,
          hints.data.since,
          hints.data.jobsTruncated,
          hints.data.ageHours,
          repo,
        ));
      }
    }

    const limit = Math.max(1, Math.min(opts.limit ?? LOOP_HINTS_BACKLOG_MAX_ITEMS, LOOP_HINTS_ITEM_HARD_MAX));
    return items.slice(0, limit);
  } catch {
    return [];
  }
}
