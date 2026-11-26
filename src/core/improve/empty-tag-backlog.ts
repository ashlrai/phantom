/**
 * Empty-job tag ledger recurring tags → self-improvement backlog items.
 *
 * Every empty finish the fleet records eventually gets a `job.empty-tag.v1`
 * row in <runs>/metrics/empty-tags.jsonl — the daemon's empty-tag-sync
 * classifies bounded jobs-ledger finishes from their log tails on the
 * self-improvement cadence (src/core/fleet/empty-tag-sync.ts), and
 * `phm jobs empty --record` writes the same rows by hand. The closed
 * five-tag vocabulary (already_done, pool_cap, blocked, no_change_needed,
 * unknown — src/core/fleet/empty-tags.ts) is already folded into router
 * outcomes and the fleet's empty-job reports, but until now nothing turned
 * a recurring tag into work: a fleet whose empties keep landing 'blocked'
 * or whose classifier keeps answering 'unknown' only ever surfaced in
 * `phm empties`-family reports someone had to run and read.
 * emptyTagBacklogItems carries the same evidence into discoverBacklog, so
 * `phm improve discover` and the scheduler's autoDiscover queue it exactly
 * like the fleet outcome-learning, nightly retro, policy, local-gate,
 * pass^k, friction and tick-health sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. metrics/jobs.jsonl is read through readLedgerTail's bounded
 *    no-follow tail and metrics/empty-tags.jsonl through readLedgerFile's
 *    bounded no-follow full read; nothing is written and no network is
 *    touched.
 *  - Healthy-only evidence bar. A missing, unreadable or non-file jobs
 *    ledger yields no items; the tags ledger must be fully readable —
 *    'missing' is a clean empty ledger (every joined empty is then
 *    honestly untagged) while 'unreadable', 'not-file' or 'too-large'
 *    means the job→tag join cannot be trusted, so the whole source stays
 *    quiet rather than guessing which finishes carry which tag.
 *  - Recurring means recorded. A bucket emits only at
 *    EMPTY_TAG_RECURRING recorded occurrences inside the same 72-hour
 *    window the sync itself uses (EMPTY_TAG_SYNC_HOURS), so one-off
 *    empties never queue a session.
 *  - Skipped finishes are not worker empties. The finish fold marks
 *    precheck_skip/skipped_empty rows empty because the dispatcher never
 *    launched them; they are gate decisions, not jobs that ran and
 *    produced nothing, so they are tallied apart and never feed a tag
 *    bucket, even if a historical tag already exists.
 *  - Only the actionable buckets emit. 'blocked' (missing file, tool or
 *    permission) and 'unknown' (the classifier's own could-not-classify
 *    bucket) recur as repo-fixable machinery gaps; 'untagged' — a
 *    finish with no tag row at all — emits only when untagged finishes
 *    are the majority of the window's empties, the signature of a dead or
 *    starved empty-tag-sync rather than its normal per-pass deferral.
 *    A clipped jobs ledger cannot establish that majority.
 *    already_done, no_change_needed and pool_cap are explained healthy or
 *    owner-domain outcomes and never become work here.
 *  - The ledgers carry no repository dimension — they describe this
 *    fleet's own job machinery, which is this repository's machinery
 *    (empty-tag-sync, empty-final-reason, the daemon's off-tick jobs).
 *    Items therefore emit only when the backlog target's repository name
 *    is 'phantom', the same last-segment rule the sibling sources apply.
 *  - Dedup is downstream. Item ids name the closed bucket
 *    (`fleet-empty-tag-<bucket>`), never the counts, so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; shifted tallies do not spawn twin items, and a bucket that
 *    recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, example job ids are ledger-validated safe ids, and
 *    the brief tells the session which machinery owns the tag with the
 *    usual no-change escape when the window no longer reproduces.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { EMPTY_TAG_LABELS, EMPTY_TAGS } from '../fleet/empty-tags.js';
import { EMPTY_TAG_SYNC_HOURS, EMPTY_TAG_SYNC_MAX_CLASSIFY } from '../fleet/empty-tag-sync.js';
import { currentAttemptFinishes, type EmptiesFinish } from '../fleet/empty-finishes.js';
import {
  foldEmptyTags,
  readLedgerFile,
  readLedgerTail,
  ROUTER_EMPTY_TAGS_LEDGER_RELATIVE,
  ROUTER_OUTCOME_LEDGER_RELATIVE,
} from '../router/outcomes.js';

/** Items one call may emit; the actionable bucket set is closed at three. */
export const EMPTY_TAG_MAX_ITEMS = 8;
const EMPTY_TAG_ITEM_HARD_MAX = 25;
/**
 * Recorded occurrences of one bucket inside the window before it counts as
 * recurring — the fleet's RECURRING_FAILURES convention the sibling feeds
 * apply to their own tallies.
 */
export const EMPTY_TAG_RECURRING = 3;
/** The window both the sync's candidate fold and this feed anchor on. */
export const EMPTY_TAG_WINDOW_HOURS = EMPTY_TAG_SYNC_HOURS;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** The fleet's own repository label: tag evidence is this repo's machinery, never another target's. */
const FLEET_REPO = 'ashlrai/phantom';
/** Example job ids quoted per bucket inside one prompt. */
const MAX_EXAMPLES = 3;
/** The buckets that can become work; the other recorded tags are explained outcomes. */
const ACTIONABLE = ['blocked', 'unknown', 'untagged'] as const;
type ActionableBucket = (typeof ACTIONABLE)[number];

export interface EmptyTagItemsOptions {
  /** Backlog target in owner/name form; items emit only for the fleet's own repository. */
  repo: string;
  /** Runs dir holding metrics/jobs.jsonl and metrics/empty-tags.jsonl; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Injected jobs-ledger text (tests); skips the ledger read when set. */
  jobsText?: string;
  /** Injected empty-tags ledger text (tests); skips the ledger read when set. */
  tagsText?: string;
  /** Most items one call emits (default EMPTY_TAG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

/** One window's tag tally: per-tag counts, the untagged share and bounded examples. */
export interface EmptyTagWindowFold {
  /** Non-skipped empty finishes inside the window. */
  empties: number;
  /** Gate-skipped finishes (never launched) — tallied apart, never tagged work. */
  skipped: number;
  /** Recorded counts per closed tag plus 'untagged' for finishes with no tag row. */
  counts: Record<string, number>;
  /** Up to MAX_EXAMPLES job ids per actionable bucket, in finish order. */
  examples: Record<ActionableBucket, string[]>;
}

const isTag = (value: string): boolean => (EMPTY_TAGS as readonly string[]).includes(value);

/**
 * Pure: fold windowed finishes against the recorded tag map. Skipped
 * finishes leave the empty tally entirely; a finish whose tag is absent —
 * or recorded outside the closed vocabulary, which foldEmptyTags already
 * refuses — lands in 'untagged' rather than being guessed.
 */
export function foldEmptyTagWindow(
  finishes: readonly EmptiesFinish[],
  tags: ReadonlyMap<string, string>,
): EmptyTagWindowFold {
  const counts: Record<string, number> = { untagged: 0 };
  for (const tag of EMPTY_TAGS) counts[tag] = 0;
  const examples: Record<ActionableBucket, string[]> = { blocked: [], unknown: [], untagged: [] };
  let empties = 0;
  let skipped = 0;
  for (const finish of finishes) {
    if (!finish.empty) continue;
    if (finish.skipped) { skipped++; continue; }
    empties++;
    const tag = tags.get(finish.id);
    const bucket = tag !== undefined && isTag(tag) ? tag : 'untagged';
    counts[bucket] = (counts[bucket] ?? 0) + 1;
    if ((ACTIONABLE as readonly string[]).includes(bucket)) {
      const list = examples[bucket as ActionableBucket];
      if (list.length < MAX_EXAMPLES) list.push(finish.id);
    }
  }
  return { empties, skipped, counts, examples };
}

/** The recorded tally as one prompt line; every figure is a count actually folded. */
function tallyLine(fold: EmptyTagWindowFold): string {
  const tags = EMPTY_TAGS.map((tag) => `${tag}=${fold.counts[tag] ?? 0}`).join(', ');
  const skipped = fold.skipped > 0 ? ` (${fold.skipped} gate-skipped excluded)` : '';
  return `${fold.empties} empty finish(es)${skipped} in the ${EMPTY_TAG_WINDOW_HOURS}h window: ${tags}, untagged=${fold.counts['untagged'] ?? 0}.`;
}

function examplesLine(bucket: ActionableBucket, fold: EmptyTagWindowFold): string {
  const ids = fold.examples[bucket];
  return ids.length === 0 ? '' : ` Example job ids: ${ids.join(', ')}.`;
}

const NO_CHANGE = 'If the pattern no longer reproduces on the default branch — or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

function emptyTagPrompt(bucket: ActionableBucket, fold: EmptyTagWindowFold, truncated: boolean): string {
  const lead = [
    `Phantom's empty-job tag ledger shows '${bucket}' recurring across the fleet's own finished-empty jobs — the self-improvement work this backlog exists for.`,
    '',
    tallyLine(fold) + examplesLine(bucket, fold) + '.',
    ...(truncated ? ['The jobs ledger was clipped. These counts cover only the retained receipts.'] : []),
    '',
  ];
  const tagClause = bucket === 'untagged' ? '' : ` The recorded tag label is '${EMPTY_TAG_LABELS[bucket as keyof typeof EMPTY_TAG_LABELS]}'.`;
  const body: Record<ActionableBucket, string[]> = {
    blocked: [
      `The tag is written by \`phm jobs empty --record\` and the daemon's empty-tag-sync to metrics/empty-tags.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), from empty-final-reason's verdict on each job log's final lines.${tagClause}`,
      '',
      `Recurring 'blocked' means jobs keep launching into an environment or job spec that cannot succeed — the repo-rule, sign-in-failed, blocked-dependency and tool-missing shapes in src/core/fleet/empty-final-reason.ts mapped by src/core/fleet/empty-tags.ts. Find what the fleet's own code should change: a tool or path the job prompts assume but the lane lacks, a dependency the queue specs should declare, or a sign-in or permission check the launch path should run earlier. ${NO_CHANGE}`,
    ],
    unknown: [
      `The tag is written by \`phm jobs empty --record\` and the daemon's empty-tag-sync to metrics/empty-tags.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR), from empty-final-reason's verdict on each job log's final lines.${tagClause} It is the classifier's own could-not-classify bucket: the log's final lines matched no recorded empty shape, or no log was readable when the tag was written.`,
      '',
      `Recurring 'unknown' means either a new recurring empty shape the vocabulary misses — extend the rules in src/core/fleet/empty-final-reason.ts and the TAG map in src/core/fleet/empty-tags.ts — or job logs the fleet expects are absent, a runs-dir retention or naming gap. ${NO_CHANGE}`,
    ],
    untagged: [
      `These finishes carry no job.empty-tag.v1 row at all in metrics/empty-tags.jsonl under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR). The daemon's empty-tag-sync classifies at most ${EMPTY_TAG_SYNC_MAX_CLASSIFY} log tails per pass on the self-improvement cadence, so a persistent untagged majority means the sync is behind its cap, its off-tick job is not running, or the tags ledger is not being written.`,
      '',
      `The sync and its cadence live in this repository (src/core/fleet/empty-tag-sync.ts and the daemon's off-tick job table); \`phm daemon status --json\` shows the last tick's phases and \`phm jobs empty\` folds the same ledgers. If coverage is actually fine — a one-off burst the next passes drained — report no-change and name the evidence.`,
    ],
  };
  return [...lead, ...body[bucket]].join('\n');
}

function emptyTagItem(bucket: ActionableBucket, fold: EmptyTagWindowFold, repo: string, truncated: boolean): CloudBacklogItem {
  const titles: Record<ActionableBucket, string> = {
    blocked: `Fleet empty jobs keep ending 'blocked'`,
    unknown: `Fleet empty finishes stay tagged 'unknown'`,
    untagged: `Fleet empty finishes are missing recorded tags`,
  };
  return {
    id: `fleet-empty-tag-${bucket}`,
    title: titles[bucket].slice(0, MAX_TITLE_CHARS),
    prompt: emptyTagPrompt(bucket, fold, truncated),
    area: 'fleet-empty-tags',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the empty-tag ledger's recurring actionable buckets.
 * Total: any read or fold failure yields no items rather than throwing
 * into discovery.
 */
export async function emptyTagBacklogItems(opts: EmptyTagItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    const repoKey = repo.toLowerCase();
    if (repoKey !== FLEET_REPO && repoKey !== 'phantom') return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const [jobs, tags] = await Promise.all([
      opts.jobsText !== undefined
        ? Promise.resolve({ state: 'read' as const, text: opts.jobsText, truncated: false })
        : readLedgerTail(join(runsDir, ROUTER_OUTCOME_LEDGER_RELATIVE)),
      opts.tagsText !== undefined
        ? Promise.resolve({ state: 'read' as const, text: opts.tagsText })
        : readLedgerFile(join(runsDir, ROUTER_EMPTY_TAGS_LEDGER_RELATIVE)),
    ]);
    if (jobs.state !== 'read') return [];
    // 'missing' is a clean empty tags ledger — every joined empty is then
    // honestly untagged. Anything else means the job→tag join cannot be
    // trusted, so the source stays quiet rather than guessing tags.
    if (tags.state !== 'read' && tags.state !== 'missing') return [];
    const tagMap = tags.state === 'read' ? foldEmptyTags(tags.text) : new Map<string, string>();
    const finishes = currentAttemptFinishes(jobs.text, (opts.now ?? new Date()).getTime(), EMPTY_TAG_WINDOW_HOURS);
    const fold = foldEmptyTagWindow(finishes, tagMap);
    const limit = Math.max(1, Math.min(opts.limit ?? EMPTY_TAG_MAX_ITEMS, EMPTY_TAG_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    for (const bucket of ACTIONABLE) {
      if (items.length >= limit) break;
      const count = fold.counts[bucket] ?? 0;
      if (count < EMPTY_TAG_RECURRING) continue;
      // Untagged only evidences a coverage gap when it is the majority of
      // the window's empties — a small untagged share is the sync's normal
      // per-pass deferral, not a broken ledger.
      if (bucket === 'untagged' && (jobs.truncated || count * 2 <= fold.empties)) continue;
      items.push(emptyTagItem(bucket, fold, repo, jobs.truncated));
    }
    return items;
  } catch {
    return [];
  }
}
