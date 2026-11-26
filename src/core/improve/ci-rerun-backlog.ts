/**
 * CI rerun journal verdict and call failures → self-improvement backlog items.
 *
 * The daemon's ci-rerun pass (runCiRerunMaintenance, the off-tick job the
 * resident loop launches when ciRerun.repos is configured) journals every
 * probable-flake rerun to <ashlrHome>/ci-reruns/journal.jsonl: an `attempt`
 * row before each `gh run rerun --failed` call, an `ok`/`failed` row for the
 * call's result, and a `verdict` row (pass/fail/inconclusive) once the
 * rerun's workflow run resolves. Two evidence kinds in that journal never
 * became work:
 *
 *  - A test whose reruns keep concluding `fail`: the CI baseline analyzer
 *    classified it probable-flake — failing on an open PR while passing on
 *    master — yet the rerun proves the failure is not a flake. Recurring
 *    fail verdicts mean either the analyzer's touched/dependency grouping
 *    is mislabeling a real failure as flake (it keeps burning the rerun
 *    budget and the real breakage never gets a fix path) or the test is
 *    broken in a way no rerun resolves. The journal's recurring-flake fold
 *    already turns tests that keep flaking into RQ-CIFLAKE-* queue rows;
 *    this feed covers the other side of the same journal — tests whose
 *    "flakes" keep failing and rerun calls that keep erroring.
 *  - A repository whose `gh run rerun` calls keep erroring: `failed`
 *    outcome rows are the subprocess result, so a majority of failed calls
 *    inside the window means the rerun machinery itself is degraded —
 *    auth, API, repo Actions settings or the off-tick deadline — and every
 *    probable-flake group waits on a loop that cannot fire.
 *
 * Until now both only ever reached `phm ci reruns --json`, a report
 * someone had to run and read, and ci-reruns/status.json inside
 * `phm daemon status`. ciRerunBacklogItems carries the same journal into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the fleet outcome-learning, nightly
 * retro, policy, local-gate, pass^k, friction, tick-health, cross-review,
 * empty-tag and post-merge sources beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. The journal is read through readCiReruns' bounded tail
 *    (the last 4 MiB, malformed rows skipped); nothing is written and no
 *    network is touched.
 *  - Missing or unreadable evidence yields no items. An absent journal
 *    reads as an empty entry list — no verdicts, no call failures, no
 *    items — and rows the reader cannot validate never reach the fold.
 *  - Repo matching is exact owner/repo, case-insensitive: journal rows
 *    carry the owner/name the maintenance pass was configured with and
 *    the backlog addresses owner/name, so evidence recorded against a
 *    different repository never lands on this one.
 *  - Recurring means recorded. A verdict group emits only at
 *    CI_RERUN_FAIL_RECURRING fail verdicts spanning at least two distinct
 *    heads inside the journal's own recurrence window
 *    (RECURRING_FLAKE_WINDOW_MS — the same 7 days the flake fold uses), so
 *    one PR's stubborn failure and a single unlucky rerun never queue a
 *    session. A call-failure item emits only when failed calls reach
 *    CI_RERUN_CALLFAIL_RECURRING and outnumber the window's ok calls —
 *    transient errors that the loop mostly recovers from stay quiet.
 *  - Unknown stays unknown. Verdict rows written before the test field
 *    existed cannot be attributed to a test and never emit; ok/failed
 *    rows without a paired attempt still count toward the call tally
 *    because they are recorded call results either way.
 *  - Dedup is downstream. Item ids hash the group identity (kind + repo +
 *    test, or kind + repo — never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what is
 *    new; a group that recovers simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, the test id is scrubbed and flattened to one line,
 *    head SHAs are shortened, and the brief names the journal, the
 *    `phm ci reruns`/`phm ci baseline` commands and the machinery modules
 *    with the usual no-change escape when the window no longer reproduces
 *    or the cause is owner-only.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readCiReruns } from '../fleet/ci-rerun.js';
import { JOURNAL_TEST_MAX, RECURRING_FLAKE_WINDOW_MS } from '../fleet/ci-flakes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; verdict groups are bounded by the journal's own test diversity. */
export const CI_RERUN_MAX_ITEMS = 8;
const CI_RERUN_ITEM_HARD_MAX = 25;
/**
 * Fail verdicts one (repo, test) needs inside the window before the
 * probable-flake classification counts as recurring evidence — the
 * fleet's RECURRING_FAILURES convention applied to rerun outcomes.
 */
export const CI_RERUN_FAIL_RECURRING = 3;
/**
 * Failed `gh run rerun` calls one repo needs inside the window before the
 * rerun machinery counts as degraded — and they must outnumber the
 * window's ok calls, so a mostly-working loop's transient errors stay
 * quiet.
 */
export const CI_RERUN_CALLFAIL_RECURRING = 3;
/** The window both folds anchor on: the journal's own flake recurrence window. */
export const CI_RERUN_WINDOW_MS = RECURRING_FLAKE_WINDOW_MS;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Test-id characters named inside one title before the remainder is elided. */
const TITLE_TEST_MAX = 120;
/** Heads named inside one item prompt before the count is summarized. */
const PROMPT_HEADS_MAX = 5;
/** Repo path of the rerun journal inside the Phantom state dir (ci-rerun.ts appends it). */
const CI_RERUN_JOURNAL_RELATIVE = join('ci-reruns', 'journal.jsonl');

export interface CiRerunItemsOptions {
  /** Backlog target in owner/name form; journal rows must name the same repository. */
  repo: string;
  /** Rerun journal override (default: <ashlrHome>/ci-reruns/journal.jsonl). */
  journalPath?: string;
  /** Most items one call emits (default CI_RERUN_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

type RerunEntry = ReturnType<typeof readCiReruns>['entries'][number];

/** Journal-recorded test ids are unbounded text; flatten, scrub and cap before use. */
function fieldText(value: string, max: number): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const inWindow = (entry: RerunEntry, nowMs: number, windowMs: number): boolean => {
  const at = Date.parse(entry.at);
  return Number.isFinite(at) && at >= nowMs - windowMs && at <= nowMs;
};

interface VerdictGroup {
  test: string;
  /** `verdict: fail` rows inside the window — the recurring signal. */
  fails: number;
  /** `verdict: pass`/`inconclusive` rows inside the window, for prompt context. */
  passes: number;
  inconclusive: number;
  /** Distinct head SHAs the fail verdicts landed on. */
  failHeads: Set<string>;
  /** `attempt` rows recorded for the same test inside the window (may be 0 after a tail cut). */
  attempts: number;
}

const NO_CHANGE = 'If the window has rolled forward, the test or repository changed, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is ci-reruns/journal.jsonl under the Phantom state directory (~/.ashlr or $ASHLR_HOME), written by the resident ci-rerun maintenance pass; `phm ci reruns --json` folds the same journal (attempt, ok/failed and verdict tallies, pending count, resolution rate) and `phm ci baseline --repo <repo> --json` is the analyzer whose probable-flake classifications drive the reruns (the machinery lives in the Phantom repository: src/core/fleet/ci-baseline.ts, ci-flakes.ts and ci-rerun.ts).';

function verdictPrompt(group: VerdictGroup, repo: string): string {
  const test = fieldText(group.test, JOURNAL_TEST_MAX);
  const heads = [...group.failHeads].sort();
  const shown = heads.slice(0, PROMPT_HEADS_MAX);
  const headList = shown.map((head) => head.slice(0, 12)).join(', ')
    + (heads.length > shown.length ? `, and ${heads.length - shown.length} more` : '');
  const verdicts = `Recorded rerun verdicts inside the ${Math.round(CI_RERUN_WINDOW_MS / 86_400_000)}-day window: ${group.fails} failed, ${group.passes} passed, ${group.inconclusive} inconclusive.`
    + (group.attempts > 0 ? ` ${group.attempts} rerun attempt rows were recorded for the same test.` : '');
  return [
    `Phantom's CI rerun journal shows test '${test}' on ${repo} keeps failing its reruns — the probable-flake classification is not holding, the self-improvement work this backlog exists for.`,
    '',
    `The CI baseline analyzer classified it probable-flake — failing on an open PR while passing on master — but ${group.fails} recorded rerun verdicts concluded failure across ${heads.length} distinct head(s) (${headList}). ${verdicts}`,
    '',
    EVIDENCE,
    '',
    `Find out which side is wrong: reproduce the test on this repository's master and on a failing PR head. If the failure is real — a regression or broken test the flake heuristic masked — fix the underlying cause; check the analyzer's touched/dependency grouping in ci-baseline.ts if the same test keeps being misclassified. If the test is genuinely flaky but mostly failing, make it deterministic or quarantine it behind an explicit skip. Never weaken the assertion, delete coverage, or edit Security GATES v3 files. Run the affected suite. If an open RQ-CIFLAKE-* stabilization row for this test already sits in the fleet router queue, the fleet queue owns that work — report no-change. ${NO_CHANGE}`,
  ].join('\n');
}

function verdictItem(group: VerdictGroup, repo: string): CloudBacklogItem {
  const test = fieldText(group.test, JOURNAL_TEST_MAX);
  const displayTest = test.length > TITLE_TEST_MAX ? `${test.slice(0, TITLE_TEST_MAX - 1)}…` : test;
  const id = `ci-rerun-verdict-${createHash('sha256').update(`ci-verdict:${repo.toLowerCase()}:${group.test}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `Probable-flake '${displayTest}' keeps failing reruns on ${repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: verdictPrompt(group, repo),
    area: 'ci-rerun',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

function callPrompt(failed: number, ok: number, repo: string): string {
  return [
    `Phantom's resident ci-rerun maintenance keeps failing to fire \`gh run rerun --failed\` for ${repo} — the probable-flake rerun loop cannot do its job while the calls error.`,
    '',
    `Inside the ${Math.round(CI_RERUN_WINDOW_MS / 86_400_000)}-day journal window the loop recorded ${failed} failed rerun call(s) against ${ok} successful one(s) for this repository.`,
    '',
    EVIDENCE,
    '',
    `Find why the calls fail: gh authentication or version on the host, the repository's Actions permissions, the ci-rerun off-tick job's deadline in the daemon loop, or a GitHub-side outage window — ci-reruns/status.json (shown by \`phm daemon status --json\` as .ciReruns) carries the last pass's per-repo errors and queue-blocked reason. If the failures were a transient window that no longer reproduces — recent calls succeed — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function callItem(failed: number, ok: number, repo: string): CloudBacklogItem {
  const id = `ci-rerun-calls-${createHash('sha256').update(`ci-calls:${repo.toLowerCase()}`).digest('hex').slice(0, 16)}`;
  return {
    id,
    title: `CI rerun calls keep failing on ${repo}`.slice(0, MAX_TITLE_CHARS),
    prompt: callPrompt(failed, ok, repo),
    area: 'ci-rerun',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the CI rerun journal's recurring fail verdicts and
 * call failures on `repo`. Total: any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function ciRerunBacklogItems(opts: CiRerunItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const repoKey = repo.toLowerCase();
    const nowMs = (opts.now ?? new Date()).getTime();
    const windowMs = CI_RERUN_WINDOW_MS;
    const journalPath = opts.journalPath ?? join(ashlrHome(), CI_RERUN_JOURNAL_RELATIVE);
    const { entries } = readCiReruns(journalPath, nowMs);

    // Every folded row names the target repo (case-insensitive), so test
    // alone keys a verdict group and the call tally is a single pair.
    const verdicts = new Map<string, VerdictGroup>();
    const attempts = new Map<string, number>();
    let callFailed = 0;
    let callOk = 0;
    for (const entry of entries) {
      if (typeof entry.repo !== 'string' || entry.repo.toLowerCase() !== repoKey) continue;
      if (!inWindow(entry, nowMs, windowMs)) continue;
      if (entry.outcome === 'ok') { callOk += 1; continue; }
      if (entry.outcome === 'failed') { callFailed += 1; continue; }
      if (entry.outcome === 'attempt') {
        const tests = Array.isArray(entry.tests) ? entry.tests : [entry.test];
        for (const test of new Set(tests)) {
          if (typeof test !== 'string' || !test || test.length > JOURNAL_TEST_MAX) continue;
          attempts.set(test, (attempts.get(test) ?? 0) + 1);
        }
        continue;
      }
      if (entry.outcome !== 'verdict' || typeof entry.test !== 'string' || !entry.test) continue;
      const group = verdicts.get(entry.test) ?? { test: entry.test, fails: 0, passes: 0, inconclusive: 0, failHeads: new Set<string>(), attempts: 0 };
      if (entry.verdict === 'fail') {
        group.fails += 1;
        if (typeof entry.head === 'string' && entry.head !== '') group.failHeads.add(entry.head);
      } else if (entry.verdict === 'pass') group.passes += 1;
      else if (entry.verdict === 'inconclusive') group.inconclusive += 1;
      verdicts.set(entry.test, group);
    }
    for (const group of verdicts.values()) group.attempts = attempts.get(group.test) ?? 0;

    const candidates: CloudBacklogItem[] = [];
    // The call tally gates the whole loop, so its item survives limit truncation first.
    if (callFailed >= CI_RERUN_CALLFAIL_RECURRING && callFailed > callOk) candidates.push(callItem(callFailed, callOk, repo));
    const recurring = [...verdicts.values()]
      .filter((group) => group.fails >= CI_RERUN_FAIL_RECURRING && group.failHeads.size >= 2)
      .sort((a, b) => b.fails - a.fails || a.test.localeCompare(b.test));
    for (const group of recurring) candidates.push(verdictItem(group, repo));

    const limit = Math.max(1, Math.min(opts.limit ?? CI_RERUN_MAX_ITEMS, CI_RERUN_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
