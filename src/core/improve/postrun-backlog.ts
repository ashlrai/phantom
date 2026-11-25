/**
 * Post-run publish journal recurring evidence → self-improvement backlog items.
 *
 * dispatchd's reap step (contrib/mac/dispatchd.py, RQ-DISPATCHD-POSTRUN-PR-1)
 * spawns contrib/mac/postrun_pr.py once per finished job whose publish
 * result was RESULT EMPTY while its worktree still holds commits ahead of
 * origin/master — the lane sandbox cannot always reach gh, so the publish
 * runs outside it. Each spawn appends outcome lines to the daemon log
 * (<runs>/dispatchd.log):
 *
 *   <local-ts> POSTRUN_PR skip <job> off-switch
 *   <local-ts> POSTRUN_PR skip <job> no-job-record
 *   <local-ts> POSTRUN_PR skip <job> repo-not-allowlisted
 *   <local-ts> POSTRUN_PR skip <job> pr-lookup-failed (nothing published)
 *   <local-ts> POSTRUN_PR exists <job> <pr-url> (not republished)
 *   <local-ts> POSTRUN_PR publish <job> no PR for <fork>:codex-bridge/<job>; running publish.sh
 *   <local-ts> POSTRUN_PR error <job> publish.sh <ExceptionType>
 *   <local-ts> POSTRUN_PR published <job> <pr-url>
 *   <local-ts> POSTRUN_PR no-pr <job> <first publish RESULT tokens | no RESULT line>
 *   <local-ts> postrun_pr err <job> <ExceptionType>        (dispatchd's own spawn failure)
 *
 * The retry contract is what makes the journal worth folding. dispatchd
 * counts spawns in queue/run/<job>.postrun (MAX_ATTEMPTS = 3, ever) and
 * refuses to spawn once queue/run/<job>.postrun.json exists. The child
 * writes that sidecar on every outcome past the PR lookup — exists,
 * publish-error, published, no-pr — so a job reaches the publish step at
 * most once and any publish-step outcome is final. Skips, by contrast,
 * return before record() runs: off-switch, no-job-record,
 * repo-not-allowlisted and pr-lookup-failed each consume one spawn
 * attempt and leave no sidecar, so a job can burn its whole budget on
 * pre-publish failures and strand with its commits still unpublished.
 * dispatchd's own `postrun_pr err` lines are the same shape — the marker
 * is written before spawn(), so a spawn exception also burns an attempt.
 *
 * Until now the log's POSTRUN_PR lines had no reader at all — the tick
 * reports that scan dispatchd.log never fold them, and the only other
 * surfaces (`phm fleet republish`, `phm fleet stranded`) are
 * point-in-time reports someone had to run — so a publish path that kept
 * failing across jobs, a gh read path that kept refusing the PR lookup,
 * or jobs whose three attempts all ended before publish.sh ever ran
 * never became work. Finished commits sat unpublished in kept worktrees:
 * the publish.sh retry gap and remote publish watcher failure the
 * merge-friction arc names.
 *
 * postrunBacklogItems folds the bounded dispatchd.log tail into
 * discoverBacklog:
 *
 *  - 'exhausted' per job: three or more spawn-consuming non-terminal
 *    rows (adverse skips — pr-lookup-failed, no-job-record, unrecognized
 *    reasons — plus postrun_pr err spawn failures and orphaned publish
 *    markers whose terminal row never landed) and zero terminal rows
 *    (exists/error/published/no-pr) inside the window. Three consumed
 *    attempts is the budget; with no sidecar the job can never be
 *    spawned again. This is terminal state, not a recurrence bar.
 *    Designed skips — off-switch, repo-not-allowlisted — count as
 *    context only: an operator hold or an allowlist boundary is not
 *    machinery friction.
 *  - 'publish-error' globally, keyed by exception type: 'error' rows
 *    recurring across jobs — publish.sh's invocation itself keeps
 *    failing (timeout, OSError) fleet-wide.
 *  - 'no-pr' globally, keyed by RESULT-prefix class: 'no-pr' rows
 *    recurring across jobs — publish.sh runs to a RESULT line that is
 *    not `RESULT PR <url>`; the class separates RESULT ABORT <gate>
 *    (per-gate), RESULT EMPTY, 'no RESULT line' and other RESULT
 *    verdicts so the prompt names what keeps stopping publishes.
 *  - 'lookup-failed' globally: 'pr-lookup-failed' skips recurring —
 *    the gh PR-existence read keeps failing, so attempts burn without
 *    ever reaching publish.sh.
 *  - 'spawn-error' globally: 'postrun_pr err' lines recurring —
 *    dispatchd cannot even spawn the child.
 *  - 'record-missing' globally: 'no-job-record' skips recurring —
 *    spawns for jobs whose queue .line record is already gone.
 *  - 'skip-other' globally: skip reasons outside the writer's documented
 *    vocabulary — either postrun_pr gained a skip class this feed does
 *    not know, or the rows are malformed; folded so the drift stays
 *    visible.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. dispatchd.log is read through readLedgerTail's bounded
 *    no-follow tail; nothing is written and no network is touched.
 *    Missing, non-file or unreadable evidence yields no items.
 *  - The journal describes this install's dispatch machinery and
 *    carries no repository column, so items emit only when the
 *    backlog's repo name is the fleet's own; another repository
 *    inherits nothing.
 *  - Recurring means recorded. Global cells emit only at
 *    POSTRUN_MIN_ROWS adverse rows across POSTRUN_MIN_DAYS distinct UTC
 *    days inside the 7-day window; the 'exhausted' cell emits on its
 *    own terminal bar instead. Because a publish-step outcome is final
 *    per job, per-job publish failures can never recur — they aggregate
 *    globally by failure kind instead.
 *  - Unknown stays unknown. Malformed lines, rows without a parseable
 *    local timestamp or a valid job id, and POSTRUN_PR actions outside
 *    the writer's vocabulary are dropped by the parser; a truncated
 *    tail still yields honest lower-bound counts and says so in the
 *    prompt. An 'exhausted' verdict rests on the retained window only —
 *    a terminal row that aged out or was cut would flip it, so the
 *    prompt sends the agent to the .postrun.json sidecar and .publish
 *    RESULT line for ground truth before acting.
 *  - Dedup is downstream. Item ids hash the cell kind + repository +
 *    cell key (never the counts or timestamps), so a refresh
 *    re-derives the same id and appendUserBacklogItems adds only what
 *    is new.
 *  - Every emitted prompt keeps the evidence framing: counts are
 *    quoted only as recorded, recorded exception/result text is
 *    scrubbed, flattened and capped, and the brief names the journal,
 *    the writer and its dispatcher feeder with the usual no-change
 *    escape when the window no longer reproduces or the cause is
 *    owner-only.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { localTimestamp } from '../fleet/runs-parked-queue.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; cells sort deterministically before the cap applies. */
export const POSTRUN_MAX_ITEMS = 8;
const POSTRUN_ITEM_HARD_MAX = 25;
/** The window every fold anchors on: the fleet's recurring-evidence week. */
export const POSTRUN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Adverse rows one recurring global cell needs inside the window… */
export const POSTRUN_MIN_ROWS = 3;
/** …spread across at least this many distinct UTC days. */
export const POSTRUN_MIN_DAYS = 2;
/**
 * Bounded tail for dispatchd.log. The daemon writes tick lines
 * continuously, so the tail is wider than a quiet journal's — 8 MiB
 * matches the friction fold's dispatch-log bound; POSTRUN_PR outcomes
 * are rare enough that the window is normally covered whole, and
 * truncation is stated as a lower bound when it is not.
 */
export const POSTRUN_TAIL_BYTES = 8 * 1024 * 1024;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;
/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
const FIELD_MAX = 160;
/** Distinct recorded detail strings quoted inside one prompt before the remainder is summarized. */
const PROMPT_DETAILS_MAX = 3;
/** Job ids are dispatchd's own JID shape (contrib/mac/dispatchd.py). */
const JOB_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** postrun_pr.py MAX_ATTEMPTS: spawns per job, ever — the exhausted cell's bar. */
const POSTRUN_MAX_ATTEMPTS = 3;
/** The journal's path inside the fleet runs dir (postrun_pr.py appends dispatchd.log). */
const POSTRUN_LOG_RELATIVE = 'dispatchd.log';
/** The repository name the machinery serves; the gate matches on it. */
const FLEET_REPO_NAME = 'phantom';
/** The repository name both vocabularies record: the last path segment, lowercased. */
const fleetRepoName = (repo: string): string =>
  (repo.split('/').pop() ?? repo).trim().toLowerCase();

export type PostrunKind =
  | 'skip-off' | 'skip-no-record' | 'skip-repo' | 'skip-lookup' | 'skip-other'
  | 'exists' | 'publish' | 'error' | 'published' | 'no-pr' | 'spawn-error';

/** One validated outcome line inside the dispatchd.log tail. */
export interface PostrunRow {
  atMs: number;
  utcDay: string;
  job: string;
  kind: PostrunKind;
  /** Recorded exception type or RESULT prefix, scrubbed/flattened/capped; null when the row carries none. */
  detail: string | null;
}

export interface PostrunItemsOptions {
  /** Backlog target in owner/name form; the journal describes the fleet repo only. */
  repo: string;
  /** Log override (default: <runsDir>/dispatchd.log). */
  logPath?: string;
  /** Runs dir for the log default; $ASHLR_RUNS_DIR wins when set. */
  runsDir?: string;
  /** Home for the default runs dir (default: os.homedir()). */
  homeDir?: string;
  /** Most items one call emits (default POSTRUN_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the window (default: now). */
  now?: Date;
}

const LINE_RE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (.*)$/;
const JOB_TOKEN_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})(?:\s+(.*))?$/s;

/** Journal-recorded text is unbounded; flatten, scrub and cap before use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

/**
 * Pure: parse dispatchd.log text into validated postrun outcome rows.
 * Only lines whose timestamp parses and whose job id matches
 * dispatchd's JID shape survive; POSTRUN_PR actions outside the writer's
 * vocabulary and malformed rows are dropped — they simply never become
 * evidence. `postrun_pr err` spawn failures parse on the same timestamp
 * contract. Extra fields are ignored for forward compatibility.
 */
export function parsePostrunLog(text: string): PostrunRow[] {
  const rows: PostrunRow[] = [];
  for (const line of text.split('\n')) {
    const m = LINE_RE.exec(line.endsWith('\r') ? line.slice(0, -1) : line);
    if (m === null) continue;
    const stamp = localTimestamp(m[1]!);
    if (!Number.isFinite(stamp.ms)) continue;
    const body = m[2]!;
    let action: string;
    let rest: string;
    if (body.startsWith('POSTRUN_PR ')) {
      rest = body.slice('POSTRUN_PR '.length);
      action = rest.split(/\s+/, 1)[0]!;
      rest = rest.slice(action.length).trimStart();
    } else if (body.startsWith('postrun_pr err ')) {
      action = 'spawn-error';
      rest = body.slice('postrun_pr err '.length);
    } else {
      continue;
    }
    // Every outcome line names the job as its first token after the action.
    const jobMatch = JOB_TOKEN_RE.exec(rest);
    if (jobMatch === null || !JOB_RE.test(jobMatch[1]!)) continue;
    const job = jobMatch[1]!;
    const afterJob = (jobMatch[2] ?? '').trim();
    let kind: PostrunKind;
    let detail: string | null = null;
    if (action === 'spawn-error') {
      kind = 'spawn-error';
      detail = afterJob === '' ? null : afterJob;
    } else if (action === 'skip') {
      kind = afterJob.startsWith('off-switch') ? 'skip-off'
        : afterJob.startsWith('no-job-record') ? 'skip-no-record'
        : afterJob.startsWith('repo-not-allowlisted') ? 'skip-repo'
        : afterJob.startsWith('pr-lookup-failed') ? 'skip-lookup'
        : 'skip-other';
      if (kind === 'skip-lookup' || kind === 'skip-no-record' || kind === 'skip-other') {
        detail = afterJob === '' ? null : afterJob;
      }
    } else if (action === 'exists') kind = 'exists';
    else if (action === 'publish') kind = 'publish';
    else if (action === 'error') {
      kind = 'error';
      // `error <job> publish.sh <ExceptionType>` — the detail follows the fixed middle token.
      detail = afterJob.startsWith('publish.sh ') ? afterJob.slice('publish.sh '.length) : afterJob;
    } else if (action === 'published') kind = 'published';
    else if (action === 'no-pr') {
      kind = 'no-pr';
      detail = afterJob === '' ? null : afterJob;
    } else {
      continue;
    }
    rows.push({
      atMs: stamp.ms,
      utcDay: utcDayOf(stamp.ms),
      job,
      kind,
      detail: detail !== null && detail.trim() !== '' ? fieldText(detail) : null,
    });
  }
  return rows;
}

/** One recurring cell's adverse-row track inside the window. */
interface PostrunTrack {
  rows: number;
  days: Set<string>;
  firstMs: number;
  lastMs: number;
  /** Deduped bounded detail strings, for prompt evidence. */
  details: string[];
  /** Distinct jobs behind a global cell. */
  jobs: Set<string>;
}

/**
 * firstMs/lastMs start at the infinities so the first tracked row seeds
 * both; empty tracks never reach a prompt (meetsBar requires rows).
 */
const newTrack = (): PostrunTrack => ({
  rows: 0,
  days: new Set(),
  firstMs: Number.POSITIVE_INFINITY,
  lastMs: Number.NEGATIVE_INFINITY,
  details: [],
  jobs: new Set(),
});

function trackRow(track: PostrunTrack, row: PostrunRow): void {
  track.rows += 1;
  track.days.add(row.utcDay);
  track.firstMs = Math.min(track.firstMs, row.atMs);
  track.lastMs = Math.max(track.lastMs, row.atMs);
  track.jobs.add(row.job);
  if (row.detail !== null) {
    const text = fieldText(row.detail);
    if (text !== '' && !track.details.includes(text) && track.details.length < PROMPT_DETAILS_MAX) {
      track.details.push(text);
    }
  }
}

/** Per-job spawn-consumption accounting for the exhausted cell. */
interface AttemptTally {
  /** Adverse pre-publish skips: pr-lookup-failed, no-job-record, unrecognized reasons. */
  adverseSkips: number;
  /** dispatchd's own spawn failures (`postrun_pr err`). */
  spawnErrors: number;
  /** 'publish' markers — each pairs with one error/published/no-pr terminal. */
  publish: number;
  /** Terminal rows: each writes the .postrun.json sidecar that ends retries. */
  published: number;
  exists: number;
  error: number;
  noPr: number;
}

const newTally = (): AttemptTally => ({
  adverseSkips: 0, spawnErrors: 0, publish: 0,
  published: 0, exists: 0, error: 0, noPr: 0,
});

/** The fold's output: per-job cells, global cells keyed by failure kind. */
export interface PostrunFold {
  /** job → spawn-consumption tally for the exhausted cell. */
  attempts: Map<string, AttemptTally>;
  /** exception type → recurring 'error' rows (publish.sh invocation failures). */
  publishError: Map<string, PostrunTrack>;
  /** RESULT-prefix class → recurring 'no-pr' rows (publish ran, no PR resulted). */
  noPr: Map<string, PostrunTrack>;
  /** 'pr-lookup-failed' skips across all jobs — the gh read path itself. */
  lookupFailed: PostrunTrack;
  /** 'no-job-record' skips across all jobs — spawned for jobs with no queue line. */
  recordMissing: PostrunTrack;
  /** 'postrun_pr err' spawn failures across all jobs — the child never ran. */
  spawnError: PostrunTrack;
  /** Skip reasons outside the writer's vocabulary — contract drift stays visible. */
  skipOther: PostrunTrack;
}

const newFold = (): PostrunFold => ({
  attempts: new Map(),
  publishError: new Map(),
  noPr: new Map(),
  lookupFailed: newTrack(),
  recordMissing: newTrack(),
  spawnError: newTrack(),
  skipOther: newTrack(),
});

const tally = (fold: PostrunFold, job: string): AttemptTally => {
  let t = fold.attempts.get(job);
  if (t === undefined) {
    t = newTally();
    fold.attempts.set(job, t);
  }
  return t;
};

const keyed = (map: Map<string, PostrunTrack>, key: string): PostrunTrack => {
  let track = map.get(key);
  if (track === undefined) {
    track = newTrack();
    map.set(key, track);
  }
  return track;
};

/**
 * The 'no-pr' detail is the publish RESULT line's first tokens (or 'no
 * RESULT line'). The class separates the recurring causes so each cell
 * names what keeps stopping publishes: RESULT ABORT <gate> per gate,
 * RESULT EMPTY, a missing RESULT, and any other RESULT verdict.
 */
export function noPrClass(detail: string | null): string {
  const d = (detail ?? 'no RESULT line').trim();
  const abort = /^RESULT ABORT\b(?:\s+(\S+))?/.exec(d);
  if (abort !== null) return abort[1] === undefined ? 'abort' : `abort-${abort[1].toLowerCase()}`;
  if (/^RESULT EMPTY\b/.test(d)) return 'empty';
  if (d === 'no RESULT line' || d === 'none') return 'no-result';
  if (/^RESULT \S/.test(d)) return 'other-result';
  return 'unclassified';
}

/**
 * Pure: fold validated rows into the adverse cells. Rows outside the
 * window contribute nothing. Designed outcomes — 'skip-off',
 * 'skip-repo', 'exists', 'published' — never fold into a cell; 'publish'
 * markers and terminal rows feed only the per-job exhaustion tally.
 */
export function foldPostrunRows(
  rows: readonly PostrunRow[],
  nowMs: number,
  windowMs: number = POSTRUN_WINDOW_MS,
): PostrunFold {
  const fold = newFold();
  const windowStart = nowMs - windowMs;
  for (const row of rows) {
    if (row.atMs < windowStart) continue;
    const t = tally(fold, row.job);
    switch (row.kind) {
      case 'publish': t.publish += 1; break;
      case 'published': t.published += 1; break;
      case 'exists': t.exists += 1; break;
      case 'error':
        t.error += 1;
        trackRow(keyed(fold.publishError, (row.detail ?? 'unknown').toLowerCase()), row);
        break;
      case 'no-pr':
        t.noPr += 1;
        trackRow(keyed(fold.noPr, noPrClass(row.detail)), row);
        break;
      case 'skip-lookup': t.adverseSkips += 1; trackRow(fold.lookupFailed, row); break;
      case 'skip-no-record': t.adverseSkips += 1; trackRow(fold.recordMissing, row); break;
      case 'skip-other': t.adverseSkips += 1; trackRow(fold.skipOther, row); break;
      case 'spawn-error': t.spawnErrors += 1; trackRow(fold.spawnError, row); break;
      case 'skip-off':
      case 'skip-repo': break;
    }
  }
  return fold;
}

const WINDOW_DAYS = Math.round(POSTRUN_WINDOW_MS / 86_400_000);
const daySpan = (first: number, last: number): number =>
  Math.max(1, Math.round((last - first) / 86_400_000));

const NO_CHANGE = 'If the window has rolled forward, the job published or was recovered since, or the cause is owner-only (credentials, billing, a protected gate or sandbox profile) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is dispatchd.log under the fleet runs directory (~/.ashlr-runs or $ASHLR_RUNS_DIR): `POSTRUN_PR <action> <job>` lines contrib/mac/postrun_pr.py appends per spawned publish — dispatchd\'s reap step (contrib/mac/dispatchd.py, RQ-DISPATCHD-POSTRUN-PR-1) spawns it once per finished RESULT EMPTY job whose worktree is ahead of origin/master, counting spawns in queue/run/<job>.postrun up to three ever — plus `postrun_pr err` spawn failures from dispatchd itself. The child writes queue/run/<job>.postrun.json on every outcome past the PR lookup, so a publish-step result is final for the job while skips and spawn failures burn attempts silently. Until now no reader folded the POSTRUN_PR outcomes.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' The dispatchd.log tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const spanText = (track: PostrunTrack): string =>
  `first ${new Date(track.firstMs).toISOString()}, last ${new Date(track.lastMs).toISOString()}`;

const detailsText = (track: PostrunTrack): string =>
  track.details.length === 0
    ? ''
    : ` Recorded detail(s): ${track.details.map((d) => `'${d}'`).join(', ')}.`;

const meetsBar = (track: PostrunTrack): boolean =>
  track.rows >= POSTRUN_MIN_ROWS && track.days.size >= POSTRUN_MIN_DAYS;

/** Cells sorted by recorded rows then key — deterministic across refreshes. */
function sortedCells(map: Map<string, PostrunTrack>): Array<{ key: string; track: PostrunTrack }> {
  return [...map.entries()]
    .map(([key, track]) => ({ key, track }))
    .sort((a, b) => b.track.rows - a.track.rows || a.key.localeCompare(b.key));
}

/**
 * Spawn-consuming rows that never reached a terminal outcome: adverse
 * skips, dispatchd spawn failures, and publish markers whose terminal
 * row never landed (the child died mid-publish or is still in flight —
 * either way the attempt is spent).
 */
const consumedNonTerminal = (t: AttemptTally): number =>
  t.adverseSkips + t.spawnErrors + Math.max(0, t.publish - (t.published + t.error + t.noPr));

const hasTerminal = (t: AttemptTally): boolean =>
  t.published + t.exists + t.error + t.noPr > 0;

function exhaustedPrompt(job: string, t: AttemptTally, truncated: boolean): string {
  const consumed = consumedNonTerminal(t);
  const orphans = Math.max(0, t.publish - (t.published + t.error + t.noPr));
  return [
    `The post-run publisher exhausted its retries for job ${job} — every recorded spawn ended before publish.sh produced a pull request, and the spawn budget (three attempts, ever) is spent.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${consumed} spawn-consuming non-terminal row(s) for ${job} — ${t.adverseSkips} adverse skip(s), ${t.spawnErrors} spawn failure(s), ${orphans} orphaned publish marker(s) — and no terminal outcome (exists, publish-error, published or no-pr). At ${POSTRUN_MAX_ATTEMPTS} consumed attempts dispatchd will not spawn postrun_pr.py for ${job} again unless queue/run/${job}.postrun.json exists; with none recorded, the job's commits stay unpublished in its kept worktree.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The job finished RESULT EMPTY with commits ahead of origin/master, so its work exists only in the kept worktree — unpublished means unmerged. Verify ground truth first: queue/run/${job}.postrun.json records the terminal action when one landed, ${job}.publish holds publish.sh's own RESULT line, and queue/run/${job}.postrun counts the spawns — a terminal row that aged out of this window would make this a false positive, so confirm the sidecar is absent before acting. If the work is still needed, recover it through the normal path — phm fleet republish plans cherry-pick recovery for publish aborts, phm fleet stranded lists kept worktrees whose publish never produced a PR — or re-run the job if the cause is fixed. If the job already published, was superseded, or its sidecar exists — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function publishErrorPrompt(kind: string, track: PostrunTrack, truncated: boolean): string {
  return [
    `The post-run publisher keeps failing to invoke publish.sh across jobs — '${kind}' is the recurring exception.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${track.rows} 'error' outcome(s) of this kind across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.jobs.size} distinct job(s).${detailsText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'error' row means postrun_pr.py reached the publish step but the publish.sh invocation itself threw — the recorded exception type is the spawn/run failure, so no RESULT line exists for that attempt and each affected job's single publish-step outcome is spent. Because a publish-step outcome is final per job, recurrence across many jobs points at the shared path, not any one diff: publish.sh hanging past PUBLISH_TIMEOUT_S (900s) on a fetch or gate, an OSError spawning bash on the host, or resource exhaustion while many reap children run at once. Check queue/run/<job>.postrun.json's error field and <job>.publish for a truncated or missing RESULT on the named jobs, and whether sibling publish.sh runs outside postrun are failing the same way. If recent attempts published cleanly — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function noPrPrompt(kind: string, track: PostrunTrack, truncated: boolean): string {
  return [
    `The post-run publisher runs publish.sh across jobs but no pull request results — '${kind}' is the recurring RESULT class.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${track.rows} 'no-pr' outcome(s) of this class across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.jobs.size} distinct job(s).${detailsText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    kind.startsWith('abort-')
      ? `Each 'no-pr' row means publish.sh ran to a RESULT line that was not \`RESULT PR <url>\`, and the recorded detail's class is RESULT ABORT — the safety gate named in the detail stopped the publish (secret-shape, git-unsafe, g1, fork-target, dependency-link). The gate is doing its job; the recurring question is whether the jobs' diffs genuinely trip it or the gate false-positives on a pattern the fleet keeps producing. Read <job>.publish on the named jobs for the full RESULT line and the gate's own evidence, and check whether the same gate is aborting non-postrun publishes too — a gate_stop cause is owner-adjacent, so verify before proposing work.`
      : kind === 'empty'
        ? `Each 'no-pr' row means publish.sh ran to \`RESULT EMPTY\` — it still found nothing publishable for the job even though dispatchd's reap step saw commits ahead of origin/master. That disagreement is the signal: either the worktree's commits never reached the branch publish.sh pushes (a ref or checkout mismatch between reap's check and publish.sh's), or publish.sh's own emptiness test reads different state. Compare queue/run/<job>.postrun.json's recorded result prefix with <job>.publish's full RESULT line on the named jobs.`
        : kind === 'no-result'
          ? `Each 'no-pr' row means publish.sh ended without writing any RESULT line — the run was killed, timed out silently, or crashed before its verdict. Check <job>.publish for truncation and dispatchd.log around the timestamps for a killed or overlapping publish; PUBLISH_TIMEOUT_S is 900s and a timeout inside publish.sh may not always leave a RESULT.`
          : `Each 'no-pr' row means publish.sh ran to a RESULT line that was not \`RESULT PR <url>\`; the recorded detail carries the RESULT prefix. Read <job>.publish on the named jobs for the full line and classify what keeps stopping publishes.`,
    ` If the jobs published or were recovered since — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function lookupFailedPrompt(track: PostrunTrack, truncated: boolean): string {
  return [
    `The post-run publisher's GitHub PR-existence lookup keeps failing — spawned publishes skip before ever reaching publish.sh.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${track.rows} 'pr-lookup-failed' skip(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.jobs.size} distinct job(s).${detailsText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'pr-lookup-failed' skip means postrun_pr.py's \`gh api repos/ashlrai/<repo>/pulls?head=...\` read failed or timed out, so it refused to publish (fail closed — a failed lookup never publishes blind) and the spawn attempt is spent. Because skips leave no .postrun.json sidecar, a job retries until its three spawns are gone — recurring lookup failures across jobs burn budgets silently and strand finished work. Recurrence points at the gh read path itself — authentication, token scope, rate limits, or gh/network health on the host — not at any one pull request. Check \`gh auth status\`, the rate-limit budget and sibling gh reads in the same window. If lookups recovered — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function spawnErrorPrompt(track: PostrunTrack, truncated: boolean): string {
  return [
    `dispatchd cannot spawn the post-run publisher — finished RESULT EMPTY jobs with unpushed commits never get a publish attempt.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${track.rows} 'postrun_pr err' spawn failure(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.jobs.size} distinct job(s).${detailsText(track)}${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'postrun_pr err' row is dispatchd's own exception around the spawn call — the marker was already written, so the attempt counts toward the job's three-spawn budget, but the child never ran and no POSTRUN_PR outcome line exists for it. Recurring spawn failures point at the host: a missing or unreadable bin/postrun_pr.py after an install, resource exhaustion at spawn time, or the worktree/git-safe checks inside postrun_pr_start raising. Check fleet/sync or contrib/mac/install state for postrun_pr.py, dispatchd's stderr for the exception type, and whether sibling spawns are also failing. If spawns recovered — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function recordMissingPrompt(track: PostrunTrack, truncated: boolean): string {
  return [
    `The post-run publisher keeps spawning for jobs whose queue record is already gone — reap is chasing work it cannot identify.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${track.rows} 'no-job-record' skip(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.jobs.size} distinct job(s).${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Each 'no-job-record' skip means postrun_pr.py could not read queue/run/<job>.line — the second tab field names the repo — so it refused before any gh or publish call. dispatchd only spawns the child for jobs its own base() record still resolves, so recurring skips mean the .line file vanished between reap's check and the child's read, or the run directory is being cleaned while finished worktrees remain. Each skip still burns one of the job's three spawn attempts. Find what removes .line records early (worktree reapers, queue compaction, manual cleanup) and whether kept worktrees are being orphaned from their job records. If the skips stopped — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

function skipOtherPrompt(track: PostrunTrack, truncated: boolean): string {
  const reasons = track.details.slice(0, PROMPT_DETAILS_MAX).map((d) => `'${d}'`).join(', ');
  const reasonBit = reasons === '' ? 'with no recorded reason' : `with recorded reason(s) ${reasons}`;
  return [
    `The post-run publisher logged skip outcomes outside its documented vocabulary — either the writer gained a skip class this feed does not know, or the rows are malformed.`,
    '',
    `Inside the ${WINDOW_DAYS}-day dispatchd.log window the ledger recorded ${track.rows} unrecognized 'POSTRUN_PR skip' row(s) across ${track.days.size} distinct UTC day(s) (${daySpan(track.firstMs, track.lastMs)}-day span, ${spanText(track)}), spanning ${track.jobs.size} distinct job(s), ${reasonBit}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `The writer's documented skip reasons are off-switch, no-job-record, repo-not-allowlisted and pr-lookup-failed; anything else means contrib/mac/postrun_pr.py changed (a new skip class worth folding here) or dispatchd.log lines are being written by something else. Read the recorded lines in dispatchd.log, diff postrun_pr.py against its staged copy under contrib/mac/staged/, and update this feed's vocabulary or the writer — never let an unrecognized outcome silently bypass the fold. If the rows stop — report no-change and name the evidence. ${NO_CHANGE}`,
  ].join('\n');
}

/**
 * Backlog items for the post-run publish journal's recurring adverse
 * evidence, in a fixed cell order. Total: any read or fold failure
 * yields no items rather than throwing into discovery.
 */
export async function postrunBacklogItems(opts: PostrunItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (repo === '' || fleetRepoName(repo) !== FLEET_REPO_NAME) return [];
    const home = opts.homeDir ?? homedir();
    const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(home, '.ashlr-runs');
    const logPath = opts.logPath ?? join(runsDir, POSTRUN_LOG_RELATIVE);
    const tail = await readLedgerTail(logPath, POSTRUN_TAIL_BYTES);
    if (tail.state !== 'read') return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    const fold = foldPostrunRows(parsePostrunLog(tail.text), nowMs);
    const limit = Math.max(1, Math.min(opts.limit ?? POSTRUN_MAX_ITEMS, POSTRUN_ITEM_HARD_MAX));
    const items: CloudBacklogItem[] = [];
    const push = (cell: string, key: string, title: string, prompt: string): void => {
      if (items.length >= limit) return;
      const hash = createHash('sha256').update(`postrun:${cell}:${repo.trim().toLowerCase()}:${key}`).digest('hex').slice(0, 16);
      items.push({
        id: `postrun-${cell}-${hash}`,
        title: title.slice(0, MAX_TITLE_CHARS),
        prompt,
        area: 'postrun-publish',
        priority: 3,
        ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
      });
    };

    // Terminal stranded state first: the spawn budget is spent with no
    // publish-step outcome on record.
    const exhausted = [...fold.attempts.entries()]
      .filter(([, t]) => consumedNonTerminal(t) >= POSTRUN_MAX_ATTEMPTS && !hasTerminal(t))
      .sort(([a], [b]) => a.localeCompare(b));
    for (const [job, t] of exhausted) {
      push('exhausted', job, `Post-run publish exhausted for job ${job}: all recorded spawns failed pre-publish`, exhaustedPrompt(job, t, tail.truncated));
    }
    for (const { key, track } of sortedCells(fold.publishError)) {
      if (!meetsBar(track)) continue;
      push('publish-error', key, `Post-run publish keeps failing publish.sh (${key}) across jobs`, publishErrorPrompt(key, track, tail.truncated));
    }
    for (const { key, track } of sortedCells(fold.noPr)) {
      if (!meetsBar(track)) continue;
      push('no-pr', key, `Post-run publish runs but no PR results (${key}) across jobs`, noPrPrompt(key, track, tail.truncated));
    }
    if (meetsBar(fold.spawnError)) push('spawn-error', 'all', 'Post-run publisher cannot be spawned by dispatchd', spawnErrorPrompt(fold.spawnError, tail.truncated));
    if (meetsBar(fold.lookupFailed)) push('lookup-failed', 'all', 'Post-run publisher\'s GitHub PR lookup keeps failing', lookupFailedPrompt(fold.lookupFailed, tail.truncated));
    if (meetsBar(fold.recordMissing)) push('record-missing', 'all', 'Post-run publisher spawns for jobs with no queue record', recordMissingPrompt(fold.recordMissing, tail.truncated));
    if (meetsBar(fold.skipOther)) push('skip-other', 'all', 'Post-run publisher logged unrecognized skip outcomes', skipOtherPrompt(fold.skipOther, tail.truncated));
    return items;
  } catch {
    return [];
  }
}
