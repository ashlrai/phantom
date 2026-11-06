import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyJobShare, jobClassShare } from '../src/core/fleet/job-class-share.js';
import { cmdFleetJobClassShare } from '../src/cli/fleet-job-class-share.js';

const now = Date.parse('2026-10-31T19:28:00Z');
const ts = (clock: string) => `2026-10-31T${clock}:00Z`;
const row = (job: string, event: string, extra = {}) => JSON.stringify({ job, event, ts: ts('18:00'), lane: 'claude', ...extra });

const fixture = [
  row('RQ-PS1A251031Q8', 'finish', { ts: ts('19:00'), lane: 'codex-personal', tokens_total: 8600 }),
  row('RQ-PHX-JOBCLASSSHARE01', 'finish', { ts: ts('19:10'), lane: 'codex-personal', tokens_total: 1400 }),
  row('RQ-DRAIN-CTX', 'finish', { tokens_total: 500 }),
  row('manual-audit', 'finish', { ts: ts('18:30'), tokens_total: 500 }),
  row('RQ-LAND-9', 'finish', { ts: ts('17:00'), lane: 'devin', tokens_total: null }),
  row('RQ-LEXICON3A251031Q8', 'finish', { ts: ts('16:00'), lane: 'devin', tokens_total: 300 }),
  row('RQ-MD2A251031Q8', 'launch', { ts: ts('19:15') }),
  row('old-job', 'finish', { ts: ts('12:00'), tokens_total: 9999 }),
  row('future-job', 'finish', { ts: ts('20:00'), tokens_total: 9999 }),
  'not json',
  '{"event":"finish"}',
  '',
].join('\n');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'job-class-share-'));
  await mkdir(join(root, 'metrics'), { recursive: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('classifyJobShare', () => {
  it('splits auto-authored, drain and real job ids', () => {
    const ids = ['RQ-LOCUS1A251031Q8', 'RQ-LEXICON3A251031Q8', 'RQ-MD2A251031Q8', 'RQ-STACK12A251031Q8', 'RQ-PLUGIN5A251031Q8',
      'RQ-PS99A101231Q8', 'RQ-DRAIN-CTX', 'RQ-LAND-9', 'RQ-LAND', 'RQ-PHX-JOBCLASSSHARE01', 'manual',
      'RQ-STACK12A20261031Q8', 'RQ-PS1A251031Q8-retry'];
    expect(ids.map(classifyJobShare)).toEqual(['author', 'author', 'author', 'author', 'author', 'author',
      'drain', 'drain', 'drain', 'real', 'real', 'real', 'real']);
  });
});

describe('jobClassShare', () => {
  it('reports per-lane jobs, tokens and class token shares plus a total row', () => {
    const report = jobClassShare(fixture, 6, now);
    expect(report).toMatchObject({ schema: 'fleet.job-class-share.v1', hours: 6, malformed: 2 });
    expect(report.rows).toEqual([
      { lane: 'claude', jobs: 2, tokens: 1000, author_pct: 0, drain_pct: 50, real_pct: 50 },
      { lane: 'codex-personal', jobs: 2, tokens: 10000, author_pct: 86, drain_pct: 0, real_pct: 14 },
      { lane: 'devin', jobs: 2, tokens: 300, author_pct: 100, drain_pct: 0, real_pct: 0 },
      { lane: 'total', jobs: 6, tokens: 11300, author_pct: 78.8, drain_pct: 4.4, real_pct: 16.8 },
    ]);
  });

  it('reports null percents when a lane has no known tokens', () => {
    const report = jobClassShare([row('RQ-LAND-9', 'finish', { tokens_total: null })].join('\n'), 6, now);
    expect(report.rows).toEqual([
      { lane: 'claude', jobs: 1, tokens: 0, author_pct: null, drain_pct: null, real_pct: null },
      { lane: 'total', jobs: 1, tokens: 0, author_pct: null, drain_pct: null, real_pct: null },
    ]);
  });

  it('uses the lane from an earlier row for a lane-less finish in the window', () => {
    const report = jobClassShare([
      row('RQ-DRAIN-OLD', 'launch', { ts: ts('10:00') }),
      row('RQ-DRAIN-OLD', 'finish', { lane: undefined, tokens_total: 42 }),
    ].join('\n'), 6, now);
    expect(report.rows[0]).toMatchObject({ lane: 'claude', jobs: 1, tokens: 42, drain_pct: 100 });
  });

  it('keeps the latest tokens for repeated finishes of one job', () => {
    const report = jobClassShare([
      row('job', 'finish', { ts: ts('18:00'), tokens_total: 10 }),
      row('job', 'finish', { ts: ts('18:30'), tokens_total: 25 }),
    ].join('\n'), 6, now);
    expect(report.rows[0]).toMatchObject({ jobs: 1, tokens: 25 });
  });
});

describe('cmdFleetJobClassShare', () => {
  it('prints the JSON report for a fixture file under --root', async () => {
    await writeFile(join(root, 'metrics/jobs.jsonl'), fixture);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetJobClassShare(['--root', root, '--json'], undefined, now)).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report.malformed).toBe(2);
    expect(report.rows).toHaveLength(4);
    expect(report.rows.at(-1)).toEqual({ lane: 'total', jobs: 6, tokens: 11300, author_pct: 78.8, drain_pct: 4.4, real_pct: 16.8 });
    expect(report.rows.find((r: { lane: string }) => r.lane === 'codex-personal')).toMatchObject({ author_pct: 86, real_pct: 14 });
  });

  it('prints a text table with one row per lane plus the total', async () => {
    await writeFile(join(root, 'metrics/jobs.jsonl'), fixture);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetJobClassShare(['--root', root, '--hours', '6'], undefined, now)).toBe(0);
    expect(String(output.mock.calls[0]![0]).split('\n')).toEqual([
      'lane jobs tokens author_pct drain_pct real_pct',
      'claude 2 1000 0.0 50.0 50.0',
      'codex-personal 2 10000 86.0 0.0 14.0',
      'devin 2 300 100.0 0.0 0.0',
      'total 6 11300 78.8 4.4 16.8',
      'Malformed rows: 2',
    ]);
  });

  it('exits 0 with empty totals when jobs.jsonl is absent', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetJobClassShare(['--root', root, '--json'], undefined, now)).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ malformed: 0 });
    expect(report.rows).toEqual([{ lane: 'total', jobs: 0, tokens: 0, author_pct: null, drain_pct: null, real_pct: null }]);
  });

  it('rejects invalid flags before reading', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn(async () => '');
    for (const args of [['--hours', '0'], ['--hours', '169'], ['--hours', 'x'], ['--hours'], ['--root'], ['--root', '--json'], ['--wat'], ['--json', '--json']]) {
      expect(await cmdFleetJobClassShare(args, read, now)).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(await cmdFleetJobClassShare(['--hours', '168', '--root', '/tmp', '--json'], read, now)).toBe(0);
  });

  it('reports unavailable metrics without leaking the source error', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetJobClassShare([], async () => { throw new Error('private path'); }, now)).toBe(1);
    expect(error).toHaveBeenCalledWith('fleet job-class-share: metrics unavailable');
  });
});
