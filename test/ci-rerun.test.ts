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
    const status = await runCiRerunMaintenance(opts);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(status.repos['org/other']?.skippedCap).toBe(1);
    opts.now = () => Date.parse('2026-01-01T13:01:00Z');
    await runCiRerunMaintenance(opts);
    expect(gh).toHaveBeenCalledTimes(2);
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
});
