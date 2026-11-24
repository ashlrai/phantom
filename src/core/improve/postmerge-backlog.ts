/**
 * Post-merge observation adverse outcomes → self-improvement backlog items.
 *
 * The daemon's outcome machinery records what happened AFTER a merge: the
 * outcome-watcher and post-merge-stability passes write signed
 * observation-only rows — reverted, regressed and followed-up — to
 * $ASHLR_HOME/fleet/post-merge-observations.jsonl, keyed by merge commit.
 * `buildFleetEvalReport` (the fold `phm fleet eval-report` prints) joins
 * those rows through metrics/jobs.jsonl into per-lane, per-tier and
 * per-repo durability tallies — which parts of the fleet produce work
 * that holds. Until now that answer only ever reached the report itself
 * (and the standing merge pass's internal pacing read): a lane whose
 * merges keep coming back reverted, a tier whose diffs keep needing
 * follow-up fixes, or a repository whose merged work keeps regressing
 * never became work. postMergeBacklogItems carries the same fold into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate, pass^k, friction, tick-health, cross-review
 * and empty-tag sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's
 *    bounded no-follow tail (ROUTER_OUTCOME_LEDGER_LIMIT — the same bound
 *    the sibling feeders apply) and the observation ledger through
 *    readPostMergeObservations' verified private-file read; nothing is
 *    written and no network is touched.
 *  - Healthy-only evidence bar. A missing or unreadable jobs ledger
 *    yields no items, and a degraded observation read (conflicts,
 *    invalid rows, byte/row limits, io errors) withholds the whole
 *    source — a partial signed ledger under-counts, never invents, but
 *    the sibling convention is that partially corrupt evidence stays
 *    quiet rather than queueing work on a guess. A genuinely absent
 *    observation ledger is a clean empty source: no adverse rows, no
 *    items.
 *  - Recurring means recorded. A group emits only at
 *    POSTMERGE_RECURRING adverse outcomes (reverted + regressed +
 *    followed-up) inside the report window — the fleet's
 *    RECURRING_FAILURES convention applied to realized post-merge
 *    evidence, so one unlucky merge never queues a session.
 *  - Attributed only. Lane and tier items group the report's own
 *    attributed cells — 'unattributed' merges carry no lane or tier
 *    evidence and never emit. Repo items match the group name's last
 *    path segment against the backlog target's, the same rule the
 *    fleet-outcome-learning source applies, so adverse evidence on
 *    another repository's merges never lands on this one. Lane and tier
 *    describe this fleet's executor machinery, so they emit only for
 *    the fleet's own repository ('phantom'); a repository item emits
 *    for whichever target the fold's repo name matches.
 *  - The fold's own honesty carries through. The report is built with
 *    no gh export — the same evidence bar the standing merge pass's
 *    evalReport dep applies — so 'stable' is unreachable and the
 *    durability rate/resolved figures are degenerate (they would read
 *    0% whenever any adverse row exists). Items therefore quote only
 *    what the fold actually measured: merged, reverted, regressed,
 *    followed-up, pending and unobserved counts plus the
 *    deterministic/heuristic confidence split off the attributed pull
 *    requests — never a durability percentage.
 *  - Dedup is downstream. The item id embeds a stable hash of the group
 *    identity (dimension + recorded group name — never the counts or
 *    timestamps), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted tallies do
 *    not spawn twin items, and a group that recovers simply stops
 *    re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, group names and example PR urls are scrubbed and
 *    flattened to one line, and the brief names the ledgers and report
 *    command with the usual no-change escape when the window no longer
 *    reproduces.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  buildFleetEvalReport,
  type EvalGroupRow,
  type EvalObservationRow,
  type EvalPullRequest,
  type FleetEvalReport,
} from '../fleet/eval-report.js';
import { readPostMergeObservations } from '../fleet/post-merge-observations.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; group cells are bounded upstream but unbounded in practice. */
export const POSTMERGE_MAX_ITEMS = 8;
const POSTMERGE_ITEM_HARD_MAX = 25;
/**
 * Adverse post-merge outcomes inside the window a group needs before it
 * counts as recurring — the fleet's RECURRING_FAILURES convention the
 * sibling feeds apply to their own tallies.
 */
export const POSTMERGE_RECURRING = 3;
/**
 * The report window: the same 30 days the standing merge pass's own
 * evalReport dep folds, generous enough for the observation passes'
 * follow-up and stability windows to have landed.
 */
export const POSTMERGE_WINDOW_DAYS = 30;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: lane and tier evidence is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Example pull requests quoted per group inside one prompt. */
const MAX_EXAMPLES = 3;
/** Ledger-recorded labels are unbounded text; flatten, scrub and cap before they reach a prompt. */
const MAX_FIELD_CHARS = 96;

export interface PostMergeItemsOptions {
  /** Backlog target in owner/name form; repo items must name the same repository, lane/tier items require the fleet's own. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Injected jobs-ledger content (tests); skips the ledger read when set. A bare string is a complete read, { text, truncated } a bounded tail. */
  jobsText?: string | { text: string; truncated: boolean };
  /**
   * Injected observation evidence (tests); skips the signed-ledger read
   * when set. Same shape buildFleetEvalReport consumes: the read's
   * sourceState plus the rows mapped to { outcome, mergeCommit,
   * confidence }.
   */
  observations?: { sourceState: 'healthy' | 'missing' | 'degraded'; rows: EvalObservationRow[] };
  /** Report window in days (default POSTMERGE_WINDOW_DAYS). */
  windowDays?: number;
  /** Most items one call emits (default POSTMERGE_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the report window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded names are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number = MAX_FIELD_CHARS): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const isAdverse = (durability: EvalPullRequest['durability']): boolean =>
  durability === 'reverted' || durability === 'regressed' || durability === 'followed-up';

const adverseCount = (group: EvalGroupRow): number => group.reverted + group.regressed + group.followedUp;

interface GroupCandidate {
  dim: 'lane' | 'tier' | 'repo';
  /** The fold's recorded group name, verbatim. */
  name: string;
  group: EvalGroupRow;
}

/**
 * The pull requests behind one group cell: adverse-durability entries whose
 * recorded attribution matches the group's own dimension value, newest merge
 * first. Attribution fields come from the same fold pass that built the
 * groups, so the match is exact — never a re-derived guess.
 */
function groupExamples(report: FleetEvalReport, dim: GroupCandidate['dim'], name: string): EvalPullRequest[] {
  return report.pullRequests
    .filter((pr) => isAdverse(pr.durability)
      && (dim === 'lane' ? pr.lane === name : dim === 'tier' ? pr.tier === name : pr.repo === name))
    .sort((a, b) => (b.mergedAt ?? '').localeCompare(a.mergedAt ?? ''))
    .slice(0, MAX_EXAMPLES);
}

/** Deterministic vs heuristic adverse evidence across the group's example set and the whole cohort. */
function confidenceSplit(report: FleetEvalReport, dim: GroupCandidate['dim'], name: string): { deterministic: number; heuristic: number } {
  const split = { deterministic: 0, heuristic: 0 };
  for (const pr of report.pullRequests) {
    if (!isAdverse(pr.durability)) continue;
    if (!(dim === 'lane' ? pr.lane === name : dim === 'tier' ? pr.tier === name : pr.repo === name)) continue;
    if (pr.durabilityConfidence === 'deterministic') split.deterministic++;
    else if (pr.durabilityConfidence === 'heuristic') split.heuristic++;
  }
  return split;
}

const NO_CHANGE = 'If the pattern no longer reproduces — the window rolled forward, the offending lane/tier/repo changed, or the cause is owner-only (credentials, billing, a protected gate) — report no-change and name the evidence.';

function postMergePrompt(candidate: GroupCandidate, report: FleetEvalReport): string {
  const { dim, name, group } = candidate;
  const label = fieldText(name);
  const examples = groupExamples(report, dim, name);
  const split = confidenceSplit(report, dim, name);
  const merged = group.merged;
  const tally = `${merged} merged PR(s) attributed to ${dim} '${label}' inside the ${report.window.days}-day window: ` +
    `${group.reverted} reverted, ${group.regressed} regressed, ${group.followedUp} followed-up ` +
    `(${group.pending} still pending, ${group.unobserved} unobserved).`;
  const confidence = split.deterministic + split.heuristic > 0
    ? ` Adverse confidence: ${split.deterministic} deterministic, ${split.heuristic} heuristic.`
    : '';
  const exampleLine = examples.length > 0
    ? ` Example pull requests: ${examples.map((pr) => `${fieldText(pr.url, 160)} (${pr.durability})`).join(', ')}.`
    : '';
  const lead = [
    dim === 'repo'
      ? `Phantom's signed post-merge observation ledger recorded recurring adverse outcomes on merges into '${label}' — work that later reverted, regressed or needed follow-up fixes — the self-improvement work this backlog exists for.`
      : `Phantom's signed post-merge observation ledger recorded recurring adverse outcomes on merges produced through ${dim} '${label}' — work that later reverted, regressed or needed follow-up fixes — the self-improvement work this backlog exists for.`,
    '',
    tally + confidence + exampleLine,
    '',
  ];
  const body: Record<GroupCandidate['dim'], string> = {
    lane: [
      `The evidence is $ASHLR_HOME/fleet/post-merge-observations.jsonl (signed, observation-only) joined to metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR); \`phm fleet eval-report --json\` folds the same inputs into per-lane/tier/repo durability tallies.`,
      '',
      `A lane whose merges keep coming back adverse is producing work that does not hold: find whether the lane's prompt template, model assignment, scope rules or verification bar in this repository's fleet machinery (src/core/fleet/, queue specs, lane launch paths) lets through the failure mode the observations recorded — a revert means the change was wrong, a regression means it broke what was green, a follow-up means it shipped incomplete. Fix the cause in this repository. ${NO_CHANGE}`,
    ].join('\n'),
    tier: [
      `The evidence is $ASHLR_HOME/fleet/post-merge-observations.jsonl (signed, observation-only) joined to metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR); \`phm fleet eval-report --json\` folds the same inputs into per-lane/tier/repo durability tallies.`,
      '',
      `A tier whose merges keep coming back adverse is a job class whose briefs outrun its verification: find whether the tier's scope budget, required checks or job-brief template in this repository's fleet machinery and queue conventions let the recorded failure mode through — work too large for its checks, or checks too weak for its scope. Fix the cause in this repository. ${NO_CHANGE}`,
    ].join('\n'),
    repo: [
      `The evidence is $ASHLR_HOME/fleet/post-merge-observations.jsonl (signed, observation-only) joined to metrics/jobs.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR); \`phm fleet eval-report --json\` folds the same inputs into per-lane/tier/repo durability tallies.`,
      '',
      `A repository whose merges keep coming back adverse either has gates that let the failure mode through or attracts job briefs that miss it: find whether this repository's own verification (its test suites, gates, review conventions) should have caught the recorded reverts/regressions/follow-ups, or whether the fleet's job briefs for it under-scope the risk. Fix the cause in this repository. ${NO_CHANGE}`,
    ].join('\n'),
  };
  return [...lead, body[dim]].join('\n');
}

function postMergeItem(candidate: GroupCandidate, report: FleetEvalReport, repo: string): CloudBacklogItem {
  const { dim, name } = candidate;
  const label = fieldText(name);
  const titles: Record<GroupCandidate['dim'], string> = {
    lane: `Fleet lane '${label}' merges keep coming back adverse`,
    tier: `Fleet tier '${label}' merges keep coming back adverse`,
    repo: `Merges into '${label}' keep coming back adverse`,
  };
  const id = `postmerge-${dim}-${createHash('sha256').update(`${dim}:${name}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: titles[dim].slice(0, MAX_TITLE_CHARS),
    prompt: postMergePrompt(candidate, report),
    area: 'post-merge-outcomes',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for recurring adverse post-merge outcomes, strongest
 * evidence first. Total: any read, degraded source or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function postMergeBacklogItems(opts: PostMergeItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '') return [];
    const targetIsFleet = fleetRepoName(repo) === FLEET_REPO_NAME;
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');

    const jobs = opts.jobsText !== undefined
      ? { state: 'read' as const, text: typeof opts.jobsText === 'string' ? opts.jobsText : opts.jobsText.text, truncated: typeof opts.jobsText === 'string' ? false : opts.jobsText.truncated }
      : await readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE));
    if (jobs.state !== 'read') return [];

    const observations = opts.observations ?? (() => {
      const read = readPostMergeObservations();
      return {
        sourceState: read.sourceState,
        rows: read.observations.map((o): EvalObservationRow => ({
          outcome: o.outcome,
          mergeCommit: o.mergeCommit,
          confidence: o.confidence,
        })),
      };
    })();
    // Healthy-only evidence bar: 'missing' is a clean empty ledger (no
    // adverse rows can exist), 'degraded' means the signed read could not
    // be trusted — conflicts, invalid rows or limits — so the source
    // stays quiet rather than guessing which merges came back adverse.
    if (observations.sourceState === 'degraded') return [];

    const report = buildFleetEvalReport({
      jobsText: { text: jobs.text, truncated: jobs.truncated },
      observations,
      nowMs: (opts.now ?? new Date()).getTime(),
      windowDays: opts.windowDays ?? POSTMERGE_WINDOW_DAYS,
    });

    const candidates: GroupCandidate[] = [];
    if (targetIsFleet) {
      for (const group of report.byLane) {
        if (group.name === 'unattributed') continue;
        if (adverseCount(group) >= POSTMERGE_RECURRING) candidates.push({ dim: 'lane', name: group.name, group });
      }
      for (const group of report.byTier) {
        if (group.name === 'unattributed') continue;
        if (adverseCount(group) >= POSTMERGE_RECURRING) candidates.push({ dim: 'tier', name: group.name, group });
      }
    }
    const targetName = fleetRepoName(repo);
    for (const group of report.byRepo) {
      if (fleetRepoName(group.name) !== targetName) continue;
      if (adverseCount(group) >= POSTMERGE_RECURRING) candidates.push({ dim: 'repo', name: group.name, group });
    }
    // Strongest recorded evidence first; identity fields last so the order is total.
    candidates.sort((a, b) =>
      adverseCount(b.group) - adverseCount(a.group)
      || b.group.merged - a.group.merged
      || a.dim.localeCompare(b.dim)
      || a.name.localeCompare(b.name));
    const limit = Math.max(1, Math.min(opts.limit ?? POSTMERGE_MAX_ITEMS, POSTMERGE_ITEM_HARD_MAX));
    return candidates.slice(0, limit).map((candidate) => postMergeItem(candidate, report, repo));
  } catch {
    return [];
  }
}
