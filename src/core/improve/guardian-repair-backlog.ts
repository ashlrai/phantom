/**
 * Main-guardian repair ledger recurring stalled and slow repairs →
 * self-improvement backlog items.
 *
 * The ops-side main guardian (docs/main-guardian.md) keeps every fleet
 * repo's default branch green after merge: when a PR lands it enqueues a
 * FIXUP-MAIN repair, and the guardian loop appends one
 * {"event":"enqueue","kind":"FIXUP-MAIN","job","repo","at"} row per
 * repair to guardian.jsonl while the finish side appends
 * {"event":"finish","job","at"} rows to jobs-finished.jsonl — both under
 * the Ashlr home ($ASHLR_HOME or ~/.ashlr). `phm fleet main-repair-time
 * --json` (src/cli/fleet-main-repair-time.ts) is the only reader: it
 * joins the two ledgers per job id and prints each repair's status —
 * finished, open or unknown — and elapsed minutes. A report someone had
 * to run and read; nothing folded the recurring cells back into
 * discovery.
 *
 * Two adverse cells in that pairing never became work:
 *
 *  - Stalled repairs: a FIXUP-MAIN enqueue with no finish row once the
 *    repair is at least GUARDIAN_REPAIR_STALLED_MS old. Post-merge
 *    verification and repair jobs carry their own watchdogs, so a repair
 *    still open most of a day later is almost certainly dropped — the
 *    job never launched, died before its finish row, or the finish
 *    ledger stopped recording — and the repo's default branch sits
 *    unverified or red with no fleet trace beyond the enqueue.
 *  - Slow repairs: a recorded enqueue→finish span of at least
 *    GUARDIAN_REPAIR_SLOW_MS inside the evidence window. Verification
 *    should conclude inside a CI window; a repair taking most of a day
 *    means queue starvation, lane ill-health, retry loops or a job too
 *    broad for its tier — and the repo stays unverified for the
 *    duration.
 *
 * guardianRepairBacklogItems carries the same pairing into
 * discoverBacklog, so `phm improve discover` and the scheduler's
 * autoDiscover queue it exactly like the sibling fleet-evidence sources
 * beside it.
 *
 * Honesty rules, same as every other backlog source:
 *  - Read-only. Both ledgers are read once each through readLedgerTail's
 *    bounded no-follow tail; nothing is written and no network is
 *    touched. A missing or unreadable guardian ledger yields no items.
 *  - The finish ledger gates everything. Without a readable
 *    jobs-finished.jsonl a missing finish row cannot be told from a
 *    finish the ledger never recorded, so BOTH cells stay silent — an
 *    absent or unreadable finish ledger is unknown, never zero stalled
 *    repairs.
 *  - The pairing is the report's own: first enqueue row per job id
 *    wins, earliest finish row per job id wins (reruns do not move it),
 *    job ids match exactly, and repo matching is exact owner/name
 *    case-insensitive. Rows outside the documented dialect — other
 *    event names, other kinds, missing or unparseable fields — are
 *    skipped, never guessed.
 *  - Recurring means recorded: a cell emits only at
 *    GUARDIAN_REPAIR_MIN_REPAIRS distinct jobs across at least
 *    GUARDIAN_REPAIR_MIN_DAYS distinct UTC days, so one slow repair or
 *    one dropped job never queues a session.
 *  - Windowing is per cell. A slow repair's evidence is a completed
 *    span, so its enqueue must land inside the 7-day window like every
 *    sibling fold. A stalled repair's evidence is its still-missing
 *    finish — a present-tense fact that does not expire — so every
 *    parsed enqueue older than the stalled bar counts, windowed or
 *    not; the truncation note still marks counts as lower bounds.
 *  - Fleet machinery only: the ledgers are this install's guardian
 *    record, so items emit only for the repository the enqueues name —
 *    evidence recorded against another repo's repairs never lands on
 *    this one.
 *  - Truncation is stated, never hidden: when either bounded tail cuts
 *    older rows, every prompt says the counts are a lower bound.
 *  - Dedup is downstream: item ids hash the bucket + repository
 *    identity (never the counts or timestamps), so a refresh re-derives
 *    the same id and appendUserBacklogItems adds only what is new; a
 *    repo whose repairs recover simply stops re-adding.
 *  - Every emitted prompt keeps the evidence framing: counts are quoted
 *    only as recorded, job ids are scrubbed, flattened and capped, and
 *    the brief names both ledgers, the repair-time report and the
 *    guardian docs with the usual no-change escape when the window no
 *    longer reproduces or the cause is owner-side.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

import { ashlrHome, CLOUD_REPO_PATTERN } from '../cloud/store.js';
import type { CloudBacklogItem } from '../cloud/types.js';
import { readLedgerTail } from '../router/outcomes.js';
import { scrubSecrets } from '../util/scrub.js';

/** Items one call may emit; the bucket set is closed at two. */
export const GUARDIAN_REPAIR_BACKLOG_MAX_ITEMS = 4;
const GUARDIAN_REPAIR_ITEM_HARD_MAX = 25;
/** The window the slow-repair fold anchors on: the fleet's recurring-evidence week. */
export const GUARDIAN_REPAIR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * An enqueue with no finish row counts as stalled once it is this old —
 * past every watchdog a post-merge verification or repair job carries,
 * so the missing finish is a dropped repair, not a slow one.
 */
export const GUARDIAN_REPAIR_STALLED_MS = 12 * 60 * 60 * 1000;
/**
 * A recorded enqueue→finish span counts as slow at this length — well
 * past a CI verification window, inside what a frontier repair can
 * legitimately take on a large repo.
 */
export const GUARDIAN_REPAIR_SLOW_MS = 6 * 60 * 60 * 1000;
/** Distinct stalled or slow repairs a repo needs before the cell emits. */
export const GUARDIAN_REPAIR_MIN_REPAIRS = 3;
/** Distinct UTC days that evidence must span — recurring means recorded across days. */
export const GUARDIAN_REPAIR_MIN_DAYS = 2;
/** Future-skew allowance on ledger timestamps, same convention the sibling folds apply. */
const GUARDIAN_REPAIR_FUTURE_SKEW_MS = 60_000;
/** Bounded tail per ledger; the repair-time report reads whole files, discovery reads tails. */
const GUARDIAN_REPAIR_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
/** Job ids quoted inside one prompt before the remainder is summarized. */
const PROMPT_JOBS_MAX = 5;
/** Journal-recorded job ids are unbounded text; cap before dedupe and prompt use. */
const JOB_ID_MAX = 200;
/** Journal-recorded names are unbounded text; flatten, scrub and cap before use. */
const FIELD_MAX = 120;
/** Backlog title cap mirrored from validBacklogItem; composed titles are truncated to it. */
const MAX_TITLE_CHARS = 200;

const GUARDIAN_LEDGER_NAME = 'guardian.jsonl';
const FINISH_LEDGER_NAME = 'jobs-finished.jsonl';
const ENQUEUE_KIND = 'FIXUP-MAIN';

type Bucket = 'stalled' | 'slow';

export interface GuardianRepairItemsOptions {
  /** Backlog target in owner/name form; items emit only for enqueues naming this repository. */
  repo: string;
  /** Enqueue-ledger override (default: <ashlr home>/guardian.jsonl). */
  guardianPath?: string;
  /** Finish-ledger override (default: <ashlr home>/jobs-finished.jsonl). */
  finishPath?: string;
  /** Ashlr home for the default ledger paths (default: ashlrHome()). */
  homeDir?: string;
  /** Most items one call emits (default GUARDIAN_REPAIR_BACKLOG_MAX_ITEMS, hard-capped). */
  limit?: number;
  /** Clock anchoring the stalled bar and the slow window (default: now). */
  now?: Date;
}

/** One validated FIXUP-MAIN enqueue row: the repair the guardian recorded. */
export interface GuardianEnqueue {
  job: string;
  /** owner/name as recorded; matched case-insensitively. */
  repo: string;
  atMs: number;
  utcDay: string;
}

/** An enqueue joined to its recorded finish (null when no finish row exists). */
export interface GuardianRepair extends GuardianEnqueue {
  finishMs: number | null;
  /** finishMs - atMs when the pairing is sane; null when unfinished or skewed. */
  durationMs: number | null;
}

const utcDayOf = (atMs: number): string => new Date(atMs).toISOString().slice(0, 10);

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Journal-recorded job ids are unbounded text; flatten, scrub and cap before prompt use. */
function fieldText(value: string, max = FIELD_MAX): string {
  return scrubSecrets(value).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/**
 * Pure: parse guardian.jsonl text into validated FIXUP-MAIN enqueue rows.
 * First row per job id wins — the same pairing `phm fleet
 * main-repair-time` applies. Malformed lines, foreign events and kinds,
 * and rows missing job/repo/at are skipped — never guessed.
 */
export function parseGuardianEnqueues(text: string): GuardianEnqueue[] {
  const rows: GuardianEnqueue[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (r['event'] !== 'enqueue' || r['kind'] !== ENQUEUE_KIND) continue;
    const job = r['job'];
    const repo = r['repo'];
    const atMs = isoMs(r['at']);
    if (typeof job !== 'string' || job.trim() === '' || job.trim().length > JOB_ID_MAX) continue;
    if (typeof repo !== 'string' || repo.trim() === '') continue;
    if (atMs === null) continue;
    const id = job.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push({ job: id, repo: repo.trim(), atMs, utcDay: utcDayOf(atMs) });
  }
  return rows;
}

/**
 * Pure: parse jobs-finished.jsonl text into the earliest finish timestamp
 * per job id — reruns of the same job id do not move it, matching the
 * repair-time report's fold.
 */
export function parseJobFinishes(text: string): Map<string, number> {
  const earliest = new Map<string, number>();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    const r = value as Record<string, unknown>;
    if (r['event'] !== 'finish') continue;
    const job = r['job'];
    const atMs = isoMs(r['at']);
    if (typeof job !== 'string' || job.trim() === '' || job.trim().length > JOB_ID_MAX) continue;
    if (atMs === null) continue;
    const id = job.trim();
    const prev = earliest.get(id);
    if (prev === undefined || atMs < prev) earliest.set(id, atMs);
  }
  return earliest;
}

export interface GuardianRepairFold {
  /** Every parsed enqueue for the repo, each joined to its finish when one exists. */
  repairs: GuardianRepair[];
  /** Repairs with a recorded finish row (any span, windowed or not). */
  finished: number;
  /** Enqueues with no finish row at least GUARDIAN_REPAIR_STALLED_MS old (any age basis — see header). */
  stalled: GuardianRepair[];
  /** Finished repairs whose recorded span reached GUARDIAN_REPAIR_SLOW_MS. */
  slow: GuardianRepair[];
}

/**
 * Pure: join validated enqueues to finishes for one repository. Slow
 * repairs window on the enqueue like every sibling fold; stalled repairs
 * count every parsed enqueue past the stalled bar because a still-missing
 * finish is present-tense evidence that does not expire with the window.
 */
export function foldGuardianRepairs(
  enqueues: readonly GuardianEnqueue[],
  finishes: ReadonlyMap<string, number>,
  repo: string,
  nowMs: number,
  windowMs: number = GUARDIAN_REPAIR_WINDOW_MS,
): GuardianRepairFold {
  const target = repo.trim().toLowerCase();
  const windowStart = nowMs - windowMs;
  const repairs: GuardianRepair[] = [];
  const stalled: GuardianRepair[] = [];
  const slow: GuardianRepair[] = [];
  let finished = 0;
  for (const e of enqueues) {
    if (e.repo.toLowerCase() !== target) continue;
    if (e.atMs > nowMs + GUARDIAN_REPAIR_FUTURE_SKEW_MS) continue;
    const finishMs = finishes.get(e.job) ?? null;
    const durationMs = finishMs !== null && finishMs >= e.atMs && finishMs <= nowMs + GUARDIAN_REPAIR_FUTURE_SKEW_MS
      ? finishMs - e.atMs
      : null;
    const repair: GuardianRepair = { ...e, finishMs, durationMs };
    repairs.push(repair);
    if (finishMs !== null) finished += 1;
    if (e.atMs >= windowStart) {
      if (durationMs !== null && durationMs >= GUARDIAN_REPAIR_SLOW_MS) slow.push(repair);
    }
    if (finishMs === null && nowMs - e.atMs >= GUARDIAN_REPAIR_STALLED_MS) stalled.push(repair);
  }
  return { repairs, finished, stalled, slow };
}

const WINDOW_DAYS = Math.round(GUARDIAN_REPAIR_WINDOW_MS / 86_400_000);
const STALLED_HOURS = Math.round(GUARDIAN_REPAIR_STALLED_MS / 3_600_000);
const SLOW_HOURS = Math.round(GUARDIAN_REPAIR_SLOW_MS / 3_600_000);

const NO_CHANGE = 'If the window has rolled forward, the finishes landed since, the enqueues were deliberate operator state, or the cause is owner-side (credentials, billing, a protected gate or the ops-side guardian install itself) — report no-change and name the evidence.';

const EVIDENCE = 'The evidence is the main-guardian repair-time ledgers under the Ashlr home (~/.ashlr or $ASHLR_HOME): guardian.jsonl carries the guardian loop\'s {"event":"enqueue","kind":"FIXUP-MAIN","job","repo","at"} rows — one per repair the loop enqueued when a merge needed main fixed — and jobs-finished.jsonl its {"event":"finish","job","at"} rows. `phm fleet main-repair-time --json` (src/cli/fleet-main-repair-time.ts) is the only reader: it pairs first-enqueue with earliest-finish per job id and prints each repair\'s status and elapsed minutes — a report someone had to run. docs/main-guardian.md documents the repair flow and the state file (guardian/state.json under the runs dir) the health surfaces read.';

const truncationNote = (truncated: boolean): string =>
  truncated ? ' A bounded ledger tail was truncated, so these counts cover only the retained bytes — treat every tally as a lower bound.' : '';

const daysText = (days: readonly string[]): string => days.slice().sort().join(', ');

function stalledPrompt(fold: GuardianRepairFold, repo: string, truncated: boolean): string {
  const shown = fold.stalled
    .slice()
    .sort((a, b) => a.atMs - b.atMs)
    .slice(0, PROMPT_JOBS_MAX)
    .map((r) => `'${fieldText(r.job)}' (enqueued ${r.utcDay})`);
  const rest = fold.stalled.length > shown.length ? `, and ${fold.stalled.length - shown.length} more` : '';
  const youngOpen = fold.repairs.length - fold.finished - fold.stalled.length;
  const days = [...new Set(fold.stalled.map((r) => r.utcDay))].sort();
  const oldest = fold.stalled.reduce((min, r) => Math.min(min, r.atMs), Number.POSITIVE_INFINITY);
  return [
    `Phantom's main guardian keeps enqueueing FIXUP-MAIN repairs on ${repo} that are never recorded finished — ${fold.stalled.length} repair(s) have been open for at least ${STALLED_HOURS} hours, across ${days.length} distinct UTC day(s) (${daysText(days)}).`,
    '',
    `Inside the retained ledgers ${repo} recorded ${fold.repairs.length} FIXUP-MAIN enqueue(s): ${fold.finished} with a finish row, ${youngOpen} still inside the ${STALLED_HOURS}-hour bar, and ${fold.stalled.length} open past it; the oldest stalled enqueue is ${new Date(oldest).toISOString()}. Job ids: ${shown.join('; ')}${rest}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `A repair that never records a finish leaves the repo's default branch unverified — or red — with no fleet trace beyond the enqueue, and every later repair looks identical while the finish path stays silent. Reproduce the pairing first: run \`phm fleet main-repair-time --json\` and confirm the same jobs report status 'open', then find which side is dropping the finish — the guardian loop that should append jobs-finished.jsonl rows, a repair job that never launched or died before finishing, or a job-id mismatch between the two ledgers. Check guardian/guardian.log under the runs dir and \`phm fleet health-age --diagnose --json\` for the service side, and \`phm fleet main-health\`/\`phm fleet guardian-stuck\` for whether the repo currently sits red. Fix what lives here — the queue, dispatch or outcome paths in this repository's src/ — and keep the ops-side guardian install, credentials and protected gates out of scope. ${NO_CHANGE}`,
  ].join('\n');
}

function slowPrompt(fold: GuardianRepairFold, repo: string, truncated: boolean): string {
  const shown = fold.slow
    .slice()
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
    .slice(0, PROMPT_JOBS_MAX)
    .map((r) => `'${fieldText(r.job)}' (${Math.round((r.durationMs ?? 0) / 3_600_000)}h, enqueued ${r.utcDay})`);
  const rest = fold.slow.length > shown.length ? `, and ${fold.slow.length - shown.length} more` : '';
  const days = [...new Set(fold.slow.map((r) => r.utcDay))].sort();
  const spans = fold.slow.map((r) => (r.durationMs ?? 0) / 3_600_000);
  const longest = Math.round(Math.max(...spans));
  return [
    `Phantom's main guardian repairs on ${repo} keep taking hours — ${fold.slow.length} repair(s) recorded an enqueue→finish span of at least ${SLOW_HOURS} hours inside the ${WINDOW_DAYS}-day window, across ${days.length} distinct UTC day(s) (${daysText(days)}); the longest recorded span is about ${longest} hours.`,
    '',
    `Job ids and spans: ${shown.join('; ')}${rest}.${truncationNote(truncated)}`,
    '',
    EVIDENCE,
    '',
    `Post-merge verification should conclude inside a CI window; a repair taking most of a day leaves the repo's default branch unverified for the duration and delays every later fix behind it. Reproduce the pairing first: run \`phm fleet main-repair-time --json\` for the same enqueue→finish minutes, then trace the slow jobs in metrics/jobs.jsonl under the runs dir — launch→finish phases, lane, tier, retries and recuts — to see whether the span is queue wait, lane ill-health, a retry loop or a job too broad for its tier. \`phm fleet vitals\` and \`phm friction --json\` carry the fleet-wide drag tallies. Fix what lives here — routing, dispatch-fit, queue or outcome-consumption code in this repository's src/ — and keep deliberate operator state and owner-side causes out of scope. ${NO_CHANGE}`,
  ].join('\n');
}

function itemId(bucket: Bucket, repo: string): string {
  const hash = createHash('sha256').update(`guardian-repair:${bucket}:${repo.toLowerCase()}`).digest('hex').slice(0, 16);
  return `guardian-repair-${bucket}-${hash}`;
}

function makeItem(bucket: Bucket, repo: string, title: string, prompt: string): CloudBacklogItem {
  return {
    id: itemId(bucket, repo),
    title: title.slice(0, MAX_TITLE_CHARS),
    prompt,
    area: 'main-guardian',
    priority: 3,
    ...(CLOUD_REPO_PATTERN.test(repo) ? { repo } : {}),
  };
}

/**
 * Backlog items for the main-guardian repair ledgers' recurring stalled
 * and slow repairs on `repo`. Total: a missing or unreadable guardian
 * ledger, an absent finish ledger (which makes every missing finish
 * unknowable rather than zero), or any read or fold failure yields no
 * items rather than throwing into discovery.
 */
export async function guardianRepairBacklogItems(opts: GuardianRepairItemsOptions): Promise<CloudBacklogItem[]> {
  try {
    const repo = opts.repo.trim();
    if (!CLOUD_REPO_PATTERN.test(repo)) return [];
    const nowMs = (opts.now ?? new Date()).getTime();
    if (!Number.isFinite(nowMs)) return [];
    const home = opts.homeDir ?? ashlrHome();
    const guardianPath = opts.guardianPath ?? join(home, GUARDIAN_LEDGER_NAME);
    const finishPath = opts.finishPath ?? join(home, FINISH_LEDGER_NAME);
    const guardianTail = await readLedgerTail(guardianPath, GUARDIAN_REPAIR_LEDGER_MAX_BYTES);
    if (guardianTail.state !== 'read') return [];
    // Without a readable finish ledger a missing finish row is unknowable,
    // never a stalled repair — both cells stay silent.
    const finishTail = await readLedgerTail(finishPath, GUARDIAN_REPAIR_LEDGER_MAX_BYTES);
    if (finishTail.state !== 'read') return [];
    const enqueues = parseGuardianEnqueues(guardianTail.text);
    if (enqueues.length === 0) return [];
    const finishes = parseJobFinishes(finishTail.text);
    const fold = foldGuardianRepairs(enqueues, finishes, repo, nowMs);
    const truncated = guardianTail.truncated || finishTail.truncated;

    const candidates: CloudBacklogItem[] = [];
    const stalledDays = new Set(fold.stalled.map((r) => r.utcDay));
    if (fold.stalled.length >= GUARDIAN_REPAIR_MIN_REPAIRS && stalledDays.size >= GUARDIAN_REPAIR_MIN_DAYS) {
      candidates.push(makeItem(
        'stalled',
        repo,
        `Main-guardian repairs keep never finishing on ${repo}`,
        stalledPrompt(fold, repo, truncated),
      ));
    }
    const slowDays = new Set(fold.slow.map((r) => r.utcDay));
    if (fold.slow.length >= GUARDIAN_REPAIR_MIN_REPAIRS && slowDays.size >= GUARDIAN_REPAIR_MIN_DAYS) {
      candidates.push(makeItem(
        'slow',
        repo,
        `Main-guardian repairs keep taking hours on ${repo}`,
        slowPrompt(fold, repo, truncated),
      ));
    }
    const limit = Math.max(1, Math.min(opts.limit ?? GUARDIAN_REPAIR_BACKLOG_MAX_ITEMS, GUARDIAN_REPAIR_ITEM_HARD_MAX));
    return candidates.slice(0, limit);
  } catch {
    return [];
  }
}
