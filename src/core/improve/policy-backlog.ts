/**
 * Fleet policy suggestions → self-improvement backlog items.
 *
 * `phm fleet metrics report|suggest|weekly` folds the jobs ledger into
 * per-lane and per-model-tier outcome cohorts (buildOutcomeMetrics) and
 * turns the measured evidence into capped advisory suggestions
 * (suggestOutcomePolicy): promptTemplateFlags for lanes whose finishes come
 * back empty, tierRoutingHints for a model with a recorded cost-per-published
 * -PR advantage inside its tier, and laneTargetDeltas for capacity. Until
 * now those suggestions only surfaced in a report someone had to run — and
 * in orchestrate's specialist messages — so the fleet's self-diagnosed
 * policy work never became backlog items. fleetPolicyBacklogItems carries
 * the repo-actionable kinds into discoverBacklog, so `phm improve discover`
 * and the scheduler's autoDiscover queue them exactly like the fleet
 * outcome-learning and nightly retro sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The jobs ledger is read through readLedgerTail's bounded
 *    window; nothing is written and no network is touched.
 *  - Degraded evidence yields no items. A cut tail or any ignored row makes
 *    buildOutcomeMetrics report degraded, and suggestOutcomePolicy abstains
 *    on anything but a healthy read — the same evidence bar the CLI report
 *    applies, so unknown stays unknown rather than becoming a guess.
 *  - laneTargetDeltas are deliberately not emitted: lane targets are runtime
 *    fleet state (status.json lanes tightened by the controller's
 *    effective_target), not repository artifacts a session can change. The
 *    repo-actionable evidence for an empty lane is already the
 *    promptTemplateFlags item, which fires on the identical measurement,
 *    and a "+1 slot" hint asks for capacity, not code.
 *  - The suggestions carry no repository dimension — they describe the
 *    fleet's lanes, models and tiers, which is this repository's machinery.
 *    Items therefore emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule fleetLearningBacklogItems applies
 *    to fleet cell repo labels; self-improvement pointed at another
 *    repository never inherits this fleet's internal tuning advice.
 *  - Dedup is downstream. The item id embeds a stable hash of the
 *    suggestion's identity (kind + lane/flag or tier + model pair), so a
 *    refresh re-derives the same id and appendUserBacklogItems adds only
 *    what is new; shifted tallies do not spawn twin items.
 *  - Every emitted prompt keeps the suggestion's advisory framing (it
 *    never applied a change) and names the jobs.jsonl evidence references
 *    to inspect, capped so one prompt stays bounded.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { buildOutcomeMetrics } from '../fleet/outcome-metrics.js';
import { suggestOutcomePolicy, type PolicySuggestion } from '../fleet/policy-suggest.js';
import { readLedgerTail, ROUTER_OUTCOME_LEDGER_RELATIVE } from '../router/outcomes.js';

/** Items one call may emit; the suggestion lists are each capped at eight upstream. */
export const FLEET_POLICY_MAX_ITEMS = 8;
const FLEET_POLICY_ITEM_HARD_MAX = 25;
/** Outcome-cohort window; matches the weekly self-report and orchestrate cadence the suggestions were designed for. */
export const FLEET_POLICY_WINDOW_HOURS = 168;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Evidence references named inside one item prompt before the remainder is summarized. */
const PROMPT_EVIDENCE_MAX = 10;
/** The fleet's own repository label: policy advice is this repo's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';

export interface FleetPolicyItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Jobs ledger override (default: <runsDir>/metrics/jobs.jsonl). */
  ledgerPath?: string;
  /** Runs dir for the ledger default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Outcome-cohort window in hours (default FLEET_POLICY_WINDOW_HOURS). */
  hours?: number;
  /** Most items one call emits (default FLEET_POLICY_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock for the metrics window and cohort bound (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

const itemId = (kind: string, key: string): string =>
  `fleet-policy-${createHash('sha256').update(`${kind}:${key}`).digest('hex').slice(0, 16)}`;

function evidenceLine(refs: readonly string[]): string {
  const shown = refs.slice(0, PROMPT_EVIDENCE_MAX);
  return shown.length === 0
    ? 'none recorded'
    : `${shown.join(', ')}${refs.length > shown.length ? `, … and ${refs.length - shown.length} more` : ''}`;
}

function policyItem(
  id: string,
  title: string,
  area: string,
  prompt: string,
  repo: string,
): CloudBacklogItem {
  return {
    id,
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area,
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function flagItem(flag: PolicySuggestion['promptTemplateFlags'][number], repo: string): CloudBacklogItem {
  const title = `Fleet lane '${flag.lane}': ${flag.flag}`;
  const prompt = [
    `Phantom's fleet outcome metrics flagged lane '${flag.lane}' for prompt-template review — the self-improvement work this backlog exists for.`,
    '',
    flag.reason,
    '',
    `Evidence references: ${evidenceLine(flag.evidenceRefs)}`,
    '',
    'The references are jobs.jsonl row positions (events:<n> in the retained ledger tail the metrics fold read): inspect the lane\'s recorded launches and finishes before changing anything. The flag is advisory — it never applied a change. Find what makes this lane\'s jobs finish empty (task scope, context or prompt-template drift in the fleet\'s job-writing path) and fix the cause in this repository; if the pattern no longer reproduces on the default branch, report no-change and name the evidence.',
  ].join('\n');
  return policyItem(itemId('template', `${flag.lane}:${flag.flag}`), title, 'fleet-policy', prompt, repo);
}

function tierItem(hint: PolicySuggestion['tierRoutingHints'][number], repo: string): CloudBacklogItem {
  const title = `Fleet tier '${hint.tier}': prefer ${hint.preferModel} over ${hint.overModel}`;
  const prompt = [
    `Phantom's fleet outcome metrics measured a routing-cost advantage inside tier '${hint.tier}' — the self-improvement work this backlog exists for.`,
    '',
    hint.reason,
    '',
    `Evidence references: ${evidenceLine(hint.evidenceRefs)}`,
    '',
    'The references are jobs.jsonl row positions (events:<n> in the retained ledger tail the metrics fold read): inspect the recorded attempts before changing anything. The hint is advisory — it never applied a change, and it already asks for validation: check task mix and merge durability against the router outcome evidence before treating the cost advantage as real. Where the repository carries the routing preference adjust it; if the evidence does not hold on the default branch, report no-change and name what you checked.',
  ].join('\n');
  return policyItem(itemId('tier', `${hint.tier}:${hint.preferModel}:${hint.overModel}`), title, 'fleet-policy', prompt, repo);
}

/**
 * Backlog items for the fleet outcome metrics' repo-actionable advisory
 * suggestions, strongest evidence first within each kind. Total: any read
 * or fold failure yields no items rather than throwing into discovery.
 */
export async function fleetPolicyBacklogItems(opts: FleetPolicyItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const ledgerPath = opts.ledgerPath
      ?? join(opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs'), ROUTER_OUTCOME_LEDGER_RELATIVE);
    const tail = await readLedgerTail(ledgerPath);
    if (tail.state !== 'read') return [];
    const events = tail.text.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
      try { return JSON.parse(line) as unknown; } catch { return null; }
    });
    const metrics = buildOutcomeMetrics({
      events,
      nowMs: (opts.now ?? new Date()).getTime(),
      hours: opts.hours ?? FLEET_POLICY_WINDOW_HOURS,
      sourceState: tail.truncated ? 'degraded' : 'healthy',
    });
    const suggestions = suggestOutcomePolicy(metrics);
    const limit = Math.max(1, Math.min(opts.limit ?? FLEET_POLICY_MAX_ITEMS, FLEET_POLICY_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    // Empty-finish flags precede tier hints: a lane whose jobs come back empty
    // wastes whole launches, while a cost hint is an optimization to validate.
    for (const flag of suggestions.promptTemplateFlags) {
      if (items.length >= limit) break;
      items.push(flagItem(flag, repo));
    }
    for (const hint of suggestions.tierRoutingHints) {
      if (items.length >= limit) break;
      items.push(tierItem(hint, repo));
    }
    return items;
  } catch {
    return [];
  }
}
