import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdLog } from '../src/cli/log.js';
import { jobLog, readJobLog, type JobLogReport } from '../src/core/fleet/job-log.js';
import { worklog } from '../src/core/fleet/worklog.js';

const now = Date.parse('2026-11-09T11:00:00Z');
const source = async (since = now - 3600000) => worklog(await readFile(new URL('./fixtures/joblog/jobs.jsonl', import.meta.url), 'utf8'), since, now,
  { hours: 1, emptyReasons: new Map([['JOB-EMPTY', 'work was already covered']]) });
const byJob = (report: JobLogReport) => Object.fromEntries(report.jobs.map(job => [job.job ?? 'none', job]));
afterEach(() => vi.restoreAllMocks());

describe('phm log', () => {
  it('joins launch, finish, publish and outcome into one row per job, newest first', async () => {
    const report = jobLog(await source());
    expect(report.jobs.map(job => job.job)).toEqual([null, 'JOB-OPEN', 'JOB-CLOSED', 'JOB-RUNNING', 'JOB-FAILED', 'JOB-EMPTY', 'JOB-MERGED']);
    const jobs = byJob(report);
    expect(jobs['JOB-MERGED']).toEqual({ job: 'JOB-MERGED', at: '2026-11-09T10:08:00.000Z', lane: 'work', model: 'model-a', repo: 'phantom', goal: 'Add the log view',
      result: 'merged', text: 'Merged PR 7', pr: 7, url: 'https://github.com/ashlrai/phantom/pull/7', mergeSeconds: 120 });
    expect(jobs['JOB-EMPTY']).toMatchObject({ lane: 'fast', model: 'model-b', repo: 'locus', result: 'no-change', text: 'No change: work was already covered', pr: null, mergeSeconds: null });
    expect(jobs['JOB-FAILED']).toMatchObject({ result: 'failed', text: 'Failed: tests did not pass', model: null, goal: null });
    expect(jobs['JOB-RUNNING']).toMatchObject({ result: 'running', text: 'Still running, no result yet', url: null });
    expect(jobs['JOB-CLOSED']).toMatchObject({ result: 'closed', text: 'Closed PR 8 without merging', pr: 8 });
    expect(jobs['JOB-OPEN']).toMatchObject({ result: 'open', text: 'Opened PR 9, not merged yet', mergeSeconds: null });
    // A merge recorded with no job id still shows; what is not recorded stays null.
    expect(jobs.none).toMatchObject({ job: null, lane: null, model: null, repo: 'locus', result: 'merged', text: 'Merged PR 3', mergeSeconds: null });
  });
  it('keeps a stable schema with a version and summarizes overall and per lane', async () => {
    const report = jobLog(await source());
    expect(Object.keys(report)).toEqual(['schema', 'version', 'hours', 'headline', 'summary', 'jobs', 'sources', 'malformedLines']);
    expect(report).toMatchObject({ schema: 'joblog.v1', version: 1, hours: 1, malformedLines: 1, sources: { jobs: { state: 'ok' } } });
    expect(Object.keys(report.jobs[0]!)).toEqual(['job', 'at', 'lane', 'model', 'repo', 'goal', 'result', 'text', 'pr', 'url', 'mergeSeconds']);
    expect(report.headline).toBe('7 jobs, 2 merged, 14% made no change, median time to merge 2m 0s.');
    expect(report.summary).toMatchObject({ jobs: 7, merged: 2, noChange: 1, medianMergeSeconds: 120 });
    expect(report.summary.lanes).toEqual([
      { lane: 'fast', jobs: 3, merged: 0, noChange: 1, noChangeRate: 1 / 3, medianMergeSeconds: null },
      { lane: 'unknown', jobs: 1, merged: 1, noChange: 0, noChangeRate: 0, medianMergeSeconds: null },
      { lane: 'work', jobs: 3, merged: 1, noChange: 0, noChangeRate: 0, medianMergeSeconds: 120 },
    ]);
  });
  it('filters by lane and repo, recounts the summary and derives a missing merge time from the publish', async () => {
    const fast = jobLog(await source(), { lane: 'fast', repo: 'phantom' });
    expect(fast.jobs.map(job => job.job)).toEqual(['JOB-OPEN', 'JOB-FAILED']);
    expect(fast.summary).toMatchObject({ jobs: 2, merged: 0, noChangeRate: 0, lanes: [{ lane: 'fast', jobs: 2 }] });
    expect(jobLog(await source(), { lane: 'unknown' }).jobs.map(job => job.text)).toEqual(['Merged PR 3']);
    const rows = [{ event: 'publish', job: 'A', url: 'https://github.com/ashlrai/phantom/pull/4', ts: '2026-11-09T10:00:00Z' },
      { event: 'outcome', state: 'MERGED', job: 'A', url: 'https://github.com/ashlrai/phantom/pull/4', ts: '2026-11-09T10:01:30Z' },
      { event: 'finish', job: 'B', exit_code: 2, ts: '2026-11-09T10:02:00Z' }, { event: 'finish', job: 'C', exit_code: 0, empty: true, ts: '2026-11-09T10:03:00Z' },
      { event: 'finish', job: 'D', exit_code: 0, ts: '2026-11-09T10:04:00Z' }, { event: 'launch', job: 'B', ts: '2026-11-09T10:05:00Z' }];
    const jobs = byJob(jobLog(worklog(rows.map(row => JSON.stringify(row)).join('\n'), 0, now)));
    expect(jobs.A).toMatchObject({ mergeSeconds: 90, lane: null });
    expect(jobs.B).toMatchObject({ result: 'running' });
    expect(jobs.C!.text).toBe('No change: reason unknown');
    expect(jobs.D!.text).toBe('Finished, no PR recorded');
    const empty = jobLog(worklog('', 0, now));
    expect(empty).toMatchObject({ jobs: [], headline: '0 jobs.', summary: { noChangeRate: null, lanes: [] } });
  });
  it('prints the summary first, then lanes, then plain-words rows with unknown shown as unknown', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const read = vi.fn(async (hours: number, filters: object) => readJobLog(hours, filters, () => source()));
    expect(await cmdLog([], read)).toBe(0);
    const lines = String(output.mock.calls[0]![0]).split('\n');
    expect(lines[0]).toBe('Last 1 hours: 7 jobs, 2 merged, 14% made no change, median time to merge 2m 0s.');
    expect(lines.slice(1, 4)).toEqual(['  fast: 3 jobs, 0 merged, 33% made no change, median time to merge unknown',
      '  unknown: 1 job, 1 merged, 0% made no change, median time to merge unknown', '  work: 3 jobs, 1 merged, 0% made no change, median time to merge 2m 0s']);
    expect(lines[4]).toMatch(/unknown lane · unknown model · locus {2}unknown job {2}goal unknown {2}Merged PR 3, time to merge unknown {2}https:/);
    expect(lines.at(-2)).toMatch(/work · model-a · phantom {2}JOB-MERGED {2}Add the log view {2}Merged PR 7 in 2m 0s/);
    expect(lines.at(-1)).toBe('1 unreadable ledger lines skipped.');
  });
  it('serves JSON, passes --since, --lane and --repo to the reader and rejects bad usage', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn(async (_hours: number, filters: object) => jobLog(await source(), filters));
    expect(await cmdLog(['--json', '--since', '2h', '--lane', 'work', '--repo', 'phantom'], read)).toBe(0);
    expect(read).toHaveBeenCalledWith(2, { lane: 'work', repo: 'phantom' });
    const body = JSON.parse(String(output.mock.calls[0]![0])) as JobLogReport;
    expect([body.schema, body.version, body.jobs.length]).toEqual(['joblog.v1', 1, 3]);
    expect(await cmdLog(['--lane', 'none'], read)).toBe(0);
    expect(String(output.mock.lastCall![0])).toContain('No jobs match these filters.');
    for (const args of [['--since', 'bad'], ['--since', '0h'], ['--lane'], ['--kind', 'merged'], ['--nope']]) expect(await cmdLog(args, read)).toBe(2);
    expect(await cmdLog(['--help'], read)).toBe(0);
    expect(read).toHaveBeenCalledTimes(2);
    expect(await cmdLog([], async () => { throw new Error('private path'); })).toBe(1);
    expect(error).toHaveBeenLastCalledWith('Unable to read the job log.');
  });
});
