/**
 * Recurring-flake evidence for the resident CI rerun loop.
 *
 * `analyzeCiBaseline` classifies a test `probable-flake` when it fails on one
 * open PR while passing on master, and `runCiRerunMaintenance` reruns those
 * failed jobs. Each rerun attempt is journaled with the failing test id, so a
 * test that keeps flaking on unrelated commits accumulates distinct heads in
 * `ci-reruns/journal.jsonl`. This module folds that journal into recurring
 * flakes — the same test probable-flaking on enough distinct heads inside a
 * bounded recent window — and turns each one into a deduplicated
 * `RQ-CIFLAKE-*` stabilization row for the router queue, under the same
 * standing-authority and KILL gates as shared-baseline fixes.
 *
 * The window keeps the signal honest: a flake that was fixed stops producing
 * attempts, and once its attempts age out of the window the test is no longer
 * recurring, so a merged fix is never re-queued on stale evidence. When the
 * flake does keep recurring after earlier stabilization rows reached DONE,
 * `enqueueFlakeFixes` queues the next `-G<n>` generation (see
 * ci-fix-generations.ts) so a fix that did not hold becomes fresh work
 * instead of a permanently deduplicated row. Rows without a test id (written
 * before the field existed) and rows outside the window simply do not count
 * — unknown stays unknown, never zero.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { scrubSecrets } from '../util/scrub.js';
import { nextFixGeneration } from './ci-fix-generations.js';

/** Attempt rows older than this no longer count toward recurrence. */
export const RECURRING_FLAKE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Distinct heads a test must flake on before it is recurring work, not noise. */
export const RECURRING_FLAKE_MIN_HEADS = 3;
/** Bound on the journal `test` payload; truncation is deterministic so grouping is stable. */
export const JOURNAL_TEST_MAX = 400;
/** New stabilization rows appended per maintenance run. */
export const MAX_FLAKE_FIX_ROWS = 10;
/** Heads named inside one fix brief before the count is summarized. */
const BRIEF_HEADS = 5;

/** The journal fields recurrence reads; extra fields are ignored. */
export interface FlakeJournalRow {
  at: string;
  repo: string;
  head: string;
  outcome: string;
  test?: string | null;
  verdict?: string | null;
}

export interface RecurringFlake {
  repo: string;
  test: string;
  /** Distinct head SHAs the test flaked on inside the window, ascending. */
  heads: string[];
  /** Attempt rows counted inside the window; always >= heads.length. */
  attempts: number;
  /** Rerun verdict rows counted inside the window; zeros mean none recorded yet. */
  verdicts: { pass: number; fail: number; inconclusive: number };
}

const REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;

/**
 * Group attempt rows by (repo, test) and keep the groups whose distinct-head
 * count reaches `minHeads` inside `windowMs` of `nowMs`. Only `attempt`
 * outcome rows count — `ok`/`failed` rows are the same attempt's result —
 * and rows without a usable test id, repo or head are skipped. Sorted by
 * descending head count, then repo and test, so the strongest evidence wins
 * the per-run row cap.
 */
export function recurringFlakes(
  rows: readonly FlakeJournalRow[],
  opts: { nowMs?: number; windowMs?: number; minHeads?: number } = {},
): RecurringFlake[] {
  const nowMs = opts.nowMs ?? Date.now();
  const windowMs = opts.windowMs ?? RECURRING_FLAKE_WINDOW_MS;
  const minHeads = opts.minHeads ?? RECURRING_FLAKE_MIN_HEADS;
  if (!Number.isFinite(nowMs)) throw new RangeError('nowMs must be finite');
  if (!Number.isFinite(windowMs) || windowMs <= 0) throw new RangeError('windowMs must be positive');
  if (!Number.isSafeInteger(minHeads) || minHeads < 1) throw new RangeError('minHeads must be a positive safe integer');
  const groups = new Map<string, { repo: string; test: string; heads: Set<string>; attempts: number }>();
  for (const row of rows) {
    if (row.outcome !== 'attempt') continue;
    if (typeof row.test !== 'string' || row.test === '') continue;
    if (typeof row.repo !== 'string' || !REPO_SHAPE.test(row.repo)) continue;
    if (typeof row.head !== 'string' || row.head === '') continue;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at) || at < nowMs - windowMs || at > nowMs) continue;
    const key = JSON.stringify([row.repo, row.test]);
    const group = groups.get(key) ?? { repo: row.repo, test: row.test, heads: new Set<string>(), attempts: 0 };
    group.heads.add(row.head);
    group.attempts += 1;
    groups.set(key, group);
  }
  const verdicts = new Map<string, { pass: number; fail: number; inconclusive: number }>();
  for (const row of rows) {
    if (row.outcome !== 'verdict') continue;
    if (row.verdict !== 'pass' && row.verdict !== 'fail' && row.verdict !== 'inconclusive') continue;
    if (typeof row.test !== 'string' || row.test === '') continue;
    if (typeof row.repo !== 'string' || !REPO_SHAPE.test(row.repo)) continue;
    const at = typeof row.at === 'string' ? Date.parse(row.at) : NaN;
    if (!Number.isFinite(at) || at < nowMs - windowMs || at > nowMs) continue;
    const key = JSON.stringify([row.repo, row.test]);
    const tally = verdicts.get(key) ?? { pass: 0, fail: 0, inconclusive: 0 };
    tally[row.verdict] += 1;
    verdicts.set(key, tally);
  }
  return [...groups.values()]
    .filter((group) => group.heads.size >= minHeads)
    .map((group) => ({
      repo: group.repo,
      test: group.test,
      heads: [...group.heads].sort(),
      attempts: group.attempts,
      verdicts: verdicts.get(JSON.stringify([group.repo, group.test])) ?? { pass: 0, fail: 0, inconclusive: 0 },
    }))
    .sort((a, b) => b.heads.length - a.heads.length
      || a.repo.localeCompare(b.repo) || a.test.localeCompare(b.test));
}

/** Stable queue id for one recurring (repo, test) pair, mirroring RQ-CIBASE-. */
export function flakeJobId(repo: string, test: string): string {
  return `RQ-CIFLAKE-${createHash('sha256').update(`${repo}:${test}`).digest('hex').slice(0, 16).toUpperCase()}`;
}

function flakeFixBrief(flake: RecurringFlake, jobId: string, generation: number): string {
  const shown = flake.heads.slice(0, BRIEF_HEADS);
  const headList = shown.join(', ') + (flake.heads.length > shown.length ? `, and ${flake.heads.length - shown.length} more` : '');
  const test = scrubSecrets(flake.test).replace(/[\r\n]+/g, ' ').slice(0, JOURNAL_TEST_MAX);
  const retry = generation > 1
    ? ` This is stabilization attempt ${generation}: earlier attempts for this test reached DONE and the flake still recurs on the heads above.`
    : '';
  const v = flake.verdicts;
  const verdictNote = v.pass + v.fail + v.inconclusive > 0
    ? ` Recorded rerun verdicts for this test: ${v.pass} passed, ${v.fail} failed, ${v.inconclusive} inconclusive. `
    : '';
  return scrubSecrets(
    `Stabilize flaky test ${test} in ${flake.repo}: the CI baseline analyzer classified it probable-flake ` +
    `and the rerun loop attempted it on ${flake.heads.length} distinct heads (${headList}). ` +
    verdictNote +
    `Reproduce the flake locally, find the nondeterminism (test ordering, timing, shared state, ports or temp paths, unawaited work), ` +
    `and make the test deterministic; if it cannot be made reliable, quarantine it behind an explicit skip that names ${jobId}. ` +
    `Never weaken the assertion, delete coverage, or edit Security GATES v3 files. Run the affected suite.` +
    retry +
    ` Include ${jobId} in the fix PR body.`,
  ).replace(/[\r\n]+/g, ' ');
}

/**
 * Append one READY stabilization row per recurring flake. Queue state decides
 * deduplication: an open row suppresses queueing, a family whose generations
 * all reached DONE re-queues as the next `-G<n>` id while the flake still
 * recurs (capped by MAX_FIX_GENERATIONS), and dropped or retired rows stay
 * suppressed. Capped at MAX_FLAKE_FIX_ROWS new rows per call. Returns the
 * queued job ids. Queueing is an explicit local write; callers own the
 * standing-authority and KILL gates.
 */
export function enqueueFlakeFixes(flakes: readonly RecurringFlake[], queuePath: string): string[] {
  if (!isAbsolute(queuePath)) throw new Error('queue-file must be absolute');
  mkdirSync(dirname(queuePath), { recursive: true });
  let existing = existsSync(queuePath) ? readFileSync(queuePath, 'utf8') : '';
  const queued: string[] = [];
  for (const flake of flakes) {
    const base = flakeJobId(flake.repo, flake.test);
    const retry = nextFixGeneration(existing, base);
    if (!retry) continue;
    const line = `\n- READY ${retry.jobId} (P1, repo=${flake.repo.split('/')[1]}, tier=work, needs=git|gh|node): ${flakeFixBrief(flake, retry.jobId, retry.generation)}\n`;
    appendFileSync(queuePath, line, 'utf8');
    existing += line;
    queued.push(retry.jobId);
    if (queued.length === MAX_FLAKE_FIX_ROWS) break;
  }
  return queued;
}
