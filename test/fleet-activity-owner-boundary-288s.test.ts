/**
 * RQ-PHX-ACTIVITYOWNERQUALIFY288S — owner-boundary evidence for PR #5357
 * (RQ-PHX-ACTIVITYORIGINALRECONCILE267S), preserving original PR #4063
 * (RQ-SWE3-ATTEMPT-RACE-1). Independent CLI replay through the real exported
 * `cmdFleetActivity` against a temporary jobs.jsonl ledger — no reader/fold
 * mocks, fixed clock via the CLI's own `now` parameter.
 *
 * Boundary under test (not covered by the 267s replay, which stops at
 * `running` -> `merged`): a requeued job whose NEW attempt has only a finish
 * while the OLD attempt carries publish+MERGED evidence. The current
 * job-stage fields must never borrow the old attempt's publication url,
 * outcome or timestamps, and a successful finish alone must not be promoted
 * to merged/published. The verified-completion report is a job-level
 * aggregate over PR artifacts across attempts — an old attempt's verified
 * claim is historical evidence, never the current attempt's completion.
 * A second job publishes in its current attempt without any outcome row so
 * `published` and `merged` stay distinct and its claim stays pending.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetActivity } from '../src/cli/fleet-activity.js';
import type { AgentActivityReport } from '../src/core/fleet/agent-activity.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
/** ISO timestamp `mins` minutes before the fixed clock. */
const at = (mins: number) => new Date(NOW - mins * 60_000).toISOString();
const row = (event: string, job: string, mins: number, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ event, job, ts: at(mins), ...extra });

const JOB = 'RQ-BOUNDARY-288S';
const JOBB = 'RQ-BOUNDARY-288SB';
const PR_OLD = 'https://github.com/ashlrai/phantom/pull/9101';
const PR_NEW = 'https://github.com/ashlrai/phantom/pull/9102';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ledgerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-activity-owner-288s-'));
  dirs.push(dir);
  return join(dir, 'jobs.jsonl');
};

/** Run the real CLI against the ledger and return the parsed --json report. */
async function runCli(path: string): Promise<AgentActivityReport> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const code = await cmdFleetActivity(['--json', '--jobs', path], undefined, () => NOW);
  expect(code).toBe(0);
  expect(err).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledTimes(1);
  const out = JSON.parse(log.mock.calls[0]![0] as string) as AgentActivityReport;
  log.mockRestore();
  err.mockRestore();
  return out;
}

const jobOf = (report: AgentActivityReport, job: string) => {
  const found = report.jobs.find(j => j.job === job);
  expect(found, `job ${job} missing from report`).toBeDefined();
  return found!;
};

describe('cmdFleetActivity owner boundary — finished current attempt vs merged old attempt (PR #4063 preservation)', () => {
  it('never promotes a finish-only current attempt on stale publish/merge evidence', async () => {
    const path = ledgerPath();

    // Attempt 1: fully completed old attempt — finish, publish, MERGED.
    // Then requeue + relaunch: the new attempt boundary.
    writeFileSync(path, [
      row('enqueue', JOB, 300, { repo: 'phantom', lane: 'devin', tier: 'work' }),
      row('launch', JOB, 290, { repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2' }),
      row('finish', JOB, 280, { exit_code: 1, wall_s: 600 }),
      row('publish', JOB, 275, { url: PR_OLD }),
      row('outcome', JOB, 270, { outcome: 'MERGED', url: PR_OLD }),
      row('enqueue', JOB, 200, { repo: 'phantom', lane: 'devin', tier: 'work' }), // requeue = new boundary
      row('launch', JOB, 190, { repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2' }),
      // Current attempt: finish only — no publish, no outcome.
      row('finish', JOB, 60, { exit_code: 0, wall_s: 300, tokens_total: 7000 }),
    ].join('\n') + '\n');

    // A delayed old-attempt outcome appended after the new finish but stamped
    // before the new boundary must stay with attempt 1.
    appendFileSync(path, row('outcome', JOB, 250, { outcome: 'MERGED', url: PR_OLD }) + '\n');

    const envBefore = { ...process.env };
    const bytes1 = readFileSync(path);

    // Repeated fresh CLI reads: identical reports, ledger bytes untouched,
    // fixed clock honored, no env/console leakage.
    const read1 = await runCli(path);
    const read2 = await runCli(path);
    expect(read2).toEqual(read1);
    expect(readFileSync(path)).toEqual(bytes1);
    expect(process.env).toEqual(envBefore);

    expect(read1.sourceState).toBe('healthy');
    expect(read1.generatedAt).toBe(new Date(NOW).toISOString());
    const j = jobOf(read1, JOB);
    // Current-attempt fields come only from the post-boundary rows.
    expect(j.stage).toBe('finished');
    expect(j.queuedAt).toBe(at(200));
    expect(j.launchedAt).toBe(at(190));
    expect(j.finishedAt).toBe(at(60));
    // Nothing from attempt 1's publish/merge may leak into the current job.
    expect(j.publishedAt).toBeNull();
    expect(j.outcomeAt).toBeNull();
    expect(j.outcome).toBeNull();
    expect(j.url).toBeNull();
    expect(j.publishLagS).toBeNull();
    // Finish-derived fields are the current attempt's own.
    expect(j.runS).toBe(130 * 60);
    expect(j.wallS).toBe(300);
    expect(j.tokensTotal).toBe(7000);
    expect(j.exitCode).toBe(0);
    // Timeline keeps the observed cross-attempt history by contract.
    expect(j.timeline.map(e => e.event)).toEqual([
      'enqueue', 'launch', 'finish', 'publish', 'outcome',
      'enqueue', 'launch', 'finish', 'outcome',
    ]);

    // Verified completion is a job-level aggregate over PR artifacts across
    // attempts: attempt 1's published+MERGED claim still counts as one
    // verified claim, but it is historical evidence — it does not mark the
    // current attempt complete, and the finish-only requeue is not counted
    // as completedUnpublished because the job already carries a claim.
    expect(read1.verified.eligible).toBe(1);
    expect(read1.verified.verified).toBe(1);
    expect(read1.verified.failed).toBe(0);
    expect(read1.verified.pending).toBe(0);
    expect(read1.verified.rate).toBe(1);
    expect(read1.verified.claims.published).toBe(1);
    expect(read1.verified.completedUnpublished).toBe(0);
    expect(readFileSync(path)).toEqual(bytes1);
  });

  it('keeps a current-attempt publication without an outcome distinct from merged', async () => {
    const path = ledgerPath();

    // JOBB: published in its current (only) attempt; no outcome row exists,
    // so the job stage is `published` — never `merged` — and its verified
    // claim stays pending rather than verified.
    writeFileSync(path, [
      row('enqueue', JOBB, 150, { repo: 'phantom', lane: 'claude', tier: 'work' }),
      row('launch', JOBB, 140, { repo: 'phantom', lane: 'claude', tier: 'work', model: 'opus' }),
      row('publish', JOBB, 100, { url: PR_NEW, lane: 'claude' }),
    ].join('\n') + '\n');

    const bytes = readFileSync(path);
    const report = await runCli(path);
    const readAgain = await runCli(path);
    expect(readAgain).toEqual(report);
    expect(readFileSync(path)).toEqual(bytes);

    const j = jobOf(report, JOBB);
    expect(j.stage).toBe('published');
    expect(j.publishedAt).toBe(at(100));
    expect(j.url).toBe(PR_NEW);
    expect(j.finishedAt).toBeNull();
    expect(j.outcomeAt).toBeNull();
    expect(j.outcome).toBeNull();
    expect(report.byStage.published).toBe(1);
    expect(report.byStage.merged).toBe(0);

    // The unresolved PR is a pending claim: published is evidence of a
    // claim, not of verified completion.
    expect(report.verified.eligible).toBe(1);
    expect(report.verified.verified).toBe(0);
    expect(report.verified.pending).toBe(1);
    expect(report.verified.rate).toBeNull();
    expect(report.verified.claims.published).toBe(1);
  });
});
