import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyJobOutcome, outcomeSummaryLine, readJobOutcomes } from '../src/core/fleet/job-outcomes.js';

const NOW = Date.parse('2026-11-19T12:00:00Z');
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const PR = 'https://github.com/ashlrai/phantom/pull/7101';
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function runs(rows: object[], files: Record<string, string> = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'job-outcomes-'));
  dirs.push(dir);
  await mkdir(join(dir, 'metrics'));
  await writeFile(join(dir, 'metrics', 'jobs.jsonl'), rows.map(row => JSON.stringify(row)).join('\n'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

describe('job outcomes', () => {
  it('exit 1 with a merged PR is merged', async () => {
    const dir = await runs([
      { event: 'launch', job: 'RQ-ONE', lane: 'zai', ts: at(90) },
      { event: 'finish', job: 'RQ-ONE', lane: 'zai', exit_code: 1, ts: at(60) },
      { event: 'outcome', job: 'RQ-ONE', state: 'MERGED', url: PR, ts: at(30) },
    ], { 'RQ-ONE.publish': `RESULT PR ${PR}\n` });
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir });
    expect(report.jobs).toEqual([{ job: 'RQ-ONE', lane: 'zai', outcome: 'merged', exit_code: 1, pr: PR, reason: null }]);
    expect(report.schema).toBe('fleet.job-outcomes.v1');
  });

  it('exit 1 with no diff is empty, with the reason from the log tail', async () => {
    const dir = await runs([
      { event: 'launch', job: 'RQ-TWO', lane: 'zai', ts: at(90) },
      { event: 'finish', job: 'RQ-TWO', lane: 'zai', exit_code: 1, empty: true, ts: at(60) },
    ], { 'RQ-TWO.log': 'looking\nthe task is already on master\n', 'RQ-TWO.publish': 'RESULT EMPTY\n' });
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir, lane: 'zai' });
    expect(report.jobs[0]).toMatchObject({ outcome: 'empty', exit_code: 1, reason: 'task already on master' });
    expect(report.lanes[0]!.summary).toBe('zai: 0 merged of 1; most empty: task already on master');
  });

  it('exit 0 with a closed PR is pr_closed', async () => {
    const dir = await runs([
      { event: 'finish', job: 'RQ-THREE', lane: 'claude', exit_code: 0, ts: at(60) },
      { event: 'outcome', job: 'RQ-THREE', state: 'CLOSED', url: PR, ts: at(30) },
    ], { 'RQ-THREE.publish': `RESULT PR ${PR}\n` });
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir });
    expect(report.jobs[0]!.outcome).toBe('pr_closed');
  });

  it('classifies open PRs, failures, and an aborted publish', () => {
    const finish = (exit_code: number) => [{ event: 'finish', exit_code }];
    expect(classifyJobOutcome({ events: finish(0), publish: `RESULT PR ${PR}`, empty: false, exitCode: 0 }).outcome).toBe('pr_open');
    expect(classifyJobOutcome({ events: finish(2), publish: null, empty: false, exitCode: 2 }).outcome).toBe('failed');
    expect(classifyJobOutcome({ events: finish(0), publish: 'RESULT ABORT gate', empty: false, exitCode: 0 }).outcome).toBe('failed');
    expect(classifyJobOutcome({ events: finish(0), publish: null, empty: false, exitCode: 0 }).outcome).toBe('empty');
  });

  it('groups reasons, keeps the top 3 and filters by lane', async () => {
    const rows: object[] = [];
    const files: Record<string, string> = {};
    for (let i = 0; i < 5; i++) {
      rows.push({ event: 'finish', job: `RQ-E${i}`, lane: 'zai', exit_code: 1, empty: true, ts: at(60 + i) });
      files[`RQ-E${i}.log`] = i < 3 ? 'already on master\n' : 'tail without a known cause\n';
    }
    rows.push({ event: 'finish', job: 'RQ-OTHER', lane: 'codex', exit_code: 0, empty: true, ts: at(5) });
    const dir = await runs(rows, files);
    const zai = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir, lane: 'zai' });
    expect(zai.total).toBe(5);
    expect(zai.top_empty).toEqual([{ reason: 'task already on master', jobs: 3 }, { reason: 'no reason in the log', jobs: 2 }]);
    expect((await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir })).lanes.map(l => l.lane)).toEqual(['zai', 'codex']);
  });

  it('classifies reconciler and alias-spelled outcome rows', () => {
    // A reconciler row keeps a publish-shaped event while carrying the terminal phase.
    expect(classifyJobOutcome({ events: [{ type: 'publish', phase: 'MERGED', pr_url: PR }], publish: null, empty: false, exitCode: null }))
      .toEqual({ outcome: 'merged', pr: PR });
    expect(classifyJobOutcome({ events: [{ kind: 'outcome', status: 'CLOSED', pr: PR }], publish: null, empty: false, exitCode: null }))
      .toEqual({ outcome: 'pr_closed', pr: PR });
    // finish/launch rows that carry a terminal phase are outcome evidence too.
    expect(classifyJobOutcome({ events: [{ event: 'finish', conclusion: 'MERGED', prUrl: PR }], publish: null, empty: false, exitCode: 0 }))
      .toEqual({ outcome: 'merged', pr: PR });
  });

  it('reads outcome-only jobs written in the jobs-ledger dialect', async () => {
    const dir = await runs([
      // Reconciler merge: publish event + terminal phase, alias stamp and PR link.
      { type: 'publish', job: 'RQ-REC', phase: 'MERGED', pr_url: PR, recordedAt: at(30) },
      // Alias-spelled closed outcome with no finish row at all.
      { kind: 'outcome', job: 'RQ-ALIAS', status: 'CLOSED', pr: PR, updatedAt: at(30) },
      // A finish event spelled 'type' still counts as the job's finish.
      { type: 'finish', job: 'RQ-FIN', pool: 'zai', exit_code: 1, empty: true, timestamp: at(20) },
    ]);
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir });
    const byJob = new Map(report.jobs.map(job => [job.job, job]));
    expect(byJob.get('RQ-REC')).toMatchObject({ outcome: 'merged', pr: PR });
    expect(byJob.get('RQ-ALIAS')).toMatchObject({ outcome: 'pr_closed', pr: PR });
    expect(byJob.get('RQ-FIN')).toMatchObject({ outcome: 'empty', lane: 'zai', exit_code: 1 });
  });

  it('reports unknown when the ledger is missing, and a plain line for an idle lane', async () => {
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: join(tmpdir(), 'no-such-runs-dir-for-outcomes') });
    expect(report).toMatchObject({ known: false, total: 0 });
    expect(outcomeSummaryLine('zai', { merged: 0, pr_open: 0, pr_closed: 0, empty: 0, failed: 0 }, [], [])).toBe('zai: no finished jobs');
  });
});

describe('phm fleet outcomes --lane', () => {
  it('prints one JSON object with the schema id, and exits 2 on a bad hours value', async () => {
    const dir = await runs([{ event: 'finish', job: 'RQ-CLI', lane: 'zai', exit_code: 1, empty: true, ts: new Date().toISOString() }]);
    const { cmdFleetOutcomes } = await import('../src/cli/fleet-outcomes.js');
    let out = '';
    const write = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      expect(await cmdFleetOutcomes(['--lane', 'zai', '--runs-dir', dir, '--json'])).toBe(0);
      expect(await cmdFleetOutcomes(['--lane', 'zai', '--hours', 'soon'])).toBe(2);
    } finally { process.stdout.write = write; process.stderr.write = err; }
    const parsed = JSON.parse(out);
    expect(parsed.schema).toBe('fleet.job-outcomes.v1');
    expect(parsed.counts.empty).toBe(1);
  });
});
