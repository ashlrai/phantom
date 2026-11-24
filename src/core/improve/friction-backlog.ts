/**
 * Fleet friction fold items → self-improvement backlog items.
 *
 * `phm friction` mines the runs dir — jobs.jsonl finishes, holds and launch
 * receipts, the dispatch event log, ready.tsv rows, guardian red-main state,
 * lane slots, budget overrides, keep.txt and its own note ledger — into
 * thirteen scored dispatch→merge drag categories (empty-finishes,
 * anomalous-diffs, requeues, lane-auth, quota-exhaustion, invalid-tier,
 * red-main, stale-ready, deferred-requests, manual-interventions,
 * wrong-route, holds, concurrency-throttle) over a 7-day window, each scored
 * as delegation unlocked × frequency × blast radius / cost. Until now the
 * fold only ever reached `phm friction`, a report someone had to run and
 * read — and its scan rows only append on manual runs — so a recurring
 * operational drag never became work. frictionBacklogItems carries the same
 * fold into discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate and pass^k sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Every source is read through readFrictionInput's bounded
 *    no-follow reads; nothing is written and no network is touched.
 *  - The fold's own evidence bar. An item emits only while its catalog
 *    open-condition held this scan — the primary signal counted something
 *    or a declared openOn signal did (frictionItemFires) — so a quiet
 *    category never queues a session and unknown stays unknown: a missing
 *    or unreadable source leaves its signals null and its categories
 *    quiet, never a guessed tally.
 *  - Operator triage is respected. A latest note of in-progress, fixed or
 *    wontfix suppresses the item; 'regressed' — a note marked fixed while
 *    the 7-day signal is back — emits, because a fix that did not hold is
 *    exactly the work this backlog exists for.
 *  - The evidence carries no repository dimension — it describes this
 *    fleet's dispatch, queue and lane machinery, which is this repository's
 *    machinery (contrib/mac dispatchd, queuegen, the router). Items
 *    therefore emit only when the backlog target's repository name is
 *    'phantom', the same last-segment rule the policy, local-gate and
 *    pass^k sources apply; self-improvement pointed at another repository
 *    never inherits this fleet's operational evidence it cannot attribute.
 *  - Dedup is downstream. The item id is the catalog's stable
 *    `friction-<item-id>` (never the counts), so a refresh re-derives the
 *    same id and appendUserBacklogItems adds only what is new; shifted
 *    tallies do not spawn twin items, and a category that goes quiet
 *    simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded (null renders as unknown, never zero), evidence
 *    lines are the fold's own scrubbed runs-dir-relative strings, and the
 *    brief tells the session to find the machinery or queue path producing
 *    the drag — with the usual no-change escape when the window no longer
 *    reproduces.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import {
  frictionItemFires,
  mineFriction,
  readFrictionInput,
  type FrictionItem,
  type FrictionReport,
} from '../fleet/friction.js';

/** Items one call may emit; the catalog is thirteen categories, score-ordered upstream. */
export const FRICTION_MAX_ITEMS = 8;
const FRICTION_ITEM_HARD_MAX = 25;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: friction evidence is this repo's machinery, never another target's. */
const FLEET_REPO_NAME = 'phantom';
/** Named 7-day signal fields quoted inside one prompt before the remainder is summarized. */
const MAX_SIGNAL_FIELDS = 12;

export interface FrictionItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding the friction sources; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default FRICTION_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the fold's 7-day window (default: now). */
  now?: Date;
}

/** The repository name both vocabularies record: the last path segment, lowercased. */
function fleetRepoName(repo: string): string {
  return (repo.split('/').pop() ?? repo).trim().toLowerCase();
}

/** A firing item no operator note has suppressed: open, or regressed after a fix that did not hold. */
function emittable(item: FrictionItem): boolean {
  return frictionItemFires(item) && (item.status === 'open' || item.status === 'regressed');
}

/** The item's named 7-day signals as `name=count` pairs; null renders unknown, never zero. */
function signalLine(item: FrictionItem): string {
  const fields = Object.entries(item.signals);
  const shown = fields.slice(0, MAX_SIGNAL_FIELDS)
    .map(([name, value]) => `${name}=${typeof value === 'number' ? value : 'unknown'}`);
  const rest = fields.length - shown.length;
  return `${shown.join(', ')}${rest > 0 ? `, … and ${rest} more` : ''}`;
}

function frictionItem(item: FrictionItem, report: FrictionReport, repo: string): CloudBacklogItem {
  const evidence = item.evidence.length === 0
    ? 'none recorded'
    : item.evidence.map((line) => `- ${line}`).join('\n');
  const score = typeof item.score === 'number' ? `${item.score}` : 'unknown';
  const primary = item.metric.unit;
  const before = item.metric.before === null ? '' : `; first recorded scan ${item.metric.before}`;
  const regressed = item.status === 'regressed'
    ? ' An operator note marked this item fixed, but the 7-day signal is back — the earlier fix did not hold.'
    : '';
  const prompt = [
    `Phantom's fleet friction fold recorded '${item.title}' firing over the last ${report.windowDays} days — recurring dispatch→merge drag the self-improvement backlog exists to fix.`,
    '',
    `Recorded owner: ${item.owner}. Fold score ${score} (delegation unlocked × ${report.windowDays}d frequency × blast radius / cost). Status: ${item.status}.${regressed}`,
    '',
    `7-day signals: ${signalLine(item)}.`,
    `Primary '${primary}': ${item.metric.after ?? 'unknown'} this scan${before}.`,
    '',
    'Evidence (runs-dir relative, scrubbed):',
    evidence,
    '',
    'The fold is `phm friction --json` over the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): metrics/jobs.jsonl, queue/dispatch-events.log, queue/ready.tsv, guardian/state.json, queue/slots.json, queue/budget-overrides.json, queue/keep.txt and friction/ledger.jsonl operator notes. Find the machinery or queue path producing this drag and fix the cause in this repository. If the pattern no longer reproduces on the default branch — or an operator note already owns it — report no-change and name the evidence.',
  ].join('\n');
  return {
    id: `friction-${item.id}`,
    title: `Fleet friction: ${item.title}`.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'fleet-friction',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the fleet friction fold's firing categories, in the
 * report's own score order. Total: any read or fold failure yields no items
 * rather than throwing into discovery.
 */
export async function frictionBacklogItems(opts: FrictionItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const input = await readFrictionInput(runsDir);
    const report = mineFriction({ ...input, now: (opts.now ?? new Date()).getTime() });
    const limit = Math.max(1, Math.min(opts.limit ?? FRICTION_MAX_ITEMS, FRICTION_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const item of report.items) {
      if (items.length >= limit) break;
      if (!emittable(item)) continue;
      items.push(frictionItem(item, report, repo));
    }
    return items;
  } catch {
    return [];
  }
}
