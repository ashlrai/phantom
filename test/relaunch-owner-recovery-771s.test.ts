import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetRelaunches } from '../src/cli/fleet-relaunches.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const stamp = (ago: number) => new Date(NOW - ago * 60_000).toISOString();
const row = (job: string, event: string, ago: number, extra = {}) =>
  JSON.stringify({ job, event, ts: stamp(ago), ...extra });
const starts = (job: string) => [60, 40, 20].map(ago => row(job, 'launch', ago, { lane: 'codex-personal' }));
const url = 'https://github.com/ashlrai/phantom/pull/123';

describe('recovered fleet relaunches CLI with isolated on-disk evidence', () => {
  let dir: string;
  let ledger: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'relaunch-owner-771s-'));
    await mkdir(join(dir, 'metrics'));
    ledger = join(dir, 'metrics', 'jobs.jsonl');
  });
  afterAll(() => rm(dir, { recursive: true, force: true }));
  const run = async (args: string[]) => {
    const lines: string[] = [], errors: string[] = [];
    const code = await cmdFleetRelaunches(args, {
      now: () => NOW, out: line => lines.push(line), err: line => errors.push(line),
    });
    return { code, text: lines.join('\n'), errors };
  };
  const json = () => run(['--runs-dir', dir, '--json']);

  it('reports unfinished repeated starts, distinct lanes/PRs and measured time read-only', async () => {
    const source = [
      ...starts('RQ-REPEAT'),
      row('RQ-REPEAT', 'finish', 50, { wall_s: 120 }),
      row('RQ-REPEAT', 'finish', 30),
      row('RQ-REPEAT', 'publish', 15, { url }),
      row('RQ-REPEAT', 'published', 14, { pr_url: url }),
      row('RQ-REPEAT', 'publish', 13, { url: url.replace('123', '124') }),
      JSON.stringify({ job_id: 'RQ-REPEAT', type: 'launch', timestamp: stamp(10), pool: 'claude' }),
      ...starts('RQ-MERGED'),
      // Current metrics-outcomes copies the publish event and appends terminal status.
      row('RQ-MERGED', 'publish', 0, { status: 'MERGED', url, source: 'metrics-outcomes-reconciler' }),
      row('RQ-MERGED', 'outcome', 0, { state: 'MERGED', url }),
      ...starts('RQ-ALIAS'),
      JSON.stringify({ id: 'RQ-ALIAS', kind: 'published', at: stamp(1), phase: 'merged', prUrl: url }),
      '{bad json', 'null', '[]',
    ].join('\n');
    await writeFile(ledger, source);
    const result = await json();
    expect(result.code).toBe(0);
    const report = JSON.parse(result.text);
    expect(report.repeat_jobs.map((j: { job: string }) => j.job)).toEqual(['RQ-REPEAT']);
    expect(report.jobs['RQ-REPEAT']).toEqual({ launches: 4, lanes: ['codex-personal', 'claude'], minutes_spent: 12, prs: 2, merged: 0 });
    expect(report.jobs['RQ-MERGED'].merged).toBe(1);
    expect(report.jobs['RQ-ALIAS'].merged).toBe(1);
    const text = await run(['--runs-dir', dir]);
    expect(text.code).toBe(0);
    expect(text.text).toContain('RQ-REPEAT: launched 4 times');
    expect(text.text).toContain('12 minutes');
    expect(text.text).not.toMatch(/retire|reroute|pause|close the job/);
    expect(await readFile(ledger, 'utf8')).toBe(source);
  });

  it('includes the exact 24-hour boundary and now, excluding older/future/invalid stamps', async () => {
    await writeFile(ledger, [
      ...[1440, 1, 0, 1440 + 1 / 60_000, -1 / 60_000].map(ago => row('RQ-BOUNDARY', 'launch', ago)),
      JSON.stringify({ job: 'RQ-BOUNDARY', event: 'launch', ts: 'invalid' }),
      ...starts('RQ-OLD-MERGE'), row('RQ-OLD-MERGE', 'merged', 1441, { url }),
      ...starts('RQ-FUTURE-MERGE'), row('RQ-FUTURE-MERGE', 'merged', -1, { url }),
    ].join('\n'));
    const report = JSON.parse((await json()).text);
    expect(report.jobs['RQ-BOUNDARY'].launches).toBe(3);
    expect(report.repeat_jobs).toHaveLength(3);
  });

  it('returns unknown and exit 1 for missing or non-file sources, and exit 2 for bad flags', async () => {
    for (const root of [join(dir, 'missing'), join(dir, 'nonfile')]) {
      if (root.endsWith('nonfile')) await mkdir(join(root, 'metrics', 'jobs.jsonl'), { recursive: true });
      const result = await run(['--runs-dir', root, '--json']);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.text);
      expect(report.metrics).toBe('unreadable');
      expect(report.headline).toContain('unknown');
      expect(report.headline).not.toContain('No job');
    }
    expect((await run(['--runs-dir'])).code).toBe(2);
    expect((await run(['--nope'])).code).toBe(2);
    expect((await run(['--help'])).code).toBe(0);
  });
});
