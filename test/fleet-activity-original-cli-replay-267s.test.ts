/**
 * RQ-PHX-ACTIVITYORIGINALRECONCILE267S — executable preservation evidence for
 * original PR #4063 (RQ-SWE3-ATTEMPT-RACE-1). Sequential CLI replay through the
 * real exported `cmdFleetActivity` against a temporary jobs.jsonl ledger: a
 * completed old attempt, an appended requeue/new launch, then delayed
 * finish/publish/outcome rows stamped before the new attempt boundary must not
 * advance the requeued job, and real current-attempt rows must advance it to
 * merged on a fresh read. Also proves a successful finish alone is not
 * independently verified completion under the current report contract, and
 * that every CLI read leaves the ledger bytes untouched. No reader or fold is
 * mocked; the fixed clock is the CLI's own `now` parameter. Companion unit
 * coverage lives in test/fleet-activity.test.ts — this file is IO/CLI replay
 * evidence only.
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

const JOB = 'RQ-REPLAY-267S';
const JOBB = 'RQ-REPLAY-267SB';
const PR1 = 'https://github.com/ashlrai/phantom/pull/4063';
const PR2 = 'https://github.com/ashlrai/phantom/pull/4064';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const ledgerPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-activity-replay-267s-'));
  dirs.push(dir);
  return join(dir, 'jobs.jsonl');
};

/** Run the real CLI against the ledger and return the parsed --json report. */
async function runCli(path: string): Promise<AgentActivityReport> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdFleetActivity(['--json', '--jobs', path], undefined, () => NOW);
  expect(code).toBe(0);
  expect(log).toHaveBeenCalledTimes(1);
  const out = JSON.parse(log.mock.calls[0]![0] as string) as AgentActivityReport;
  log.mockRestore();
  return out;
}

const jobOf = (report: AgentActivityReport, job: string) => {
  const found = report.jobs.find(j => j.job === job);
  expect(found, `job ${job} missing from report`).toBeDefined();
  return found!;
};

describe('cmdFleetActivity CLI replay — attempt race (PR #4063 preservation)', () => {
  it('keeps stale old-attempt outcomes from masquerading as the current attempt', async () => {
    const path = ledgerPath();

    // Attempt 1: a fully completed old attempt (finish -> publish -> MERGED).
    // Then the job is requeued and re-launched: the new attempt boundary.
    writeFileSync(path, [
      row('enqueue', JOB, 180, { repo: 'phantom', lane: 'devin', tier: 'work' }),
      row('launch', JOB, 170, { repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2' }),
      row('finish', JOB, 160, { exit_code: 1, wall_s: 600 }),
      row('publish', JOB, 155, { url: PR1 }),
      row('outcome', JOB, 150, { outcome: 'MERGED', url: PR1 }),
      row('enqueue', JOB, 140, { repo: 'phantom', lane: 'devin', tier: 'work' }), // requeue = new boundary
      row('launch', JOB, 130, { repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2' }),
    ].join('\n') + '\n');

    const bytes1 = readFileSync(path);
    const read1 = await runCli(path);
    const a1 = jobOf(read1, JOB);
    expect(read1.sourceState).toBe('healthy');
    expect(a1.stage).toBe('running');
    expect(a1.launchedAt).toBe(at(130));
    expect(a1.finishedAt).toBeNull();
    expect(a1.publishedAt).toBeNull();
    expect(a1.outcomeAt).toBeNull();
    expect(readFileSync(path)).toEqual(bytes1); // read-only proof

    // Delayed rows from attempt 1 appended after the new launch but stamped
    // before the new boundary, plus a second job whose only evidence is a
    // successful finish.
    appendFileSync(path, [
      row('finish', JOB, 158, { exit_code: 0, wall_s: 900 }),
      row('publish', JOB, 157, { url: PR1 }),
      row('outcome', JOB, 156, { outcome: 'MERGED', url: PR1 }),
      row('launch', JOBB, 120, { repo: 'phantom', lane: 'devin', tier: 'work', model: 'swe-2' }),
      row('finish', JOBB, 100, { exit_code: 0, wall_s: 300, tokens_total: 5000 }),
    ].join('\n') + '\n');

    const bytes2 = readFileSync(path);
    const read2 = await runCli(path);
    const a2 = jobOf(read2, JOB);
    // The delayed finish/publish/merged rows are stamped before the requeue
    // boundary: the CLI must still report the new attempt running.
    expect(a2.stage).toBe('running');
    expect(a2.launchedAt).toBe(at(130));
    expect(a2.finishedAt).toBeNull();
    expect(a2.publishedAt).toBeNull();
    expect(a2.outcomeAt).toBeNull();
    expect(a2.outcome).toBeNull();
    expect(a2.url).toBeNull();
    // A successful finish alone is not completion: JOBB stays 'finished',
    // and the verified-completion report counts it as completedUnpublished
    // rather than a verified claim (only attempt 1's published+MERGED claim
    // is eligible/verified).
    const b2 = jobOf(read2, JOBB);
    expect(b2.stage).toBe('finished');
    expect(b2.finishedAt).toBe(at(100));
    expect(read2.verified.eligible).toBe(1);
    expect(read2.verified.verified).toBe(1);
    expect(read2.verified.completedUnpublished).toBe(1);
    expect(readFileSync(path)).toEqual(bytes2); // read-only proof

    // Real current-attempt rows stamped after the new boundary advance the
    // job to merged on a fresh read.
    appendFileSync(path, [
      row('finish', JOB, 60, { exit_code: 0, wall_s: 4200, tokens_total: 91000 }),
      row('publish', JOB, 55, { url: PR2 }),
      row('outcome', JOB, 50, { outcome: 'MERGED', url: PR2 }),
    ].join('\n') + '\n');

    const bytes3 = readFileSync(path);
    const read3 = await runCli(path);
    const a3 = jobOf(read3, JOB);
    expect(a3.stage).toBe('merged');
    expect(a3.launchedAt).toBe(at(130));
    expect(a3.finishedAt).toBe(at(60));
    expect(a3.publishedAt).toBe(at(55));
    expect(a3.outcomeAt).toBe(at(50));
    expect(a3.outcome).toBe('MERGED');
    expect(a3.url).toBe(PR2);
    expect(a3.runS).toBe(70 * 60);
    // Attempt 1's verified claim plus the new attempt's verified claim.
    expect(read3.verified.eligible).toBe(2);
    expect(read3.verified.verified).toBe(2);
    expect(readFileSync(path)).toEqual(bytes3); // read-only proof
  });
});
