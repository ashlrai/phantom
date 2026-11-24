import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCiRerunMaintenance, readCiReruns, readCiRerunStatus } from '../src/core/fleet/ci-rerun.js';
import type { CiRerunOptions } from '../src/core/fleet/ci-rerun.js';
import { cmdCiBaseline } from '../src/cli/ci-baseline.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function setup(classification = 'probable-flake') {
  const dir = mkdtempSync(join(tmpdir(), 'ci-rerun-')); dirs.push(dir);
  const report = { v: 1, repo: 'org/repo', groups: [{ file: 'test/a.test.ts', names: 'a', testId: 'test/a.test.ts > a', excerpt: '', classification, action: classification === 'shared-baseline' ? 'queue-master-fix' : 'rerun-failed', runs: [{ pr: 1, head: 'a'.repeat(40), runId: 123 }], prs: [1], unaffectedPrs: [1], master: 'pass', jobId: 'RQ-CIBASE-TEST', brief: 'fix baseline' }], freshness: [], master: { head: 'b'.repeat(40), known: true }, updates: [], errors: [] };
  const gh = vi.fn(async (_args: string[]) => ({ ok: true, stdout: '', stderr: '' }));
  const opts: CiRerunOptions = { repos: ['org/repo'], signal: new AbortController().signal, gh, analyzer: async () => report, now: () => Date.parse('2026-01-01T12:00:00Z'), journalPath: join(dir, 'journal.jsonl'), statusPath: join(dir, 'status.json'), queueFile: join(dir, 'queue.md'), autonomyEffective: () => true, killOff: () => true };
  return { opts, gh, report };
}

describe('resident CI reruns', () => {
  it('journals before rerunning, deduplicates repeated ticks, permits a new head', async () => {
    const { opts, gh, report } = setup();
    gh.mockImplementation(async () => {
      expect(readCiReruns(opts.journalPath, opts.now!()).recent.at(-1)?.outcome).toBe('attempt');
      return { ok: true, stdout: '', stderr: '' };
    });
    await runCiRerunMaintenance(opts);
    expect(gh.mock.calls).toEqual([[['run', 'rerun', '123', '--failed', '--repo', 'org/repo']]]);
    const second = await runCiRerunMaintenance(opts);
    expect(second.repos['org/repo']?.skippedDuplicate).toBe(1);
    expect(gh).toHaveBeenCalledTimes(1);
    report.groups[0]!.runs[0]!.head = 'c'.repeat(40);
    await runCiRerunMaintenance(opts);
    expect(gh).toHaveBeenCalledTimes(2);
  });
  it('enforces a global hourly cap across repos and expires old attempts', async () => {
    const { opts, gh } = setup();
    opts.repos.push('org/other'); opts.maxPerHour = 1;
    const reruns = () => gh.mock.calls.filter(call => call[0][0] === 'run');
    const status = await runCiRerunMaintenance(opts);
    expect(reruns()).toHaveLength(1);
    expect(status.repos['org/other']?.skippedCap).toBe(1);
    opts.now = () => Date.parse('2026-01-01T13:01:00Z');
    await runCiRerunMaintenance(opts);
    expect(reruns()).toHaveLength(2);
  });
  it.each(['pr-caused', 'shared-baseline', 'unknown'])('never reruns %s', async kind => {
    const { opts, gh } = setup(kind);
    await runCiRerunMaintenance(opts);
    expect(gh).not.toHaveBeenCalled();
  });
  it.each([[false, true, 'autonomy-off'], [true, false, 'kill-on-or-unknown'], [true, true, null]])('gates baseline queueing (%s, %s)', async (authority, kill, reason) => {
    const { opts } = setup('shared-baseline');
    opts.autonomyEffective = () => authority; opts.killOff = () => kill;
    const status = await runCiRerunMaintenance(opts);
    expect(status.repos['org/repo']?.queueBlocked).toBe(reason);
    expect(status.repos['org/repo']?.queued).toBe(reason ? 0 : 1);
    if (!reason) expect(readFileSync(opts.queueFile!, 'utf8')).toContain('RQ-CIBASE-TEST');
  });
  it('does no work on an aborted deadline and persists aborted status', async () => {
    const { opts, gh } = setup();
    opts.signal = AbortSignal.abort();
    const result = await runCiRerunMaintenance(opts);
    expect(gh).not.toHaveBeenCalled();
    expect(result.status).toBe('aborted');
    expect(readCiRerunStatus(opts.statusPath)?.status).toBe('aborted');
  });
  it('guards analyzer gh calls after abort', async () => {
    const { opts, gh } = setup();
    const controller = new AbortController(); opts.signal = controller.signal;
    opts.analyzer = async (_repo, guardedGh) => { controller.abort(); await guardedGh!(['api', 'test']); throw new Error('unreachable'); };
    expect((await runCiRerunMaintenance(opts)).status).toBe('aborted');
    expect(gh).not.toHaveBeenCalled();
  });
  it('settles an in-flight GitHub call on deadline without another call', async () => {
    const { opts, gh } = setup();
    const controller = new AbortController(); opts.signal = controller.signal;
    gh.mockImplementation(async () => {
      controller.abort(new Error('deadline exceeded'));
      return new Promise<never>(() => undefined);
    });
    const status = await runCiRerunMaintenance(opts);
    expect(status.status).toBe('aborted');
    expect(gh).toHaveBeenCalledTimes(1);
    expect(readCiReruns(opts.journalPath, opts.now!()).counts.attempted).toBe(1);
  });
  it('reads an empty journal from the CLI without calling GitHub', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await cmdCiBaseline(['reruns', '--json'])).toBe(0);
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ recent: [], lastHour: 0 });
    } finally { log.mockRestore(); }
  });
  it('records failure without retrying and tolerates malformed journal lines', async () => {
    const { opts, gh } = setup();
    gh.mockRejectedValue(new Error('unavailable'));
    expect((await runCiRerunMaintenance(opts)).repos['org/repo']?.failed).toBe(1);
    appendFileSync(opts.journalPath!, '\ninvalid\n{}\n');
    await runCiRerunMaintenance(opts);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(readCiReruns(opts.journalPath, opts.now!()).counts).toEqual({ attempted: 1, ok: 0, failed: 1 });
  });
  it('handles empty analysis and analysis errors', async () => {
    const { opts, report, gh } = setup(); report.groups = [];
    expect((await runCiRerunMaintenance(opts)).repos['org/repo']?.groups).toBe(0);
    opts.analyzer = async () => { throw new Error('analysis unavailable'); };
    expect((await runCiRerunMaintenance(opts)).repos['org/repo']?.errors).toEqual(['analysis unavailable']);
    expect(gh).not.toHaveBeenCalled();
  });
  it('stamps the failing test on attempt rows and queues a recurring flake after three heads', async () => {
    const { opts, report } = setup();
    const heads = ['a'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)];
    for (const [i, head] of heads.entries()) {
      report.groups[0]!.runs[0]!.head = head;
      report.groups[0]!.runs[0]!.runId = 123 + i;
      const status = await runCiRerunMaintenance(opts);
      expect(status.repos['org/repo']?.recurringFlakes).toBe(i === 2 ? 1 : 0);
      expect(status.repos['org/repo']?.flakeFixesQueued).toBe(i === 2 ? 1 : 0);
    }
    const journal = readFileSync(opts.journalPath!, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const attempts = journal.filter((row: { outcome: string }) => row.outcome === 'attempt');
    expect(attempts).toHaveLength(3);
    expect(attempts.every((row: { test?: string }) => row.test === 'test/a.test.ts > a')).toBe(true);
    const queue = readFileSync(opts.queueFile!, 'utf8');
    expect(queue).toContain('- READY RQ-CIFLAKE-');
    expect(queue).toContain('test/a.test.ts > a');
    expect(queue).toContain('3 distinct heads');
    const read = readCiReruns(opts.journalPath!, opts.now!());
    expect(read.recurringFlakes).toHaveLength(1);
    expect(read.recurringFlakes[0]).toMatchObject({ repo: 'org/repo', attempts: 3 });
    expect(read.recurringFlakes[0]!.heads).toEqual([...heads].sort());
  });
  it('reports recurring flakes without queueing them while authority or KILL blocks writes', async () => {
    const { opts, report } = setup();
    opts.autonomyEffective = () => false;
    for (const [i, head] of ['a'.repeat(40), 'c'.repeat(40), 'd'.repeat(40)].entries()) {
      report.groups[0]!.runs[0]!.head = head;
      report.groups[0]!.runs[0]!.runId = 200 + i;
      const status = await runCiRerunMaintenance(opts);
      expect(status.repos['org/repo']?.recurringFlakes).toBe(i === 2 ? 1 : 0);
    }
    const status = await runCiRerunMaintenance(opts);
    expect(status.repos['org/repo']?.queueBlocked).toBe('autonomy-off');
    expect(status.repos['org/repo']?.flakeFixesQueued).toBe(0);
    let queue = '';
    try { queue = readFileSync(opts.queueFile!, 'utf8'); } catch { /* absent */ }
    expect(queue).not.toContain('RQ-CIFLAKE-');
  });
  it('resolves a fired rerun to a pass verdict on a later pass and reports it once', async () => {
    const { opts, gh } = setup();
    await runCiRerunMaintenance(opts);
    opts.now = () => Date.parse('2026-01-01T12:10:00Z');
    gh.mockImplementation(async (args: string[]) => args[0] === 'api'
      ? { ok: true, stdout: JSON.stringify({ status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), updated_at: '2026-01-01T12:09:00Z' }), stderr: '' }
      : { ok: true, stdout: '', stderr: '' });
    const status = await runCiRerunMaintenance(opts);
    expect(status.repos['org/repo']?.verdictsResolved).toBe(1);
    const verdictRows = readFileSync(opts.journalPath!, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter((row: { outcome?: string }) => row.outcome === 'verdict');
    expect(verdictRows).toHaveLength(1);
    expect(verdictRows[0]).toMatchObject({ repo: 'org/repo', head: 'a'.repeat(40), runId: 123, pr: 1, verdict: 'pass', test: 'test/a.test.ts > a' });
    const read = readCiReruns(opts.journalPath!, opts.now!());
    expect(read.verdicts).toMatchObject({ pass: 1, fail: 0, inconclusive: 0, pending: 0 });
    expect(read.verdicts.resolutionRate).toBe(1);
    await runCiRerunMaintenance(opts);
    expect(gh.mock.calls.filter(call => call[0][0] === 'api')).toHaveLength(1);
  });
  it('maps run conclusions to fail and inconclusive and skips running or stale reads', async () => {
    const { opts, gh, report } = setup();
    report.groups[0]!.runs.push(
      { pr: 2, head: 'b'.repeat(40), runId: 124 },
      { pr: 3, head: 'c'.repeat(40), runId: 125 },
      { pr: 4, head: 'd'.repeat(40), runId: 126 },
    );
    await runCiRerunMaintenance(opts);
    expect(gh.mock.calls.filter(call => call[0][0] === 'run')).toHaveLength(4);
    opts.now = () => Date.parse('2026-01-01T12:10:00Z');
    const payloads: Record<string, unknown> = {
      '123': { status: 'completed', conclusion: 'failure', head_sha: 'a'.repeat(40), updated_at: '2026-01-01T12:09:00Z' },
      '124': { status: 'completed', conclusion: 'cancelled', head_sha: 'b'.repeat(40), updated_at: '2026-01-01T12:09:00Z' },
      '125': { status: 'in_progress', conclusion: null, head_sha: 'c'.repeat(40), updated_at: '2026-01-01T12:09:00Z' },
      '126': { status: 'completed', conclusion: 'success', head_sha: 'd'.repeat(40), updated_at: '2026-01-01T11:00:00Z' },
    };
    gh.mockImplementation(async (args: string[]) => args[0] === 'api'
      ? { ok: true, stdout: JSON.stringify(payloads[args[1]!.split('/').pop()!] ?? {}), stderr: '' }
      : { ok: true, stdout: '', stderr: '' });
    const status = await runCiRerunMaintenance(opts);
    expect(status.repos['org/repo']?.verdictsResolved).toBe(2);
    const read = readCiReruns(opts.journalPath!, opts.now!());
    expect(read.verdicts).toMatchObject({ pass: 0, fail: 1, inconclusive: 1, pending: 2 });
    expect(read.verdicts.resolutionRate).toBe(0);
  });
  it('does not check reruns inside the settle window and never resolves failed calls', async () => {
    const { opts, gh } = setup();
    await runCiRerunMaintenance(opts);
    opts.now = () => Date.parse('2026-01-01T12:03:00Z');
    gh.mockClear();
    const status = await runCiRerunMaintenance(opts);
    expect(status.repos['org/repo']?.verdictsPending).toBe(1);
    expect(gh.mock.calls.filter(call => call[0][0] === 'api')).toHaveLength(0);
    expect(readCiReruns(opts.journalPath!, opts.now!()).verdicts.pending).toBe(1);
    const failing = setup();
    failing.gh.mockRejectedValue(new Error('unavailable'));
    await runCiRerunMaintenance(failing.opts);
    failing.opts.now = () => Date.parse('2026-01-01T12:10:00Z');
    failing.gh.mockResolvedValue({ ok: true, stdout: '', stderr: '' });
    const failedStatus = await runCiRerunMaintenance(failing.opts);
    expect(failedStatus.repos['org/repo']?.verdictsPending).toBe(0);
    expect(failing.gh.mock.calls.filter(call => call[0][0] === 'api')).toHaveLength(0);
  });
  it('bounds verdict checks per pass and drains the backlog over later passes', async () => {
    const { opts, gh, report } = setup();
    report.groups = [];
    const firedAt = '2026-01-01T11:00:00Z';
    const rows = Array.from({ length: 10 }, (_, i) => [
      { at: firedAt, repo: 'org/repo', head: String(i).padStart(40, '0'), runId: 100 + i, pr: i + 1, outcome: 'attempt' },
      { at: firedAt, repo: 'org/repo', head: String(i).padStart(40, '0'), runId: 100 + i, pr: i + 1, outcome: 'ok' },
    ]).flat();
    appendFileSync(opts.journalPath!, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    gh.mockImplementation(async (args: string[]) => {
      if (args[0] !== 'api') return { ok: true, stdout: '', stderr: '' };
      const head = String(Number(args[1]!.split('/').pop()) - 100).padStart(40, '0');
      return { ok: true, stdout: JSON.stringify({ status: 'completed', conclusion: 'success', head_sha: head, updated_at: '2026-01-01T11:30:00Z' }), stderr: '' };
    });
    const first = await runCiRerunMaintenance(opts);
    expect(first.repos['org/repo']?.verdictsPending).toBe(10);
    expect(first.repos['org/repo']?.verdictsResolved).toBe(8);
    expect(gh.mock.calls.filter(call => call[0][0] === 'api')).toHaveLength(8);
    const second = await runCiRerunMaintenance(opts);
    expect(second.repos['org/repo']?.verdictsResolved).toBe(2);
    expect(readCiReruns(opts.journalPath!, opts.now!()).verdicts).toMatchObject({ pass: 10, pending: 0, resolutionRate: 1 });
  });
});
