import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentActivityLines,
  readAgentActivity,
  summarizeAgentActivity,
} from '../src/core/fleet/agent-activity.js';
import { cmdFleetActivity } from '../src/cli/fleet-activity.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-03T12:00:00Z');
const at = (h: number, m = 0) => new Date(Date.parse('2026-11-03T00:00:00Z') + h * 3_600_000 + m * 60_000).toISOString();
const row = (event: string, job: string, ts: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event, job, ts, ...extra });
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
const ledgerFile = (text: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-activity-')); dirs.push(dir);
  const path = join(dir, 'jobs.jsonl'); writeFileSync(path, text); return path;
};

const fullLifecycle = [
  row('enqueue', 'RQ-A-1', at(6), { repo: 'phantom', lane: 'devin', tier: 'work' }),
  row('claim', 'RQ-A-1', at(6, 30), { repo: 'phantom', lane: 'devin', tier: 'work' }),
  row('launch', 'RQ-A-1', at(7), { repo: 'phantom', lane: 'devin', tier: 'work', model: 'gpt-x' }),
  row('finish', 'RQ-A-1', at(8), { lane: 'devin', wall_s: 3590, tokens_total: 12000, exit_code: 0 }),
  row('publish', 'RQ-A-1', at(8, 10), { url: 'https://github.com/ashlrai/phantom/pull/11' }),
  row('outcome', 'RQ-A-1', at(9), { outcome: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/11' }),
].join('\n');

describe('summarizeAgentActivity', () => {
  it('folds a full launch->finish->publish lifecycle into stage, stamps and durations', () => {
    const { jobs, dropped } = summarizeAgentActivity(fullLifecycle, now);
    expect(dropped).toBe(0);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.stage).toBe('merged');
    expect(j.queuedAt).toBe(at(6));
    expect(j.launchedAt).toBe(at(7));
    expect(j.finishedAt).toBe(at(8));
    expect(j.publishedAt).toBe(at(8, 10));
    expect(j.outcomeAt).toBe(at(9));
    expect(j.queueWaitS).toBe(3600);
    expect(j.runS).toBe(3600);
    expect(j.publishLagS).toBe(600);
    expect(j.wallS).toBe(3590);
    expect(j.tokensTotal).toBe(12000);
    expect(j.exitCode).toBe(0);
    expect(j.url).toBe('https://github.com/ashlrai/phantom/pull/11');
    expect(j.timeline.map(e => e.event)).toEqual(['enqueue', 'claim', 'launch', 'finish', 'publish', 'outcome']);
  });

  it('reports a launched job with no finish as running with age', () => {
    const { jobs } = summarizeAgentActivity([
      row('enqueue', 'RQ-B-1', at(10), { lane: 'devin', repo: 'hub', tier: 'fix' }),
      row('launch', 'RQ-B-1', at(11), { lane: 'devin', repo: 'hub', tier: 'fix', model: 'o3' }),
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('running');
    expect(j.ageS).toBe(3600);
    expect(j.queueWaitS).toBe(3600);
    expect(j.runS).toBeNull();
    expect(j.publishLagS).toBeNull();
  });

  it('keeps finished jobs without a publish as finished with null lag', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-C-1', at(10), { lane: 'claude', repo: 'phantom', model: 'opus' }),
      row('finish', 'RQ-C-1', at(11), { exit_code: 3, wall_s: 10 }),
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('finished');
    expect(j.exitCode).toBe(3);
    expect(j.publishLagS).toBeNull();
    expect(j.ageS).toBeNull();
  });

  it('treats a launch after terminal events as a new attempt', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-D-1', at(6), { lane: 'devin' }),
      row('finish', 'RQ-D-1', at(7), { exit_code: 1 }),
      row('launch', 'RQ-D-1', at(11), { lane: 'devin', model: 'o3' }),
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('running');
    expect(j.launchedAt).toBe(at(11));
    expect(j.finishedAt).toBeNull();
    expect(j.ageS).toBe(3600);
    expect(j.timeline.map(e => e.event)).toEqual(['launch', 'finish', 'launch']);
  });

  it('ignores out-of-order stragglers instead of wiping a terminal attempt', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-K-1', at(6)),
      row('finish', 'RQ-K-1', at(7), { exit_code: 0 }),
      row('enqueue', 'RQ-K-1', at(5)), // appended late but older than the finish
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('finished');
    expect(j.finishedAt).toBe(at(7));
    expect(j.timeline.map(e => e.event)).toEqual(['launch', 'finish', 'enqueue']);
  });

  it('does not let a stale outcome close a re-launched job', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-S-1', at(6)),
      row('finish', 'RQ-S-1', at(7)),
      row('publish', 'RQ-S-1', at(7, 30), { url: 'https://github.com/ashlrai/phantom/pull/9' }),
      row('launch', 'RQ-S-1', at(10)), // second attempt underway
      row('outcome', 'RQ-S-1', at(9), { outcome: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/9' }),
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('running');
    expect(j.outcomeAt).toBeNull();
    expect(j.launchedAt).toBe(at(10));
  });

  it('does not let a delayed outcome from the old attempt merge a requeued job before relaunch', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-T-1', at(6)),
      row('finish', 'RQ-T-1', at(7)),
      row('enqueue', 'RQ-T-1', at(10)), // requeue: the new attempt boundary
      row('outcome', 'RQ-T-1', at(9), { outcome: 'MERGED', url: 'https://github.com/ashlrai/phantom/pull/9' }),
      row('launch', 'RQ-T-1B', at(6, 30)),
      row('outcome', 'RQ-T-1B', at(12), { outcome: 'CLOSED' }),
    ].join('\n'), now);
    // The delayed outcome is stamped before the requeue, so it stays with
    // attempt 1 and the requeued job is not closed ahead of its relaunch.
    const requeued = jobs.find(j => j.job === 'RQ-T-1')!;
    expect(requeued.stage).toBe('queued');
    expect(requeued.outcomeAt).toBeNull();
    expect(requeued.outcome).toBeNull();
    // A post-boundary outcome still lands on a live attempt.
    const live = jobs.find(j => j.job === 'RQ-T-1B')!;
    expect(live.stage).toBe('closed');
    expect(live.outcomeAt).toBe(at(12));
  });

  it('does not let a delayed finish from the old attempt finish a requeued job before relaunch', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-T-2', at(6)),
      row('enqueue', 'RQ-T-2', at(10)), // requeued while attempt 1's finish was still in flight
      row('finish', 'RQ-T-2', at(8), { exit_code: 0, wall_s: 120 }),
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('running');
    expect(j.finishedAt).toBeNull();
    expect(j.exitCode).toBeNull();
    expect(j.runS).toBeNull();
  });

  it('does not let a delayed publish from the old attempt publish a requeued job before relaunch', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-T-3', at(6)),
      row('finish', 'RQ-T-3', at(7)),
      row('publish', 'RQ-T-3', at(8), { url: 'https://github.com/ashlrai/phantom/pull/9' }),
      row('enqueue', 'RQ-T-3', at(10)), // requeue resets the attempt, then attempt 1's publish row lands late
      row('publish', 'RQ-T-3', at(9), { url: 'https://github.com/ashlrai/phantom/pull/9' }),
    ].join('\n'), now);
    const j = jobs[0]!;
    expect(j.stage).toBe('queued');
    expect(j.publishedAt).toBeNull();
    expect(j.url).toBeNull();
    expect(j.publishLagS).toBeNull();
  });

  it('never pairs reversed boundaries into durations', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-E-1', at(10)),
      row('publish', 'RQ-E-1', at(9), { url: 'https://github.com/ashlrai/phantom/pull/2' }),
      row('finish', 'RQ-E-1', at(9, 30)),
    ].join('\n'), now);
    const j = jobs[0]!;
    // publish before launch is not a valid publish for this attempt; finish before launch is kept out of runS.
    expect(j.publishedAt).toBeNull();
    expect(j.finishedAt).toBeNull();
    expect(j.runS).toBeNull();
    expect(j.stage).toBe('running');
  });

  it('skips malformed lines and invalid lifecycle rows without failing', () => {
    const { jobs, dropped, scanned } = summarizeAgentActivity([
      'not json',
      '{"event":"launch"}',
      row('launch', 'RQ-F-1', 'not-a-time'),
      row('launch', 'RQ-F-1', at(11), { lane: 'devin' }),
      row('concurrency', 'x', at(11)),          // operational row: skipped, not dropped
      row('precheck_skip', 'RQ-F-2', at(11)),   // non-lifecycle job row: skipped
    ].join('\n'), now);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.job).toBe('RQ-F-1');
    expect(dropped).toBe(3);
    expect(scanned).toBe(6);
  });

  it('honours the activity window and the limit', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'RQ-OLD-1', at(0)),
      row('launch', 'RQ-NEW-1', at(11)),
    ].join('\n'), now, { windowMs: 2 * 3_600_000 });
    expect(jobs.map(j => j.job)).toEqual(['RQ-NEW-1']);
    const many = Array.from({ length: 60 }, (_, i) => row('launch', `RQ-M-${i}`, at(11))).join('\n');
    expect(summarizeAgentActivity(many, now, { limit: 5 }).jobs).toHaveLength(5);
  });

  it('rejects unbounded job ids, urls and labels from the ledger', () => {
    const { jobs } = summarizeAgentActivity([
      row('launch', 'bad job\nwith newline', at(11)),
      row('launch', 'RQ-G-1', at(11), { lane: 'devin', repo: 'ok', model: 'm\x00n' }),
      row('publish', 'RQ-G-1', at(11, 30), { url: 'https://evil.example.com/phish' }),
    ].join('\n'), now);
    expect(jobs).toHaveLength(1);
    const j = jobs[0]!;
    expect(j.model).toBeNull();
    // The publish event is still lifecycle evidence; only the untrusted url is withheld.
    expect(j.stage).toBe('published');
    expect(j.publishedAt).toBe(at(11, 30));
    expect(j.url).toBeNull();
  });
});

describe('readAgentActivity', () => {
  it('reads a real ledger file and reports healthy', async () => {
    const report = await readAgentActivity({ jobsPath: ledgerFile(fullLifecycle), now: () => now });
    expect(report.v).toBe(1);
    expect(report.sourceState).toBe('healthy');
    expect(report.generatedAt).toBe(new Date(now).toISOString());
    expect(report.jobs).toHaveLength(1);
    expect(report.byStage.merged).toBe(1);
  });

  it('reports missing for an absent ledger and degraded for malformed rows', async () => {
    const missing = await readAgentActivity({ jobsPath: join(tmpdir(), 'no-such-ledger', 'jobs.jsonl'), now: () => now });
    expect(missing.sourceState).toBe('missing');
    expect(missing.jobs).toEqual([]);
    const degraded = await readAgentActivity({ jobsPath: ledgerFile('garbage\n' + fullLifecycle), now: () => now });
    expect(degraded.sourceState).toBe('degraded');
    expect(degraded.dropped).toBe(1);
    expect(degraded.jobs).toHaveLength(1);
  });
});

describe('agentActivityLines', () => {
  it('renders a count header and one line per job', async () => {
    const report = await readAgentActivity({ jobsPath: ledgerFile(fullLifecycle), now: () => now });
    const lines = agentActivityLines(report);
    expect(lines[0]).toBe('Agent activity: 1 job in 6h window (source healthy)');
    expect(lines[1]).toContain('RQ-A-1 merged');
    expect(lines[1]).toContain('devin/phantom');
    expect(lines[1]).toContain('queue 60m');
    expect(lines[1]).toContain('run 60m');
    expect(lines[1]).toContain('lag 10m');
    expect(lines[1]).toContain('https://github.com/ashlrai/phantom/pull/11');
  });

  it('never renders untrusted values at the output boundary', () => {
    const lines = agentActivityLines({
      v: 1, generatedAt: 'x', windowMs: 3_600_000, sourceState: 'healthy', scanned: 0, dropped: 0, truncated: false,
      byStage: { queued: 0, running: 1, finished: 0, published: 0, merged: 0, closed: 0, unknown: 0 },
      jobs: [
        { job: 'evil\njob', stage: 'running', lane: 'devin', repo: 'x', tier: null, model: null,
          queuedAt: null, launchedAt: 'a', finishedAt: null, publishedAt: null, outcomeAt: null,
          outcome: null, url: 'https://evil.example.com/x', queueWaitS: null, runS: null, publishLagS: null,
          wallS: null, ageS: -5, tokensTotal: null, exitCode: null, timeline: [], lastEventAt: 'a' },
        { job: 'RQ-H-1', stage: 'bogus' as never, lane: 'lane\nname', repo: 'r', tier: null, model: null,
          queuedAt: null, launchedAt: 'a', finishedAt: null, publishedAt: null, outcomeAt: null,
          outcome: null, url: null, queueWaitS: null, runS: null, publishLagS: null,
          wallS: null, ageS: 60, tokensTotal: null, exitCode: null, timeline: [], lastEventAt: 'a' },
      ],
    });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('RQ-H-1 unknown -/r age 60s');
    expect(lines.join('\n')).not.toContain('evil');
  });
});

describe('cmdFleetActivity', () => {
  it('prints the report, supports --json and --jobs, and is registered', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const path = ledgerFile(fullLifecycle);
    expect(await cmdFleetActivity(['--jobs', path], readAgentActivity, () => now)).toBe(0);
    expect((log.mock.calls[0]![0] as string).split('\n')[0]).toContain('Agent activity: 1 job');
    expect(await cmdFleetActivity(['--jobs', path, '--json', '--hours', '12', '--limit', '10'], readAgentActivity, () => now)).toBe(0);
    expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({ v: 1, sourceState: 'healthy', windowMs: 12 * 3_600_000 });
    expect(await cmdFleetActivity(['--bogus'])).toBe(2);
    expect(await cmdFleetActivity(['--hours', '999'])).toBe(2);
    expect(await cmdFleetActivity(['--help'])).toBe(0);
    expect(err).toHaveBeenCalled();
    expect(typeof (await FLEET_SUBCOMMAND_LOADERS['activity']!()).cmdFleetActivity).toBe('function');
  });
});
