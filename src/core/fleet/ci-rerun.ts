import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readSync, readFileSync, fstatSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { ashlrHome } from '../cloud/store.js';
import { displaySurfaceTarget, evaluateStandingAuthority } from '../authority/effective-config.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { analyzeCiBaseline, enqueueBaselineFixes } from './ci-baseline.js';
import { enqueueFlakeFixes, JOURNAL_TEST_MAX, recurringFlakes, RECURRING_FLAKE_WINDOW_MS } from './ci-flakes.js';
import { scrubSecrets } from '../util/scrub.js';
import { defaultCiGh } from './ci-failure-groups.js';

type Entry = { at: string; repo: string; head: string; runId: number; pr: number; outcome: 'attempt' | 'ok' | 'failed' | 'verdict'; test?: string; tests?: string[]; verdict?: 'pass' | 'fail' | 'inconclusive' };
type VerdictCursor = Pick<Entry, 'at' | 'repo' | 'head' | 'runId'>;
type RepoStatus = { groups: number; attempted: number; ok: number; failed: number; skippedDuplicate: number; skippedCap: number; queued: number; flakeFixesQueued: number; recurringFlakes: number; verdictsPending: number; verdictsResolved: number; verdictCursor?: VerdictCursor; queueBlocked: string | null; errors: string[] };

/** A fired rerun is only trusted for verdict reads after GitHub has registered the new attempt. */
const VERDICT_MIN_AGE_MS = 5 * 60_000;
/** Unresolved reruns older than this stop being polled and leave the pending count. */
const VERDICT_MAX_AGE_MS = 24 * 60 * 60_000;
/** Verdict API reads per repository per maintenance pass, bounding calls inside the deadline. */
const MAX_VERDICT_CHECKS = 8;
/** Slack allowed between the local fire timestamp and the GitHub attempt start. */
const VERDICT_SKEW_MS = 60_000;
const VERDICTS = ['pass', 'fail', 'inconclusive'] as const;

function rerunKey(e: Pick<Entry, 'repo' | 'head' | 'runId'>): string {
  return JSON.stringify([e.repo.toLowerCase(), e.head, e.runId]);
}

function workflowRunKey(e: Pick<Entry, 'repo' | 'runId'>): string {
  return JSON.stringify([e.repo.toLowerCase(), e.runId]);
}

function compareVerdictPosition(a: VerdictCursor, b: VerdictCursor): number {
  return Date.parse(a.at) - Date.parse(b.at) || rerunKey(a).localeCompare(rerunKey(b));
}

/** Keep one verdict per workflow run as of the observation time. */
export function observedVerdicts(entries: readonly Entry[], nowMs: number): Entry[] {
  const runs = new Map<string, { first: Entry; verdictConflict: boolean; testConflict: boolean }>();
  for (const entry of entries) {
    if (entry.outcome !== 'verdict' || Date.parse(entry.at) > nowMs) continue;
    const key = workflowRunKey(entry);
    const run = runs.get(key);
    if (!run) {
      runs.set(key, { first: entry, verdictConflict: false, testConflict: false });
      continue;
    }
    run.verdictConflict ||= run.first.head !== entry.head || run.first.verdict !== entry.verdict;
    run.testConflict ||= run.first.test !== entry.test;
    if (Date.parse(entry.at) < Date.parse(run.first.at)) run.first = entry;
  }
  return [...runs.values()].filter(run => !run.verdictConflict)
    .map(({ first, testConflict }) => testConflict ? { ...first, test: undefined } : first);
}

function triggeringTests(entry: Entry): string[] {
  const validTest = (test: unknown): test is string =>
    typeof test === 'string' && test.length > 0 && test.length <= JOURNAL_TEST_MAX;
  if (entry.tests === undefined) return validTest(entry.test) ? [entry.test] : [];
  if (!Array.isArray(entry.tests) || !entry.tests.every(validTest)) return [];
  const tests = [...new Set(entry.tests)].sort();
  if (entry.test !== undefined && (tests.length !== 1 || tests[0] !== entry.test)) return [];
  return tests;
}

/** Keep the earliest attempt time and only attribute consistent test evidence. */
export function observedAttempts(entries: readonly Entry[], nowMs: number): Entry[] {
  const attempts = new Map<string, { first: Entry; testsKey: string; testConflict: boolean }>();
  for (const entry of entries) {
    if (entry.outcome !== 'attempt' || Date.parse(entry.at) > nowMs) continue;
    const key = workflowRunKey(entry);
    const testsKey = JSON.stringify(triggeringTests(entry));
    const attempt = attempts.get(key);
    if (!attempt) {
      attempts.set(key, { first: entry, testsKey, testConflict: false });
      continue;
    }
    attempt.testConflict ||= attempt.first.head !== entry.head || attempt.testsKey !== testsKey;
    if (Date.parse(entry.at) < Date.parse(attempt.first.at)) attempt.first = entry;
  }
  return [...attempts.values()].map(({ first, testConflict }) =>
    testConflict ? { ...first, test: undefined, tests: undefined } : first);
}

/** Attribute workflow verdicts only to a matching single-test attempt in the window. */
export function attributedTestVerdicts(attempts: readonly Entry[], verdicts: readonly Entry[], nowMs: number): Entry[] {
  const cutoff = nowMs - RECURRING_FLAKE_WINDOW_MS;
  const attemptsByRun = new Map(attempts.filter(entry => Date.parse(entry.at) >= cutoff)
    .map(entry => [rerunKey(entry), entry]));
  return verdicts.filter(verdict => {
    if (!verdict.test) return false;
    const attempt = attemptsByRun.get(rerunKey(verdict));
    if (!attempt || Date.parse(attempt.at) > Date.parse(verdict.at)) return false;
    const tests = triggeringTests(attempt);
    return tests.length === 1 && tests[0] === verdict.test;
  });
}

/** Expand each observed attempt once for each triggering test. */
function summarizeFlakes(attempts: readonly Entry[], nowMs: number, verdicts: readonly Entry[]) {
  const recentAttempts = attempts.filter(entry => Date.parse(entry.at) >= nowMs - RECURRING_FLAKE_WINDOW_MS);
  const testsByAttempt = recentAttempts.flatMap(entry => triggeringTests(entry).map(test => ({ ...entry, test })));
  return recurringFlakes([...testsByAttempt, ...attributedTestVerdicts(recentAttempts, verdicts, nowMs)], { nowMs });
}

/** Reconcile call receipts without treating replays as new calls. */
export function observedCallResults(entries: readonly Entry[], nowMs: number): Entry[] {
  const calls = new Map<string, { first: Entry; outcomeConflict: boolean; testConflict: boolean }>();
  for (const e of entries) {
    if ((e.outcome !== 'ok' && e.outcome !== 'failed') || Date.parse(e.at) > nowMs) continue;
    const key = workflowRunKey(e);
    const call = calls.get(key);
    if (!call) {
      calls.set(key, { first: e, outcomeConflict: false, testConflict: false });
      continue;
    }
    call.outcomeConflict ||= call.first.head !== e.head || call.first.outcome !== e.outcome;
    call.testConflict ||= call.first.test !== e.test;
    if (Date.parse(e.at) < Date.parse(call.first.at)) call.first = e;
  }
  return [...calls.values()].filter(call => !call.outcomeConflict)
    .map(({ first, testConflict }) => testConflict ? { ...first, test: undefined } : first);
}

/** Fired reruns still awaiting a run verdict, oldest first. */
function pendingVerdicts(entries: readonly Entry[], calls: readonly Entry[], nowMs: number): Entry[] {
  const verdicted = new Set(entries.filter(e => e.outcome === 'verdict' && Date.parse(e.at) <= nowMs).map(workflowRunKey));
  return calls
    .filter(e => e.outcome === 'ok' && !verdicted.has(workflowRunKey(e)) && Date.parse(e.at) >= nowMs - VERDICT_MAX_AGE_MS)
    .sort(compareVerdictPosition);
}

function hourlyAttempts(entries: readonly Entry[], nowMs: number): number {
  return entries.filter(e => Date.parse(e.at) > nowMs - 3_600_000).length;
}

/** Map a workflow-run API payload to a verdict; null means not yet resolvable. */
function verdictFromRun(data: unknown, entry: Entry, observedAt: number): Entry['verdict'] | null {
  if (typeof data !== 'object' || data === null) return null;
  const run = data as { id?: unknown; status?: unknown; conclusion?: unknown; head_sha?: unknown; updated_at?: unknown; run_attempt?: unknown; run_started_at?: unknown };
  if (run.id !== entry.runId || run.head_sha !== entry.head || run.status !== 'completed') return null;
  if (typeof run.conclusion !== 'string' || !run.conclusion.trim() || typeof run.updated_at !== 'string') return null;
  if (typeof run.run_attempt !== 'number' || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 2
      || typeof run.run_started_at !== 'string') return null;
  const started = Date.parse(run.run_started_at);
  const updated = Date.parse(run.updated_at);
  if (!Number.isFinite(started) || !Number.isFinite(updated)
      || started < Date.parse(entry.at) - VERDICT_SKEW_MS || updated < started || updated > observedAt) return null;
  if (run.conclusion === 'success') return 'pass';
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') return 'fail';
  return 'inconclusive';
}
export interface CiRerunOptions {
  repos: string[];
  signal: AbortSignal;
  maxPerHour?: number;
  gh?: CloudGh;
  analyzer?: typeof analyzeCiBaseline;
  now?: () => number;
  queueFile?: string;
  journalPath?: string;
  statusPath?: string;
  autonomyEffective?: () => boolean;
  killOff?: () => boolean;
}

export function ciRerunPaths() {
  const root = join(ashlrHome(), 'ci-reruns');
  return { journalPath: join(root, 'journal.jsonl'), statusPath: join(root, 'status.json') };
}

export function readCiReruns(path = ciRerunPaths().journalPath, now = Date.now()) {
  const entries: Entry[] = [];
  try {
    const fd = openSync(path, 'r');
    try {
      const size = fstatSync(fd).size, start = Math.max(0, size - 4 * 1024 * 1024);
      // Inspect the preceding byte to tell a partial row from a complete one.
      const offset = Math.max(0, start - 1);
      const buffer = Buffer.alloc(size - offset);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, offset);
      const lines = buffer.toString('utf8', start - offset, bytesRead).split('\n');
      if (start && buffer[0] !== 0x0a) lines.shift();
      for (const line of lines) {
        try {
          const e = JSON.parse(line) as Entry;
          if (typeof e.repo === 'string' && typeof e.head === 'string' && Number.isSafeInteger(e.runId) && Number.isFinite(Date.parse(e.at))
            && ['attempt', 'ok', 'failed', 'verdict'].includes(e.outcome)
            && (e.outcome !== 'verdict' || (VERDICTS as readonly string[]).includes(e.verdict ?? ''))) entries.push(e);
        } catch { /* malformed journal row */ }
      }
    } finally { closeSync(fd); }
  } catch { /* absent journal */ }
  const observed = entries.filter(e => Date.parse(e.at) <= now);
  const attempts = observedAttempts(observed, now);
  const calls = observedCallResults(observed, now);
  const verdicts = observedVerdicts(observed, now);
  const verdictTally = { pass: 0, fail: 0, inconclusive: 0 };
  for (const e of verdicts) if (e.verdict) verdictTally[e.verdict]++;
  const resolved = verdictTally.pass + verdictTally.fail;
  return {
    entries,
    recent: observed.slice(-100),
    counts: {
      attempted: attempts.length,
      ok: calls.filter(e => e.outcome === 'ok').length,
      failed: calls.filter(e => e.outcome === 'failed').length,
    },
    lastHour: hourlyAttempts(attempts, now),
    recurringFlakes: summarizeFlakes(attempts, now, verdicts),
    verdicts: {
      ...verdictTally,
      pending: pendingVerdicts(observed, calls, now).length,
      resolutionRate: resolved > 0 ? verdictTally.pass / resolved : null,
    },
  };
}

export function readCiRerunStatus(path = ciRerunPaths().statusPath): { lastRunAt: string; status: string; repos: Record<string, RepoStatus> } | null {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export async function runCiRerunMaintenance(opts: CiRerunOptions) {
  const paths = { ...ciRerunPaths(), ...opts }, now = opts.now ?? Date.now;
  const status = { lastRunAt: new Date(now()).toISOString(), status: 'ok', repos: {} as Record<string, RepoStatus> };
  const previous = readCiRerunStatus(paths.statusPath);
  const journal = readCiReruns(paths.journalPath, now()).entries;
  const append = (entry: Entry) => {
    mkdirSync(dirname(paths.journalPath), { recursive: true });
    appendFileSync(paths.journalPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
    const fd = openSync(paths.journalPath, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    journal.push(entry);
  };
  const gh: CloudGh = async args => {
    opts.signal.throwIfAborted();
    let abort: () => void = () => undefined;
    try {
      return await Promise.race([
        (opts.gh ?? defaultCiGh)(args),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(opts.signal.reason ?? new Error('aborted'));
          opts.signal.addEventListener('abort', abort, { once: true });
          if (opts.signal.aborted) abort();
        }),
      ]);
    } finally { opts.signal.removeEventListener('abort', abort); }
  };
  try {
    for (const repo of opts.repos) {
      opts.signal.throwIfAborted();
      const repoKey = repo.toLowerCase();
      const recordedRuns = new Set(journal.filter(entry => entry.repo.toLowerCase() === repoKey).map(entry => entry.runId));
      const s: RepoStatus = { groups: 0, attempted: 0, ok: 0, failed: 0, skippedDuplicate: 0, skippedCap: 0, queued: 0, flakeFixesQueued: 0, recurringFlakes: 0, verdictsPending: 0, verdictsResolved: 0, queueBlocked: null, errors: [] };
      const previousRepo = Object.keys(previous?.repos ?? {}).find(name => name.toLowerCase() === repoKey);
      s.verdictCursor = previousRepo === undefined ? undefined : previous?.repos[previousRepo]?.verdictCursor;
      status.repos[repo] = s;
      try {
        const report = await (opts.analyzer ?? analyzeCiBaseline)(repo, gh);
        opts.signal.throwIfAborted();
        s.groups = report.groups.length;
        s.errors.push(...report.errors);
        const eligibleGroups = report.groups.filter(group =>
          group.classification === 'probable-flake' && group.action === 'rerun-failed');
        const rerunGroups = new Set(eligibleGroups);
        const runsWithOtherFailures = new Set<string>();
        const testsByRun = new Map<string, Set<string>>();
        const headsByRun = new Map<number, string | null>();
        for (const group of report.groups) {
          // A shortened or redacted ID can collide with a different test.
          const test = rerunGroups.has(group) && typeof group.testId === 'string'
            && group.testId.length <= JOURNAL_TEST_MAX && scrubSecrets(group.testId) === group.testId
            ? group.testId
            : '';
          for (const run of group.runs) {
            const head = headsByRun.get(run.runId);
            headsByRun.set(run.runId, head === undefined || head === run.head ? run.head : null);
            const key = rerunKey({ repo, ...run });
            if (!test) {
              runsWithOtherFailures.add(key);
              continue;
            }
            const tests = testsByRun.get(key) ?? new Set<string>();
            tests.add(test);
            testsByRun.set(key, tests);
          }
        }
        for (const [runId, head] of headsByRun) {
          if (head === null) s.errors.push(`conflicting heads for workflow run ${runId}`);
        }
        for (const group of eligibleGroups) {
          opts.signal.throwIfAborted();
          for (const run of group.runs) {
            opts.signal.throwIfAborted();
            if (headsByRun.get(run.runId) === null) continue;
            if (recordedRuns.has(run.runId)) { s.skippedDuplicate++; continue; }
            const cap = opts.maxPerHour ?? 10;
            const evaluatedAt = now();
            if (!Number.isFinite(cap) || hourlyAttempts(observedAttempts(journal, evaluatedAt), evaluatedAt) >= Math.max(0, cap)) { s.skippedCap++; continue; }
            const entry: Entry = { at: new Date(now()).toISOString(), repo, ...run, outcome: 'attempt' };
            const key = rerunKey({ repo, ...run });
            const tests = [...(testsByRun.get(key) ?? [])];
            if (tests.length === 1) entry.test = tests[0];
            else if (tests.length > 1) entry.tests = tests;
            append(entry);
            recordedRuns.add(run.runId);
            s.attempted++;
            let ok = false;
            try { ok = (await gh(['run', 'rerun', String(run.runId), '--failed', '--repo', repo])).ok; }
            catch (error) { if (opts.signal.aborted) throw error; }
            // A failed-job rerun can include failures outside the triggering flakes.
            const test = runsWithOtherFailures.has(key) ? undefined : entry.test;
            append({ ...entry, test, tests: undefined, at: new Date(now()).toISOString(), outcome: ok ? 'ok' : 'failed' });
            if (ok) s.ok++; else s.failed++;
          }
        }
        opts.signal.throwIfAborted();
        const repoEntries = journal.filter(e => e.repo.toLowerCase() === repoKey);
        const evaluatedAt = now();
        const flakes = summarizeFlakes(observedAttempts(repoEntries, evaluatedAt), evaluatedAt, observedVerdicts(repoEntries, evaluatedAt));
        s.recurringFlakes = flakes.length;
        const sharedBaseline = report.groups.some(g => g.classification === 'shared-baseline');
        if (sharedBaseline || flakes.length > 0) {
          const queuePath = opts.queueFile ?? join(homedir(), '.ashlr-runs/queue/router-queue.md');
          const authority = (opts.autonomyEffective ?? (() => evaluateStandingAuthority({ mode: 'cached', surface: displaySurfaceTarget() }).effectiveSwitch !== 'off'))();
          const killOff = (opts.killOff ?? (() => readKillSwitch().state === 'inactive'))();
          if (!authority || !killOff) s.queueBlocked = [!authority ? 'autonomy-off' : '', !killOff ? 'kill-on-or-unknown' : ''].filter(Boolean).join(',');
          else {
            if (sharedBaseline) s.queued = enqueueBaselineFixes(report, queuePath).length;
            s.flakeFixesQueued = enqueueFlakeFixes(flakes, queuePath).length;
          }
        }
        const pendingAt = now();
        const pending = pendingVerdicts(repoEntries, observedCallResults(repoEntries, pendingAt), pendingAt);
        const attemptsByRun = new Map(observedAttempts(repoEntries, pendingAt).map(entry => [workflowRunKey(entry), entry]));
        s.verdictsPending = pending.length;
        // A future-dated verdict is invisible to the tally but still deduplicates writes.
        const recordedVerdicts = new Set(journal.filter(e => e.outcome === 'verdict').map(workflowRunKey));
        const eligible = pending.filter(e =>
          !recordedVerdicts.has(workflowRunKey(e)) && Date.parse(e.at) <= now() - VERDICT_MIN_AGE_MS);
        const cursor = s.verdictCursor;
        const next = cursor ? eligible.findIndex(e => compareVerdictPosition(e, cursor) > 0) : 0;
        const start = Math.max(0, next);
        for (let offset = 0; offset < Math.min(eligible.length, MAX_VERDICT_CHECKS); offset++) {
          const p = eligible[(start + offset) % eligible.length]!;
          opts.signal.throwIfAborted();
          let verdict: Entry['verdict'] | null = null;
          let observedAt = 0;
          try {
            const r = await gh(['api', `repos/${repo}/actions/runs/${p.runId}`]);
            if (r.ok) {
              observedAt = now();
              try { verdict = verdictFromRun(JSON.parse(r.stdout), p, observedAt); }
              catch { /* malformed run payload: stays pending for a later pass */ }
            }
          } catch (error) { if (opts.signal.aborted) throw error; }
          s.verdictCursor = { at: p.at, repo: p.repo, head: p.head, runId: p.runId };
          if (verdict === null) continue;
          const attempt = attemptsByRun.get(workflowRunKey(p));
          const tests = attempt ? triggeringTests(attempt) : [];
          // Older or truncated journals can have a call receipt without its attempt.
          const test = p.test && (!attempt || (attempt.head === p.head && tests.length === 1 && tests[0] === p.test)) ? p.test : undefined;
          append({ at: new Date(observedAt).toISOString(), repo: p.repo, head: p.head, runId: p.runId, pr: p.pr, outcome: 'verdict', verdict, ...(test ? { test } : {}) });
          s.verdictsResolved++;
        }
      } catch (error) {
        if (opts.signal.aborted) throw error;
        s.errors.push(error instanceof Error ? error.message : 'maintenance failed');
      }
    }
  } catch (error) {
    if (!opts.signal.aborted) throw error;
  } finally {
    if (opts.signal.aborted) status.status = 'aborted';
    mkdirSync(dirname(paths.statusPath), { recursive: true });
    writeFileSync(paths.statusPath + '.tmp', JSON.stringify(status), { mode: 0o600 });
    renameSync(paths.statusPath + '.tmp', paths.statusPath);
  }
  return status;
}
