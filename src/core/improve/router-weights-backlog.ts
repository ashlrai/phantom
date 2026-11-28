/**
 * Outcome-driven router-weight proposals → self-improvement backlog items.
 *
 * `phm fleet router-weights` (src/cli/fleet-router-weights.ts over
 * src/core/router/weight-proposals.ts) folds the same bounded
 * metrics/jobs.jsonl outcome read every sibling feed shares — held-merge
 * verdicts joined to work-market route_decision classes, api-spend costs,
 * merge-events queue history, cross-review verdicts, launch-cost and
 * reward-signal evidence — into router.weight-proposals.v1: per
 * (work_class, lane) group the observed held-merge rate is compared
 * against an assumed 0.5 baseline and a bounded shift proposed (at least
 * ROUTER_WEIGHT_DEFAULT_MIN_SAMPLES=20 known outcomes per group, shifts
 * capped at 0.1 and clamped to [0, 1]; merges recorded as reverted count
 * as known but never as held). The math is pure and already recovered;
 * the report is advisory-only by design — it writes nothing, never
 * touches weights.json and changes no live routing.
 *
 * Until now the proposal set's only reader was that CLI report — a
 * human had to run it and read it, so statistically-evidenced weight
 * proposals never became work. And the dead end is deeper than
 * discoverability: no caller passes `baselines`, so every group assumes
 * 0.5, and no weights.json or weight consumer exists anywhere in the
 * tree — 'proposed' records that a group's held-merge rate departs from
 * neutral over the retained window, not that a stored weight should
 * move. routerWeightBacklogItems carries each material proposal into
 * discoverBacklog so a session can evaluate the evidence and either
 * wire a bounded weight source into the routing/market decision path or
 * fix the upstream evidence (work-class joins, outcome capture, lane
 * placement) that makes the proposal wrong.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. readRouterOutcomes applies its own bounded no-follow
 *    tails to jobs.jsonl and every joined ledger; nothing is written
 *    and no network is touched. A missing, unreadable or oversized
 *    jobs ledger yields no items; truncated tails are stated as lower
 *    bounds in the prompt.
 *  - Only recorded proposals emit. Groups the fold refuses for
 *    insufficient evidence keep their baseline and never produce an
 *    item; merged:null outcomes count as unknown inside the fold,
 *    never as failures; unclassified outcomes supply no samples.
 *  - Materiality is the feed's own bar: a proposal emits only at
 *    status 'proposed' with |shift| >= ROUTER_WEIGHTS_MIN_SHIFT — a
 *    sub-bar shift is inside the fold's sampling noise at its own
 *    evidence floor and is not worth a session.
 *  - Fleet machinery only: the outcome ledger describes this install's
 *    dispatch machinery and the proposal targets this repository's
 *    routing code, so items emit only when the backlog target's
 *    repository name is 'phantom' — the same last-segment rule the
 *    sibling fleet-evidence sources apply.
 *  - Dedup is downstream: the item id hashes the (work_class, lane)
 *    cell identity — never counts, weights or timestamps — so a
 *    refresh re-derives the same id while the cell stays material,
 *    a recovered or reclassified cell simply stops re-adding, and a
 *    moved proposal refreshes the same item's evidence stamp rather
 *    than spawning a twin.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readRouterOutcomes, type RouterOutcomeEvidenceRow, type RouterOutcomeRead } from '../router/outcomes.js';
import { proposeRouterWeights, type RouterWeightEvidence, type RouterWeightProposal } from '../router/weight-proposals.js';

/** Items one call may emit; proposal cells are bounded by work_class x lane diversity. */
export const ROUTER_WEIGHTS_MAX_ITEMS = 8;
const ROUTER_WEIGHTS_ITEM_HARD_MAX = 25;
/**
 * Minimum |shift| for an item. The fold proposes any nonzero shift once
 * a group clears its evidence floor, but at the default 20-sample floor
 * a sub-0.05 move is inside sampling noise — the feed's own materiality
 * bar keeps noise-level proposals out of the backlog.
 */
export const ROUTER_WEIGHTS_MIN_SHIFT = 0.05;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: outcome evidence is this install's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface RouterWeightsItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl; $ASHLR_RUNS_DIR wins when absolute, else ~/.ashlr-runs. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** ASHLR home root override for the ashlarDir-rooted joins (tests). */
  ashlarDir?: string;
  /** Authority-ledger evidence override forwarded to readRouterOutcomes (tests). */
  authorityEvidence?: readonly RouterOutcomeEvidenceRow[] | null;
  /** Proposal evidence floor override forwarded to proposeRouterWeights (default: the fold's own 20). */
  minSamples?: number;
  /** Proposal shift cap override forwarded to proposeRouterWeights (default: the fold's own 0.1). */
  maxShift?: number;
  /** Minimum |shift| for an item (default ROUTER_WEIGHTS_MIN_SHIFT). */
  minShift?: number;
  /** Most items one call emits (default ROUTER_WEIGHTS_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name the fleet machinery records: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

function round(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

/**
 * The group's recorded outcome-quality signals in the report's own
 * name=value(known) style, capped to the signals a session weighs
 * first. Every figure carries its coverage count; a signal with no
 * recorded evidence is omitted — never rendered as zero.
 */
function evidenceText(e: RouterWeightEvidence): string {
  const parts: string[] = [];
  if (e.ci_first_pass_rate !== null) parts.push(`ci_first_pass=${e.ci_first_pass_rate}(${e.ci_first_pass_known})`);
  if (e.review_findings !== null) {
    const f = e.review_findings;
    parts.push(`review_findings=fixed:${f.fixed},rejected:${f.rejected},ignored:${f.ignored}(${e.review_findings_known})`);
  }
  if (e.cross_review !== null) {
    const c = e.cross_review;
    parts.push(`cross_review=approve:${c.approve},reject:${c.reject},failed:${c.failed},skipped:${c.skipped}(${e.cross_review_known})`);
  }
  if (e.cost_usd_mean !== null) parts.push(`cost_usd=${round(e.cost_usd_mean)}(${e.cost_known})`);
  if (e.wall_s_mean !== null) parts.push(`wall_s=${round(e.wall_s_mean)}(${e.wall_known})`);
  if (e.ttm_s_mean !== null) parts.push(`ttm_s=${round(e.ttm_s_mean)}(${e.ttm_known})`);
  if (e.queue_wait_s_mean !== null) parts.push(`queue_wait_s=${round(e.queue_wait_s_mean)}(${e.queue_wait_known})`);
  if (e.lane_overrides_known > 0 && e.lane_override_reasons !== null) {
    parts.push(`lane_overrides=${e.lane_overrides_known}(${e.lane_override_reasons.map((r) => `${r.reason}:${r.jobs}`).join(',')})`);
  }
  if (e.market_rejected_known > 0) {
    parts.push(`market_rejected=${e.market_rejected_known}` +
      (e.market_rejected_reasons !== null && e.market_rejected_reasons.length > 0
        ? `(${e.market_rejected_reasons.map((r) => `${r.reason}:${r.jobs}`).join(',')})` : ''));
  }
  if (e.provider_wall_known > 0) {
    parts.push(`provider_wall=${e.provider_wall_known}` +
      (e.provider_wall_triggers !== null && e.provider_wall_triggers.length > 0
        ? `(${e.provider_wall_triggers.map((r) => `${r.trigger}:${r.jobs}`).join(',')})` : ''));
  }
  if (e.pool_known > 0) {
    parts.push(`pool=${e.pool_known}` +
      (e.pool_kinds !== null && e.pool_kinds.length > 0
        ? `(${e.pool_kinds.map((r) => `${r.kind}:${r.jobs}`).join(',')})` : ''));
  }
  if (e.repos !== null && e.repos_known > 0) {
    parts.push(`repos=${e.repos.map((r) => `${r.repo}:${r.jobs}`).join(',')}`);
  }
  return parts.join(', ');
}

const NO_CHANGE = 'If the window has rolled forward, the deviation traces to work-class misclassification or lane placement already fixed, or the cause is owner-side — report no-change and name the evidence.';

/** Per-direction hunt text: what a positive or negative held-merge deviation can mean. */
function huntText(proposal: RouterWeightProposal): string {
  return proposal.shift > 0
    ? 'whether the lane genuinely out-merges on this work class — seat quality, harness fit, model strength for the class — or the known cohort clusters in a lucky window, an easy repo mix (the repos tally shows the mix), or work the market classified generously'
    : 'whether the lane under-merges on this work class — provider walls, quota posture, work-class mismatch, or the merge-queue and review friction the evidence signals record — or the cohort is polluted by jobs whose class join came from a stale market decision';
}

function coverageText(read: RouterOutcomeRead): string {
  const parts: string[] = [];
  if (read.truncated) parts.push('the jobs-ledger read is a bounded newest-bytes tail, so these counts are a lower bound — older outcomes may exist beyond the retained window');
  if (read.market_state !== 'read') {
    parts.push(`the work-market ledger is ${read.market_state}, so work_class groups reflect only jobs-ledger work_class fields — market-joined classes are missing, not zero`);
  } else if (read.market_truncated) {
    parts.push('the work-market read is a bounded newest-bytes tail, so work_class joins cover only the newest decisions');
  }
  return parts.length === 0 ? '' : ` Coverage: ${parts.join('; ')}.`;
}

function routerWeightsPrompt(proposal: RouterWeightProposal, read: RouterOutcomeRead): string {
  const reverted = proposal.reverted_n > 0 ? `, ${proposal.reverted_n} recorded as reverted (known evidence, never held)` : '';
  const evidence = evidenceText(proposal.evidence);
  return [
    `Phantom's outcome fold proposes a router weight for work_class '${proposal.work_class}' on lane '${proposal.lane}': the group's held-merge rate moved the assumed ${proposal.baseline_weight} baseline to ${proposal.proposed_weight} (shift ${proposal.shift > 0 ? '+' : ''}${proposal.shift}) over ${proposal.known_n} known outcomes${reverted} — the self-improvement work this backlog exists for.`,
    '',
    `Each proposal is the fold's own verdict that this (work_class, lane) group's recorded held-merge rate departs from neutral over the retained outcome window. Every baseline is the fold's assumed 0.5 — no weights.json or weight consumer exists in the tree today, so 'proposed' records the departure, not a stored weight that should move.${evidence === '' ? '' : ` Recorded evidence on the same cohort: ${evidence}.`}${coverageText(read)}`,
    '',
    `Reproduce the fold read-only with \`phm fleet router-weights --json\` (or --runs-dir <dir>): it folds metrics/jobs.jsonl outcomes per (work_class, lane) — the lane the job actually ran on, the class from its newest work-market route_decision row or an explicit jobs-row field — joined with api-spend costs, merge-events queue history, cross-review verdicts, launch-cost, empty-tag and reward-signal evidence under the same bounded tails. Groups below the evidence floor are refused and keep their baseline; merged:null outcomes count as unknown, never as failures.`,
    '',
    `Find which side owns the deviation: ${huntText(proposal)}. If the evidence is sound and the fleet warrants it, the work is wiring a bounded, documented weight source into the routing/market decision path in src/core — the proposal math in src/core/router/weight-proposals.ts and the outcome fold in src/core/router/outcomes.ts are the inputs; contrib/mac dispatch machinery is pinned ops code, report rather than edit live. If the deviation is noise, already handled, or owner-side — ${NO_CHANGE}`,
  ].join('\n');
}

function routerWeightsItem(proposal: RouterWeightProposal, repo: string, read: RouterOutcomeRead): CloudBacklogItem {
  const id = `fleet-router-weights-${createHash('sha256').update(`router-weights:${proposal.work_class}:${proposal.lane}`).digest('hex').slice(0, 16)}`;
  const direction = proposal.shift > 0 ? 'above' : 'below';
  const title = `Router weight evidence: ${proposal.work_class}/${proposal.lane} held-merge rate ${direction} neutral over ${proposal.known_n} outcomes`
    .slice(0, MAX_TITLE_CHARS);
  return {
    id,
    title,
    prompt: routerWeightsPrompt(proposal, read),
    area: 'router-weights',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for material outcome-driven router-weight proposals.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function routerWeightBacklogItems(opts: RouterWeightsItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    // Same precedence the sibling jobs-ledger feeds apply: explicit dir,
    // then an absolute ASHLR_RUNS_DIR, then ~/.ashlr-runs — a relative or
    // empty env value is no dir at all, never the process cwd.
    const envRuns = process.env['ASHLR_RUNS_DIR'];
    const runsDir = opts.runsDir ?? (envRuns !== undefined && envRuns.startsWith('/') ? envRuns : join(home, '.ashlr-runs'));
    const read = await readRouterOutcomes({
      runsDir,
      ...(opts.ashlarDir !== undefined ? { ashlarDir: opts.ashlarDir } : {}),
      ...(opts.authorityEvidence !== undefined ? { authorityEvidence: opts.authorityEvidence } : {}),
    });
    // 'read' is the only trustworthy state: every other ledger state is
    // an unknown outcome set, and unknown never becomes a proposal.
    if (read.state !== 'read') return [];
    const set = proposeRouterWeights(read.outcomes, {
      ...(opts.minSamples !== undefined ? { minSamples: opts.minSamples } : {}),
      ...(opts.maxShift !== undefined ? { maxShift: opts.maxShift } : {}),
    });
    const minShift = opts.minShift ?? ROUTER_WEIGHTS_MIN_SHIFT;
    const limit = Math.max(1, Math.min(opts.limit ?? ROUTER_WEIGHTS_MAX_ITEMS, ROUTER_WEIGHTS_ITEM_HARD_MAX));
    return set.proposals
      .filter((p) => p.status === 'proposed' && Math.abs(p.shift) >= minShift)
      .sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift)
        || b.known_n - a.known_n
        || a.work_class.localeCompare(b.work_class)
        || a.lane.localeCompare(b.lane))
      .slice(0, limit)
      .map((p) => routerWeightsItem(p, repo, read));
  } catch {
    return [];
  }
}
