/**
 * Tests for `ci-receipt-retry-batch` — the retry verb that selects
 * failed and not-started entries from a previous `ci-receipt-await-batch`
 * report and passes them once to awaitCiReceiptBatch.
 *
 * Fake runners only; no network, real HOME or sleeping.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cmdFleetCiReceiptRetryBatch } from '../src/cli/fleet-ci-receipt-retry-batch.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';
import { parseCiReceiptRetryBatchInput, retryCiReceiptBatch } from '../src/core/fleet/ci-receipt-retry-batch.js';
import { awaitCiReceiptBatch } from '../src/core/fleet/ci-receipt-await-batch.js';
import type { GitRunner, GitRunResult } from '../src/core/verse/git-ops.js';

const SHA = 'a'.repeat(40);
const DIGEST = `sha256:${'b'.repeat(64)}`;

interface T { repo: string; run: number; attempt: number; artifactName: string; art: number }
const T1: T = { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', art: 77 };
const T2: T = { repo: 'ashlrai/phantom', run: 992, attempt: 1, artifactName: 'ci-resume-receipts', art: 78 };
const T3: T = { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', art: 88 };

const jobRow = (t: T, id: number, name: string, conclusion: string) =>
  ({ id, run_id: t.run, run_attempt: t.attempt, name, status: 'completed', conclusion, head_sha: SHA });
const receiptRow = (t: T, job: string, jobId: number, conclusion: string) =>
  ({ job, run: t.run, attempt: t.attempt, jobId, headSha: SHA, conclusion, inputsDigest: DIGEST });
const artifactRow = (t: T, expired = false, runId = t.run) =>
  ({ id: t.art, name: t.artifactName, expired, size_in_bytes: 1234, workflow_run: { id: runId } });
const attemptMeta = (t: T, status: string, attempt = t.attempt) =>
  ({ id: t.run, run_attempt: attempt, head_sha: SHA, status,
    conclusion: status === 'completed' ? 'failure' : null, repository: { full_name: t.repo } });
const runMeta = (t: T) => ({ id: t.run, run_attempt: t.attempt + 1, head_sha: SHA, status: 'completed',
  conclusion: 'failure', repository: { full_name: t.repo } });
const artifactMeta = (t: T) => ({ id: t.art, name: t.artifactName, size_in_bytes: 1234, expired: false,
  workflow_run: { id: t.run } });
const jobsPage = (t: T) =>
  [{ total_count: 2, jobs: [jobRow(t, t.run * 10 + 1, 'job-a', 'success'), jobRow(t, t.run * 10 + 2, 'job-b', 'failure')] }];
const emptyPage = [{ total_count: 0, artifacts: [] }];
const presentPage = (t: T) => [{ total_count: 1, artifacts: [artifactRow(t)] }];
const priorDoc = (t: T) => ({ version: 1, repo: t.repo,
  receipts: [receiptRow(t, 'job-a', t.run * 10 + 1, 'success'), receiptRow(t, t.run * 10 + 2, 'job-b', 'failure')] });
const attemptUrl = (t: T) => `repos/${t.repo}/actions/runs/${t.run}/attempts/${t.attempt}`;
const artifactsUrl = (t: T) => `repos/${t.repo}/actions/runs/${t.run}/artifacts?per_page=100`;

const ok = (stdout: string): GitRunResult =>
  ({ code: 0, stdout, stderr: '', timedOut: false, truncated: false, missing: false });
const bad = (over: Partial<GitRunResult> = {}): GitRunResult =>
  ({ code: 1, stdout: '', stderr: 'HTTP 404: Not Found', timedOut: false, truncated: false, missing: false, ...over });
type Call = { bin: string; args: string[] };
interface FakeRun {
  t: T;
  attemptQueue?: GitRunResult[];
  artifactsQueue?: GitRunResult[];
  onAttemptRead?: () => void;
  run?: GitRunResult; artifact?: GitRunResult; jobs?: GitRunResult;
  downloadBody?: string | null;
}
const pop = (q: GitRunResult[] | undefined): GitRunResult | undefined =>
  q === undefined ? undefined : q.length > 1 ? q.shift()! : q[0]!;

const fakeGh = (runs: FakeRun[], calls: Call[], reads = { inFlight: 0, max: 0 }): GitRunner => async (bin, args) => {
  reads.inFlight += 1; reads.max = Math.max(reads.max, reads.inFlight);
  try {
    calls.push({ bin, args: [...args] });
    if (bin !== 'gh') return bad();
    const url = args.find((a) => a.startsWith('repos/')) ?? '';
    const f = runs.find((r) => url.startsWith(`repos/${r.t.repo}/actions/runs/${r.t.run}`)
      || url === `repos/${r.t.repo}/actions/artifacts/${r.t.art}`);
    if (args[0] === 'api') {
      if (!f) return bad();
      const t = f.t;
      if (url === attemptUrl(t)) { f.onAttemptRead?.(); return pop(f.attemptQueue) ?? ok(JSON.stringify(attemptMeta(t, 'completed'))); }
      if (url === artifactsUrl(t)) return pop(f.artifactsQueue) ?? ok(JSON.stringify(presentPage(t)));
      if (url === `repos/${t.repo}/actions/runs/${t.run}`) return f.run ?? ok(JSON.stringify(runMeta(t)));
      if (url === `repos/${t.repo}/actions/artifacts/${t.art}`) return f.artifact ?? ok(JSON.stringify(artifactMeta(t)));
      if (url === `repos/${t.repo}/actions/runs/${t.run}/attempts/${t.attempt}/jobs?per_page=100`) {
        return f.jobs ?? ok(JSON.stringify(jobsPage(t)));
      }
      return bad();
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dl = runs.find((r) => r.t.repo === args[args.indexOf('--repo') + 1] && String(r.t.run) === args[2]);
      if (!dl) return bad();
      if (dl.downloadBody !== undefined && dl.downloadBody !== null) {
        writeFileSync(join(args[args.indexOf('--dir') + 1]!, 'receipts.json'), dl.downloadBody);
      }
      return ok('');
    }
    return bad();
  } finally { reads.inFlight -= 1; }
};

const fakeClock = () => {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
};

const streamIn = (doc: string | Buffer, pieces = 5): AsyncIterable<Uint8Array> => (async function* () {
  const buf = Buffer.isBuffer(doc) ? doc : Buffer.from(doc, 'utf8');
  const step = Math.max(1, Math.ceil(buf.length / pieces));
  for (let i = 0; i < buf.length; i += step) yield buf.subarray(i, i + step);
})();

let out: string[]; let err: string[];
beforeEach(() => {
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((v) => { out.push(String(v)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((v) => { err.push(String(v)); return true; });
});
afterEach(() => { vi.restoreAllMocks(); });

const apiCalls = (calls: Call[]) =>
  calls.filter((c) => c.bin === 'gh' && c.args[0] === 'api').map((c) => c.args.at(-1)!);
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE', 'rerun', 'dispatch', 'delete', 'cancel', 'enable', 'disable',
  'create', 'update', 'approve', 'set', 'sign'];
const mutations = (calls: Call[]) =>
  calls.filter((c) => c.bin === 'gh' && c.args.length > 0
    && MUTATING.some(m => c.args[0]?.includes(m) || c.args.some(a => a.startsWith(m)))).map((c) => c.args.slice(0, 3));

/** Short timeout used for tests that need real polling (4 polls = 1s at 250ms). */
const SHORT_ARGS = ['--stdin', '--timeout-ms', '1000', '--poll-ms', '250', '--json'];
const LONG_ARGS = ['--stdin', '--timeout-ms', '60000', '--poll-ms', '250', '--json'];

/** Build a batch report by calling awaitCiReceiptBatch with injected fake outcomes. */
const buildReport = async (
  runs: FakeRun[],
  targetList: Array<{ repo: string; run: number; attempt: number; artifactName: string }>,
  calls: Call[],
  opts = { timeoutMs: 60000, pollMs: 250 },
) => awaitCiReceiptBatch(targetList, opts, { gh: fakeGh(runs, calls) });

/** Build a mock previous batch report with mixed outcomes for retry. */
function buildBatchReport(entries: Array<{
  repo: string; run: number; attempt: number; artifactName: string;
  outcome: 'bound' | 'failed' | 'not-started';
  prior: { version: number; repo: string; receipts: Array<{ job: string; run: number; attempt: number; jobId: number; headSha: string; conclusion: string; inputsDigest: string }> } | null;
  reason: string | null;
}>): string {
  const bound = entries.filter(e => e.outcome === 'bound').length;
  const failed = entries.filter(e => e.outcome === 'failed').length;
  const notStarted = entries.filter(e => e.outcome === 'not-started').length;
  return JSON.stringify({
    version: 1, total: entries.length, bound, failed, notStarted,
    timedOut: entries.some(e => e.outcome === 'not-started' && e.reason?.includes('deadline')),
    aborted: entries.some(e => e.outcome === 'not-started' && e.reason?.includes('aborted')),
    entries,
  });
}

const cli = async (args: string[], deps?: Record<string, unknown>) => {
  out = []; err = [];
  return { code: await cmdFleetCiReceiptRetryBatch(args, deps as any), out: out.join('\n'), err: err.join('') };
};

describe('ci-receipt-retry-batch', () => {
  describe('parsing', () => {
    it('rejects JSON that is not an object', () => {
      expect(parseCiReceiptRetryBatchInput('[]')).toEqual({ ok: false, reason: 'not_object' });
      expect(parseCiReceiptRetryBatchInput('42')).toEqual({ ok: false, reason: 'not_object' });
    });

    it('rejects unknown or missing fields', () => {
      const base = { version: 1, total: 1, bound: 1, failed: 0, notStarted: 0, timedOut: false, aborted: false, entries: [] as unknown[] };
      expect(parseCiReceiptRetryBatchInput(JSON.stringify({ ...base, extra: 1 }))).toEqual({ ok: false, reason: 'unknown_or_missing_fields' });
      const partial = { version: 1, total: 1, bound: 1 };
      expect(parseCiReceiptRetryBatchInput(JSON.stringify(partial))).toEqual({ ok: false, reason: 'unknown_or_missing_fields' });
    });

    it('rejects malformed counts (sum mismatch)', () => {
      const report = { version: 1, total: 1, bound: 0, failed: 1, notStarted: 1, timedOut: false, aborted: false, entries: [] as unknown[] };
      expect(parseCiReceiptRetryBatchInput(JSON.stringify(report))).toEqual({ ok: false, reason: 'malformed_counts' });
    });

    it('accepts a valid empty report (no unresolved targets)', () => {
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'bound', prior: null, reason: null },
      ]);
      const parsed = parseCiReceiptRetryBatchInput(report);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.targets).toHaveLength(0);
    });

    it('accepts a valid report with failed entries', () => {
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'failed', prior: null, reason: '404 Not Found' },
        { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', outcome: 'not-started', prior: null, reason: 'batch deadline expired' },
      ]);
      const parsed = parseCiReceiptRetryBatchInput(report);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.targets).toHaveLength(2);
        expect(parsed.targets[0].repo).toBe('ashlrai/phantom');
        expect(parsed.targets[0].run).toBe(991);
        expect(parsed.targets[1].repo).toBe('ashlrai/other');
      }
    });

    it('rejects duplicate identities even when one entry is bound', () => {
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'bound', prior: null, reason: null },
        { repo: 'ashlrai/PHANTOM', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'failed', prior: null, reason: 'timeout' },
      ]);
      const parsed = parseCiReceiptRetryBatchInput(report);
      expect(parsed).toEqual({ ok: false, reason: 'target_invalid' });
    });
  });

  describe('CLI', () => {
    it('exits 2 on missing --stdin flag', async () => {
      const calls: Call[] = [];
      expect((await cli(['--timeout-ms', '60000', '--poll-ms', '250', '--json'],
        { gh: fakeGh([], calls) })).code).toBe(2);
    });

    it('exits 2 on invalid flags', async () => {
      expect((await cli(['--stdin', '--timeout-ms', '0', '--poll-ms', '250', '--json'],
        { gh: fakeGh([], []) })).code).toBe(2);
    });

    it('exits 2 on oversize input', async () => {
      const big = Buffer.alloc(64 * 1024 + 1, 0x20);
      expect((await cli(LONG_ARGS, { gh: fakeGh([], []), input: streamIn(big, 2) })).code).toBe(2);
    });

    it('exits 2 on bad UTF-8 in previous report', async () => {
      const badU8 = Buffer.concat([
        Buffer.from('{"version":1,"total":1,"bound":0,"failed":1,"notStarted":0,"timedOut":false,"aborted":false,"entries":['),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(']}')]);
      expect((await cli(LONG_ARGS, { gh: fakeGh([], []), input: streamIn(badU8) })).code).toBe(2);
    });

    it('exits 0 when all reported targets are bound (no retry needed)', async () => {
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'bound',
          prior: { version: 1, repo: 'ashlrai/phantom', receipts: [] }, reason: null },
      ]);
      const calls: Call[] = [];
      const result = await cli(LONG_ARGS, { gh: fakeGh([], calls), input: streamIn(report) });
      expect(result.code).toBe(0);
      expect(calls).toHaveLength(0); // zero network reads
      const rpt = JSON.parse(result.out);
      expect(rpt.bound).toBe(0);
      expect(rpt.total).toBe(0);
      expect(rpt.entries).toHaveLength(0);
    });

    it('retries a single failed entry through awaitCiReceiptBatch', async () => {
      const calls: Call[] = [];
      const reports = { inFlight: 0, max: 0 };
      const clock = fakeClock();
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'failed',
          prior: null, reason: '404 Not Found' },
      ]);
      // 4 polls in 1s (in_progress + empty). The target runs and fails.
      // Verify the injected gh and clock are used (8 API calls).
      const result = await cli(SHORT_ARGS, {
        input: streamIn(report),
        gh: fakeGh([{
          t: T1,
          attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
          artifactsQueue: [ok(JSON.stringify(emptyPage))],
        }], calls, reports),
        now: clock.now, sleep: clock.sleep,
      });
      expect(result.code).toBe(1);
      const rpt = JSON.parse(result.out);
      expect(rpt.total).toBe(1);
      // Target ran and failed within 1s (not not-started).
      expect(rpt.failed).toBe(1);
      expect(rpt.notStarted).toBe(0);
      // 4 polls × 2 endpoints = 8 API calls
      expect(apiCalls(calls)).toHaveLength(8);
      // All calls target T1's repo/run
      const expectedCalls = [...Array(4)].flatMap(() => [attemptUrl(T1), artifactsUrl(T1)]);
      expect(apiCalls(calls)).toEqual(expectedCalls);
      expect(mutations(calls)).toEqual([]);
    });

    it('outputs a valid empty report when no unresolved targets exist', async () => {
      const report = buildBatchReport([]);
      const calls: Call[] = [];
      const result = await cli(LONG_ARGS, { gh: fakeGh([], calls), input: streamIn(report) });
      expect(result.code).toBe(0);
      const rpt = JSON.parse(result.out);
      expect(rpt.version).toBe(1);
      expect(rpt.total).toBe(0);
      expect(rpt.bound).toBe(0);
      expect(rpt.failed).toBe(0);
      expect(rpt.notStarted).toBe(0);
      expect(rpt.entries).toHaveLength(0);
    });

    it('skips bound entries and retries only failed/not-started', async () => {
      const calls: Call[] = [];
      const reports = { inFlight: 0, max: 0 };
      const clock = fakeClock();
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'bound',
          prior: { version: 1, repo: 'ashlrai/phantom', receipts: [] }, reason: null },
        { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', outcome: 'failed',
          prior: null, reason: 'timeout' },
      ]);
      // 4 polls with in_progress + empty → T3 fails (not bound in 1s).
      const result = await cli(SHORT_ARGS, {
        input: streamIn(report),
        gh: fakeGh([{
          t: T3,
          attemptQueue: [ok(JSON.stringify(attemptMeta(T3, 'in_progress')))],
          artifactsQueue: [ok(JSON.stringify(emptyPage))],
        }], calls, reports),
        now: clock.now, sleep: clock.sleep,
      });
      expect(result.code).toBe(1);
      const rpt = JSON.parse(result.out);
      expect(rpt.total).toBe(1); // only the retried target
      expect(rpt.failed).toBe(1); // T3 ran and failed (in_progress + empty)
      expect(rpt.notStarted).toBe(0);
      // Only calls for T3 (run 55) — T1 (bound) caused zero reads
      expect(calls.filter(c => c.args.some(a => a.includes('55')))).toHaveLength(8);
      expect(calls.filter(c => c.args.some(a => a.includes('991')))).toHaveLength(0);
    });

    it('handles a partial retry failure: bound stays, failed retries', async () => {
      const calls: Call[] = [];
      const reports = { inFlight: 0, max: 0 };
      const clock = fakeClock();
      // 4 polls per target in 1s. 3 unresolved targets sent to retry.
      // With single-element queues all 4 polls get the same response
      // (in_progress + empty), so T3 runs and fails, and 2 other targets
      // are not-started (deadline expired before they started).
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'bound',
          prior: { version: 1, repo: 'ashlrai/phantom', receipts: [] }, reason: null },
        { repo: 'ashlrai/phantom', run: 992, attempt: 1, artifactName: 'ci-resume-receipts', outcome: 'bound',
          prior: { version: 1, repo: 'ashlrai/phantom', receipts: [] }, reason: null },
        { repo: 'ashlrai/other', run: 55, attempt: 3, artifactName: 'receipts-pack', outcome: 'failed',
          prior: null, reason: '404' },
        { repo: 'ashlrai/other', run: 56, attempt: 1, artifactName: 'receipts-pack', outcome: 'failed',
          prior: null, reason: 'timeout' },
        { repo: 'ashlrai/zeta', run: 100, attempt: 1, artifactName: 'receipts-pack', outcome: 'not-started',
          prior: null, reason: 'deadline expired' },
      ]);
      // Only T3 has a runner (single-element queues → all 4 polls same response).
      const result = await cli(SHORT_ARGS, {
        input: streamIn(report),
        gh: fakeGh([{
          t: T3,
          attemptQueue: [ok(JSON.stringify(attemptMeta(T3, 'in_progress')))],
          artifactsQueue: [ok(JSON.stringify(emptyPage))],
        }], calls, reports),
        now: clock.now, sleep: clock.sleep,
      });
      expect(result.code).toBe(1);
      const rpt = JSON.parse(result.out);
      // 3 targets sent to retry. T3 runs and fails (1s exhausted).
      // 2 targets never start (deadline expired before they could).
      expect(rpt.total).toBe(3);
      expect(rpt.failed).toBe(1);  // T3 ran but didn't bind
      expect(rpt.notStarted).toBe(2); // deadline expired before these 2 started
    });

    it('supports a second retry pipe: bound report feeds another retry attempt', async () => {
      const calls: Call[] = [];
      const reports = { inFlight: 0, max: 0 };
      const clock = fakeClock();
      // First retry: 1 target, runs and fails in 1s (in_progress + empty).
      const report1 = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 991, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'failed',
          prior: null, reason: '404 Not Found' },
      ]);
      // Run first retry — target runs and fails in 1s.
      const result1 = await cli(SHORT_ARGS, {
        input: streamIn(report1),
        gh: fakeGh([{
          t: T1,
          attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
          artifactsQueue: [ok(JSON.stringify(emptyPage))],
        }], calls, reports),
        now: clock.now, sleep: clock.sleep,
      });
      expect(result1.code).toBe(1);
      const rpt1 = JSON.parse(result1.out);
      expect(rpt1.total).toBe(1);
      expect(rpt1.failed).toBe(1);  // ran and failed
      expect(rpt1.notStarted).toBe(0);

      // Pipe the first retry output to a second retry.
      const calls2: Call[] = [];
      const reports2 = { inFlight: 0, max: 0 };
      const clock2 = fakeClock();
      const result2 = await cli(SHORT_ARGS, {
        input: streamIn(JSON.stringify(rpt1)),
        gh: fakeGh([{
          t: T1,
          attemptQueue: [ok(JSON.stringify(attemptMeta(T1, 'in_progress')))],
          artifactsQueue: [ok(JSON.stringify(emptyPage))],
        }], calls2, reports2),
        now: clock2.now, sleep: clock2.sleep,
      });
      expect(result2.code).toBe(1);
      const rpt2 = JSON.parse(result2.out);
      expect(rpt2.total).toBe(1);
      expect(rpt2.failed).toBe(1);  // ran and failed again
      // API calls happened — boundary case: retry after retry works.
      expect(apiCalls(calls2)).toHaveLength(8);
    });

    it('rejects oversized retry lists (>16 targets)', () => {
      const entries = Array(17).fill(null).map((_, i) => ({
        repo: `ashlrai/repo${i}`, run: i + 1, attempt: 1,
        artifactName: 'ci-resume-receipts', outcome: 'failed', prior: null, reason: 'test',
      }));
      const report = buildBatchReport(entries);
      expect(parseCiReceiptRetryBatchInput(report)).toEqual({ ok: false, reason: 'retry_target_count' });
    });

    it('rejects a report where entries contain non-object items', () => {
      const report = JSON.stringify({
        version: 1, total: 2, bound: 0, failed: 2, notStarted: 0,
        timedOut: false, aborted: false, entries: [
          { repo: 'ashlrai/phantom', run: 1, attempt: 1, artifactName: 'ci-resume-receipts', outcome: 'failed', prior: null, reason: '' },
          null,
        ],
      });
      expect(parseCiReceiptRetryBatchInput(report)).toEqual({ ok: false, reason: 'target_invalid' });
    });

    it('handles malformed counts (negative total)', () => {
      const report = JSON.stringify({
        version: 1, total: -1, bound: 0, failed: 0, notStarted: 0,
        timedOut: false, aborted: false, entries: [] as unknown[],
      });
      expect(parseCiReceiptRetryBatchInput(report)).toEqual({ ok: false, reason: 'malformed_counts' });
    });

    it('rejects entries with invalid field values', () => {
      const report = buildBatchReport([
        { repo: 'ashlrai/phantom', run: 0, attempt: 2, artifactName: 'ci-resume-receipts', outcome: 'failed', prior: null, reason: '' },
      ]);
      expect(parseCiReceiptRetryBatchInput(report)).toEqual({ ok: false, reason: 'target_invalid' });
    });
  });
});
