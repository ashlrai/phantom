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

  it('counts merges recorded by the metrics-outcomes reconciler in both publish dialects', async () => {
    // The reconciler copies each PUBLISHED row into a terminal row without an
    // event:"outcome" marker: jobId/prUrl dialects, or the publish row's own
    // event/job/url fields, plus the reconciler source.
    const dir = await runs([
      { event: 'launch', job: 'RQ-RECONA', lane: 'zai', ts: at(90) },
      { event: 'finish', job: 'RQ-RECONA', lane: 'zai', exit_code: 0, ts: at(60) },
      { event: 'publish', job: 'RQ-RECONA', class: 'pr', url: PR, ts: at(50) },
      { outcome: 'MERGED', jobId: 'RQ-RECONA', prUrl: PR, source: 'metrics-outcomes-reconciler', mergedAt: at(30), ts: at(30) },
      { event: 'launch', job: 'RQ-RECONB', lane: 'zai', ts: at(90) },
      { event: 'finish', job: 'RQ-RECONB', lane: 'zai', exit_code: 1, ts: at(60) },
      { event: 'publish', job: 'RQ-RECONB', class: 'pr', url: PR, ts: at(50) },
      { event: 'publish', job: 'RQ-RECONB', url: PR, outcome: 'CLOSED', source: 'metrics-outcomes-reconciler', closedAt: at(30), ts: at(30) },
    ], { 'RQ-RECONA.publish': `RESULT PR ${PR}\n`, 'RQ-RECONB.publish': `RESULT PR ${PR}\n` });
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir });
    expect(report.jobs.find(j => j.job === 'RQ-RECONA')).toMatchObject({ outcome: 'merged', pr: PR });
    expect(report.jobs.find(j => j.job === 'RQ-RECONB')).toMatchObject({ outcome: 'pr_closed', pr: PR });
  });

  it('reports a job whose only evidence is a reconciler outcome row', async () => {
    const dir = await runs([
      { outcome: 'MERGED', jobId: 'RQ-RECONONLY', prUrl: PR, lane: 'zai', source: 'metrics-outcomes-reconciler', mergedAt: at(30), ts: at(30) },
    ]);
    const report = await readJobOutcomes({ hours: 24, now: NOW, runsDir: dir });
    expect(report.jobs).toEqual([{ job: 'RQ-RECONONLY', lane: 'zai', outcome: 'merged', exit_code: null, pr: PR, reason: null }]);
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
