import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readSync, readFileSync, fstatSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { ashlrHome } from '../cloud/store.js';
import { displaySurfaceTarget, evaluateStandingAuthority } from '../authority/effective-config.js';
import { readKillSwitch } from '../sandbox/policy.js';
import { analyzeCiBaseline, enqueueBaselineFixes } from './ci-baseline.js';
import { enqueueFlakeFixes, JOURNAL_TEST_MAX, recurringFlakes } from './ci-flakes.js';
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
  return JSON.stringify([e.repo, e.head, e.runId]);
}

function compareVerdictPosition(a: VerdictCursor, b: VerdictCursor): number {
  return Date.parse(a.at) - Date.parse(b.at) || rerunKey(a).localeCompare(rerunKey(b));
}

/** Expand attempt evidence for recurrence while keeping workflow counters per run. */
function summarizeFlakes(entries: readonly Entry[], nowMs: number) {
  return recurringFlakes(entries.flatMap(entry => {
    if (entry.outcome !== 'attempt' || !Array.isArray(entry.tests)) return [entry];
    const tests = new Set(entry.tests.filter(test => typeof test === 'string' && test.length > 0 && test.length <= JOURNAL_TEST_MAX));
    return [...tests].map(test => ({ ...entry, test }));
  }), { nowMs });
}

/** Fired reruns (ok call rows) still awaiting a run verdict, oldest first. */
function pendingVerdicts(entries: readonly Entry[], nowMs: number): Entry[] {
  const verdicted = new Set<string>();
  const fired = new Map<string, Entry>();
  for (const e of entries) {
    const key = rerunKey(e);
    if (e.outcome === 'verdict') verdicted.add(key);
    else if (e.outcome === 'ok') {
      const prev = fired.get(key);
      if (!prev || Date.parse(e.at) >= Date.parse(prev.at)) fired.set(key, e);
    }
  }
  return [...fired.values()]
    .filter(e => !verdicted.has(rerunKey(e)) && Date.parse(e.at) >= nowMs - VERDICT_MAX_AGE_MS)
    .sort(compareVerdictPosition);
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
      const buffer = Buffer.alloc(size - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n');
      if (start) lines.shift();
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
  const attempts = entries.filter(e => e.outcome === 'attempt');
  const verdictTally = { pass: 0, fail: 0, inconclusive: 0 };
  for (const e of entries) if (e.outcome === 'verdict' && e.verdict) verdictTally[e.verdict]++;
  const resolved = verdictTally.pass + verdictTally.fail;
  return { entries, recent: entries.slice(-100), counts: { attempted: attempts.length, ok: entries.filter(e => e.outcome === 'ok').length, failed: entries.filter(e => e.outcome === 'failed').length }, lastHour: attempts.filter(e => Date.parse(e.at) > now - 3_600_000).length, recurringFlakes: summarizeFlakes(entries, now), verdicts: { ...verdictTally, pending: pendingVerdicts(entries, now).length, resolutionRate: resolved > 0 ? verdictTally.pass / resolved : null } };
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
      const s: RepoStatus = { groups: 0, attempted: 0, ok: 0, failed: 0, skippedDuplicate: 0, skippedCap: 0, queued: 0, flakeFixesQueued: 0, recurringFlakes: 0, verdictsPending: 0, verdictsResolved: 0, queueBlocked: null, errors: [] };
      s.verdictCursor = previous?.repos?.[repo]?.verdictCursor;
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
        for (const group of report.groups) {
          // A shortened or redacted ID can collide with a different test.
          const test = rerunGroups.has(group) && typeof group.testId === 'string'
            && group.testId.length <= JOURNAL_TEST_MAX && scrubSecrets(group.testId) === group.testId
            ? group.testId
            : '';
          for (const run of group.runs) {
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
        for (const group of eligibleGroups) {
          opts.signal.throwIfAborted();
          for (const run of group.runs) {
            opts.signal.throwIfAborted();
            if (journal.some(e => e.repo === repo && e.head === run.head && e.runId === run.runId)) { s.skippedDuplicate++; continue; }
            const cap = opts.maxPerHour ?? 10;
            if (!Number.isFinite(cap) || journal.filter(e => e.outcome === 'attempt' && Date.parse(e.at) > now() - 3_600_000).length >= Math.max(0, cap)) { s.skippedCap++; continue; }
            const entry: Entry = { at: new Date(now()).toISOString(), repo, ...run, outcome: 'attempt' };
            const tests = [...(testsByRun.get(rerunKey(entry)) ?? [])];
            if (tests.length === 1) entry.test = tests[0];
            else if (tests.length > 1) entry.tests = tests;
            append(entry);
            s.attempted++;
            let ok = false;
            try { ok = (await gh(['run', 'rerun', String(run.runId), '--failed', '--repo', repo])).ok; }
            catch (error) { if (opts.signal.aborted) throw error; }
            // A failed-job rerun can include failures outside the triggering flakes.
            const test = runsWithOtherFailures.has(rerunKey(entry)) ? undefined : entry.test;
            append({ ...entry, test, tests: undefined, at: new Date(now()).toISOString(), outcome: ok ? 'ok' : 'failed' });
            if (ok) s.ok++; else s.failed++;
          }
        }
        opts.signal.throwIfAborted();
        const flakes = summarizeFlakes(journal.filter(e => e.repo === repo), now());
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
        const pending = pendingVerdicts(journal.filter(e => e.repo === repo), now());
        s.verdictsPending = pending.length;
        const eligible = pending.filter(e => Date.parse(e.at) <= now() - VERDICT_MIN_AGE_MS);
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
          append({ at: new Date(observedAt).toISOString(), repo: p.repo, head: p.head, runId: p.runId, pr: p.pr, outcome: 'verdict', verdict, ...(p.test ? { test: p.test } : {}) });
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
