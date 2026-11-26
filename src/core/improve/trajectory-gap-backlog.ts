/**
 * Trajectory evidence-capture degradation → self-improvement backlog items.
 *
 * Phantom's trajectory join (`listTrajectoryRecords` +
 * `summarizeTrajectoryLearning`, the fold behind `trajectoryLearning` in
 * `phm fleet status --json`) reconstructs each dispatch-rooted trajectory
 * from the fleet's own ledgers — dispatch production events, outcome
 * records, agent actions, the decision ledger, autonomy evidence, the
 * worked ledger, post-merge records and the skill-use ledger — and
 * publishes, per window, which evidence dimensions joined and which did
 * not. That projection is the spine every downstream learning signal
 * stands on: skill-outcome attribution, the router's trajectory evidence
 * and the learning-metrics availability report all read the same join.
 * Until now its degradation diagnostics only ever reached
 * `phm fleet status`, a report someone had to run and read: trajectories
 * excluded from learning eligibility by degraded source evidence,
 * eligible trajectories systematically missing an evidence dimension,
 * and skill-use events that could not resolve to any trajectory record
 * all looked like quiet tallies, never work — even though a broken join
 * silently starves every consumer of the projection.
 *
 * trajectoryGapBacklogItems carries the same bounded projection into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling trajectory-skill-outcome
 * source beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The projection is computed by the same bounded,
 *    never-throwing reads `phm fleet status` performs —
 *    listTrajectoryRecords over the windowed ledger tails plus the pure
 *    summarizeTrajectoryLearning fold. Nothing is written and no network
 *    is touched; a read failure degrades the affected source quality
 *    inside the projection rather than throwing here.
 *  - Eligibility accounting only. population.degraded counts observed
 *    trajectories whose decision-source quality read degraded — the
 *    outcome record's own recorded source state, not a guess. The fold
 *    emits only at TRAJECTORY_GAP_DEGRADED_MIN, the fleet's recurring
 *    bar, so one corrupt partition never queues a session. population
 *    .incomplete is deliberately not a cell: trajectories that never
 *    reached a proposal are ordinary funnel attrition, not capture
 *    failure.
 *  - Coverage gaps on eligible trajectories only. status.gaps counts,
 *    per evidence dimension, learning-eligible trajectories (complete
 *    dispatch+proposal+decision-source records) that still lack that
 *    dimension's join — dispatch and proposal gaps cannot appear because
 *    eligibility requires them, so the cells are evidence, decision and
 *    agentAction by construction. A cell emits only when its gap count
 *    reaches TRAJECTORY_GAP_KIND_MIN absolute AND covers at least half
 *    of the learning-eligible population — majority-missing is the
 *    systematic-join signature; scattered attrition stays quiet.
 *  - Skill-join starvation only. skillObservation.unjoined/conflicting
 *    count skill-use events whose trajectory/run/proposal aliases
 *    resolved to zero or several trajectory records inside the bounded
 *    cohort — never to "no skill use". A cell emits only when the
 *    projection saw skill-use events at all (eventState 'present'), the
 *    failed+conflicting count reaches TRAJECTORY_GAP_SKILL_MIN_EVENTS,
 *    and failures at least equal joins — half or more of the recorded
 *    telemetry failing to resolve is the starvation signature. The
 *    prompt keeps the bounded-cohort caveat: events for trajectories
 *    beyond the record cap legitimately cannot join, so the item asks
 *    the fleet to check the alias contract rather than asserting
 *    breakage.
 *  - Fleet machinery only. The trajectory projection describes this
 *    fleet's own ledgers, so items emit only for the fleet's own
 *    repository ('phantom' last-segment match, the same rule the
 *    skill-outcome and post-merge feeds apply).
 *  - Dedup is downstream. The item id hashes only the cell identity
 *    (degraded population, one evidence kind, or the skill-join cell —
 *    never the counts or timestamps), so a refresh re-derives the same
 *    id and appendUserBacklogItems adds only what is new.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, window and cohort sizes are named, the brief
 *    names the projection, the ledgers and the report command with the
 *    usual no-change escape.
 */
import { createHash } from 'node:crypto';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  listTrajectoryRecords,
  summarizeTrajectoryLearning,
  type TrajectoryLearningStatus,
} from '../autonomy/trajectory-records.js';
import { scrubSecrets } from '../util/scrub.js';

/** Projection window: seven days, the same recurrence window the sibling trajectory feed uses. */
export const TRAJECTORY_GAP_WINDOW_HOURS = 24 * 7;
/** Trajectory cohort cap — the same 500 `phm fleet status` folds. */
export const TRAJECTORY_GAP_RECORD_LIMIT = 500;
/** Items one call may emit; the cell set is bounded but unbounded in principle. */
export const TRAJECTORY_GAP_MAX_ITEMS = 8;
const TRAJECTORY_GAP_ITEM_HARD_MAX = 25;
/**
 * Degraded-source trajectories needed before the population cell emits —
 * the fleet's recurring bar applied to excluded learning evidence.
 */
export const TRAJECTORY_GAP_DEGRADED_MIN = 8;
/**
 * Missing-join trajectories needed before one evidence-dimension cell
 * emits, and the share of the learning-eligible population that must be
 * missing it — absolute recurrence plus a majority-rate signature.
 */
export const TRAJECTORY_GAP_KIND_MIN = 8;
export const TRAJECTORY_GAP_KIND_RATE = 0.5;
/**
 * Failed skill-use joins needed before the skill-join cell emits, and the
 * bar is failures at least equaling joins — half or more of the recorded
 * telemetry failing to resolve is the starvation signature.
 */
export const TRAJECTORY_GAP_SKILL_MIN_EVENTS = 12;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: trajectory evidence is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';

export interface TrajectoryGapItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Projection window in hours (default TRAJECTORY_GAP_WINDOW_HOURS). */
  windowHours?: number;
  /** Trajectory cohort cap for the real read (default TRAJECTORY_GAP_RECORD_LIMIT). */
  recordLimit?: number;
  /** Most items one call emits (default TRAJECTORY_GAP_MAX_ITEMS, hard-capped). */
  limit?: number;
  /**
   * Injected projection (tests); skips the trajectory read when set. Same
   * contract as summarizeTrajectoryLearning's output: an explicit null
   * means the evidence is withheld, never zero-filled tallies.
   */
  summary?: TrajectoryLearningStatus | null;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = 96): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/** What each coverage dimension's join reads, for prompt framing. */
const KIND_SOURCE: Record<string, string> = {
  dispatch: 'the dispatch production-events ledger',
  proposal: 'the proposal/outcome records',
  evidence: 'the autonomy-evidence ledger',
  decision: 'the decision ledger (jev/decisions)',
  agentAction: 'the agent-action ledger',
  skillUse: 'the skill-use ledger (~/.ashlr/skills/uses)',
};

const NO_CHANGE = 'If the window has rolled forward, the counts trace to a bounded-cohort edge (events for trajectories beyond the record cap legitimately cannot join) or deliberate operator state — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is the trajectory-learning projection (`trajectoryLearning.population`, `.coverage`, `.gaps` and `.skillObservation` in `phm fleet status --json`), computed by listTrajectoryRecords + summarizeTrajectoryLearning (src/core/autonomy/trajectory-records.ts) over the bounded windowed tails of the dispatch production-events, outcome, agent-action, decision, autonomy-evidence, worked, post-merge and skill-use ledgers; `phm skills list --outcomes --json` reads the same join for its per-skill tallies.';

interface Cell {
  key: string;
  title: string;
  prompt: string;
}

function degradedCell(summary: TrajectoryLearningStatus): Cell | null {
  const degraded = summary.population?.degraded ?? 0;
  const observed = summary.population?.observed ?? 0;
  if (degraded < TRAJECTORY_GAP_DEGRADED_MIN) return null;
  return {
    key: 'degraded',
    title: `Trajectory learning excludes ${degraded} degraded-evidence ${degraded === 1 ? 'trajectory' : 'trajectories'}`,
    prompt: [
      `Phantom's trajectory join excluded ${degraded} of ${observed} observed dispatch-rooted ${observed === 1 ? 'trajectory' : 'trajectories'} from learning eligibility because their recorded decision-source quality read degraded — the outcome record's own source-state verdict, not a guess — so their terminal and realized outcomes never reach skill-outcome attribution, router trajectory evidence or the learning-metrics report.`,
      '',
      `${EVIDENCE}`,
      '',
      'Find out why the decision-source reads degraded: check the decision ledger partitions the outcome records cite (jev/decisions dated jsonl under the Ashlr home), whether a partition is truncated, corrupt or was written by an older schema the reader now rejects, and whether the degradation is one bad file or a writer that stopped recording complete reads. Fix the capture or the reader in this repository\'s src/. ' + NO_CHANGE,
    ].join('\n'),
  };
}

function gapCells(summary: TrajectoryLearningStatus): Cell[] {
  const eligible = summary.population?.learningEligible ?? 0;
  if (eligible <= 0) return [];
  const cells: Cell[] = [];
  for (const gap of summary.gaps ?? []) {
    const kind = fieldText(String(gap.kind), 40);
    // Absolute recurrence plus a majority-rate signature: scattered
    // funnel attrition stays quiet, a systematic join failure does not.
    if (gap.count < TRAJECTORY_GAP_KIND_MIN || gap.count < eligible * TRAJECTORY_GAP_KIND_RATE) continue;
    const source = KIND_SOURCE[kind] ?? 'the joined ledger';
    cells.push({
      key: `coverage:${kind}`,
      title: `Trajectory join misses ${kind} evidence on ${gap.count} of ${eligible} eligible trajectories`,
      prompt: [
        `Phantom's trajectory join found ${gap.count} of ${eligible} learning-eligible dispatch-rooted trajectories inside the ${summary.windowHours ?? TRAJECTORY_GAP_WINDOW_HOURS}-hour window carry no ${kind} coverage — dispatch and proposal joins are guaranteed by eligibility, so this dimension's own ledger stopped joining for a majority of otherwise-complete trajectories.`,
        '',
        `${EVIDENCE} The missing dimension reads ${source}.`,
        '',
        `Find out why ${kind} evidence stopped joining: check whether ${source} stopped recording for these trajectories, whether its join keys (trajectory/run/proposal/attempt ids) drifted from what the trajectory records carry, or whether the bounded window read is truncating the ledger. Fix the capture or the join in this repository's src/. ` + NO_CHANGE,
      ].join('\n'),
    });
  }
  return cells;
}

function skillJoinCell(summary: TrajectoryLearningStatus): Cell | null {
  const obs = summary.skillObservation;
  if (!obs || obs.eventState !== 'present') return null;
  const joined = obs.joined ?? 0;
  const failed = (obs.unjoined ?? 0) + (obs.conflicting ?? 0);
  if (failed < TRAJECTORY_GAP_SKILL_MIN_EVENTS || failed < joined) return null;
  return {
    key: 'skill-join',
    title: `Skill-use telemetry fails to join trajectory records (${failed} events)`,
    prompt: [
      `Phantom's trajectory join could not resolve ${failed} of ${failed + joined} recorded skill-use events to a trajectory record inside the ${summary.windowHours ?? TRAJECTORY_GAP_WINDOW_HOURS}-hour cohort — unjoined ${obs.unjoined ?? 0}, conflicting ${obs.conflicting ?? 0} — so shadow skill selections are starving the per-skill outcome tallies the whole learned-skill loop reads.`,
      '',
      `${EVIDENCE} The skill-use ledger is ~/.ashlr/skills/uses dated jsonl; events join through their trajectoryId/runId/proposalId aliases against the trajectory records' dispatch, outcome and agent-action aliases.`,
      '',
      'Find out why the aliases stopped resolving: check whether the skill-use writers (src/core/fleet/skill-shadow-observer.ts and the daemon dispatch path) still stamp the same trajectory/run/proposal ids the trajectory records alias on, whether a new event shape lands without join keys, and whether conflicting means one event now matches several records (identity ambiguity) rather than none. Note the bounded-cohort caveat: events for trajectories beyond the record cap legitimately cannot join, so confirm the failure share is not just window truncation before changing the contract. Fix what lives here — the writers, the alias resolution or the ledger schema — in this repository\'s src/. ' + NO_CHANGE,
    ].join('\n'),
  };
}

function cellItem(cell: Cell, repo: string): CloudBacklogItem {
  const id = `trajectory-gap-${createHash('sha256').update(`trajectory-gap:${cell.key}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: cell.title.slice(0, MAX_TITLE_CHARS),
    prompt: cell.prompt,
    area: 'trajectory-evidence',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for trajectory evidence-capture degradation: excluded
 * degraded-source trajectories, majority-missing evidence joins on
 * eligible trajectories, and skill-use events that cannot resolve to a
 * trajectory record. Total: a withheld projection, another repository or
 * any read failure yields no items rather than throwing into discovery.
 */
export async function trajectoryGapBacklogItems(opts: TrajectoryGapItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const windowHours = opts.windowHours ?? TRAJECTORY_GAP_WINDOW_HOURS;
    const summary = opts.summary !== undefined
      ? opts.summary
      : summarizeTrajectoryLearning(
          listTrajectoryRecords({ windowHours, limit: opts.recordLimit ?? TRAJECTORY_GAP_RECORD_LIMIT }),
          windowHours,
        );
    if (summary === null) return [];

    const cells: Cell[] = [];
    const degraded = degradedCell(summary);
    if (degraded) cells.push(degraded);
    cells.push(...gapCells(summary));
    const skillJoin = skillJoinCell(summary);
    if (skillJoin) cells.push(skillJoin);

    const limit = Math.max(1, Math.min(opts.limit ?? TRAJECTORY_GAP_MAX_ITEMS, TRAJECTORY_GAP_ITEM_HARD_MAX));
    // Population-level degradation first, then the coverage-gap cells by
    // kind, then the skill-join cell; identity keys last so the order is
    // total and deterministic.
    const rank = (cell: Cell): number => (cell.key === 'degraded' ? 0 : cell.key === 'skill-join' ? 2 : 1);
    cells.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    return cells.slice(0, limit).map((cell) => cellItem(cell, repo));
  } catch {
    return [];
  }
}
