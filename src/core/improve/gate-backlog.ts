/**
 * Local-gate ledger recurring step failures → self-improvement backlog items.
 *
 * Every gated worker run appends one LocalGateReport — the pre-merge verdict
 * plus per-step outcomes (typecheck, verify-changed, merge readiness, budget,
 * git identity) — to <runs>/metrics/local-gate.jsonl, and readLocalGateEvidence
 * already folds that ledger into per-step run/failure tallies. Until now the
 * only consumer was `phm fleet vitals`, a report someone had to run and
 * read, so a gate step that keeps failing workers' diffs never became work.
 * localGateBacklogItems carries the same fold into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it exactly
 * like the fleet outcome-learning, nightly retro and policy sources beside
 * it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The ledger is read through readLocalGateEvidence's bounded
 *    no-follow tail (LOCAL_GATE_TAIL_BYTES); nothing is written and no
 *    network is touched.
 *  - Degraded evidence yields no items. A missing ledger, an unreadable
 *    file, zero valid reports, or any unparseable row inside the retained
 *    window marks the source degraded/unknown — the same healthy-only bar
 *    the policy-suggestion source applies — so unknown stays unknown
 *    rather than becoming a guessed failure tally.
 *  - Recurring means recorded. A step emits only after LOCAL_GATE_RECURRING_
 *    FAILURES failed runs inside the retained window — the fleet's
 *    RECURRING_FAILURES convention — so one flaky gate run never queues a
 *    session, and the tally counts only structurally valid reports.
 *  - The ledger rows carry no repository dimension (a report names head/base
 *    SHAs, never the checkout's repo), and the gate's steps are this
 *    repository's machinery — typecheck against its tsconfig, verify-changed
 *    against its script. Items therefore emit only when the backlog target's
 *    repository name is 'phantom', the same last-segment rule
 *    fleetPolicyBacklogItems applies; self-improvement pointed at another
 *    repository never inherits this fleet's gate-health evidence it cannot
 *    attribute.
 *  - Dedup is downstream. The item id embeds a stable hash of the step name
 *    (never the counts), so a refresh re-derives the same id and
 *    appendUserBacklogItems adds only what is new; shifted tallies do not
 *    spawn twin items, and a step that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the step name is scrubbed and flattened to one line
 *    before it reaches the prompt, and the brief tells the session to find
 *    whether the gate step or the worker output is at fault — with the
 *    usual no-change escape when the window no longer reproduces.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  readLocalGateEvidence,
  type LocalGateEvidence,
  type LocalGateStepTally,
} from '../fleet/local-gate.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the failing-step list is bounded upstream but unbounded in practice. */
export const LOCAL_GATE_MAX_ITEMS = 8;
const LOCAL_GATE_ITEM_HARD_MAX = 25;
/**
 * Failed runs inside the retained window a gate step needs before it counts
 * as recurring — the same absolute-evidence bar outcome-learning's
 * RECURRING_FAILURES applies to breakage, revert, dirty and fixup patterns.
 */
export const LOCAL_GATE_RECURRING_FAILURES = 3;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: gate evidence carries no repo and the gate is this repo's machinery. */
const FLEET_REPO_NAME = 'phantom';
/** Ledger path named inside item prompts, relative to the runs dir. */
const LOCAL_GATE_LEDGER_RELATIVE = join('metrics', 'local-gate.jsonl');

export interface LocalGateItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/local-gate.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default LOCAL_GATE_MAX_ITEMS, hard-capped). */
  limit?: number;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** Ledger-recorded step names are bounded to 64 chars upstream; flatten and scrub anyway. */
function stepName(name: string): string {
  return scrubSecrets(name).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 64);
}

function gateStepItem(step: LocalGateStepTally, evidence: LocalGateEvidence, repo: string): CloudBacklogItem {
  const name = stepName(step.name);
  const id = `local-gate-${createHash('sha256').update(`local-gate:${name}`).digest('hex').slice(0, 16)}`;
  const title = `Local gate step '${name}' keeps failing`.slice(0, MAX_TITLE_CHARS);
  const totals = `${evidence.reports} gate report(s) in the retained window: ${evidence.passed} passed, ${evidence.failed} failed`;
  const tally = `step '${name}' failed ${step.failures} of its ${step.runs} recorded runs`;
  const last = evidence.last === null
    ? ''
    : ` The newest recorded gate verdict was '${evidence.last.verdict}'` +
      (evidence.last.failedSteps.length > 0
        ? ` (failed steps: ${evidence.last.failedSteps.map(stepName).join(', ')})`
        : ' (no step recorded a failure)') + '.';
  const prompt = [
    `Phantom's local pre-merge gate ledger shows step '${name}' failing repeatedly across gated worker runs — the self-improvement work this backlog exists for.`,
    '',
    `${totals}; ${tally}.${last}`,
    '',
    `The ledger is ${LOCAL_GATE_LEDGER_RELATIVE} under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR); \`phm fleet vitals --json\` folds the same ledger into per-step tallies. A chronically failing step means workers' diffs are dying at the gate: find whether the step itself is wrong — a verify-changed false positive, a broken typecheck or lint baseline, an over-tight budget, a merge-readiness probe that misreads the PR — or the worker output genuinely fails it, and fix the cause in this repository. If the failures were a transient window that no longer reproduces on the default branch, report no-change and name the evidence.`,
  ].join('\n');
  return {
    id,
    title,
    prompt,
    area: 'local-gate',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the local-gate ledger's recurring step failures, worst
 * step first (the reader already sorts tallies by failures). Total: any
 * read or fold failure yields no items rather than throwing into discovery.
 */
export async function localGateBacklogItems(opts: LocalGateItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const evidence = await readLocalGateEvidence(runsDir);
    // Healthy-only evidence bar: a missing, unreadable or partially corrupt
    // ledger is unknown, never a guessed tally — the same rule the sibling
    // sources apply to their own degraded corpora.
    if (evidence.state !== 'known' || evidence.source !== 'healthy') return [];
    const limit = Math.max(1, Math.min(opts.limit ?? LOCAL_GATE_MAX_ITEMS, LOCAL_GATE_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const step of evidence.steps) {
      if (items.length >= limit) break;
      if (step.failures < LOCAL_GATE_RECURRING_FAILURES) continue;
      items.push(gateStepItem(step, evidence, repo));
    }
    return items;
  } catch {
    return [];
  }
}
