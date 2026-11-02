import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyMergeJob, main, realMergeReport } from '../scripts/fleet-real-merges.mjs';

const NOW = Date.parse('2026-11-01T20:00:00Z');
const at = (clock: string) => `2026-11-01T${clock}:00Z`;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const H = 3_600_000;
const launch = (job: string, ts: string) => JSON.stringify({ job, event: 'launch', ts, lane: 'devin' });
const merged = (job: string, ts: string) => JSON.stringify({ job, event: 'outcome', state: 'MERGED', ts, url: 'https://github.com/ashlrai/phantom/pull/9' });
const outcome = (job: string, ts: string, state: string) => JSON.stringify({ job, event: 'outcome', state, ts });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-real-merges-'));
  mkdirSync(join(dir, 'metrics'), { recursive: true });
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function writeFixture(lines: string[]) {
  writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), lines.join('\n') + '\n');
}

describe('classifyMergeJob', () => {
  it('splits author filler ids ending in A plus six or more digits plus Q8 from real work', () => {
    const cases: [string, string][] = [
      ['RQ-PS1A251031Q8', 'author'],
      ['RQ-LEXICON3A251031Q8', 'author'],
      ['RQ-STACK12A20261031Q8', 'author'],
      ['RQ-REALMERGERATEQ8', 'real'],
      ['RQ-PHX-SOMETHING01', 'real'],
      ['RQ-A12345Q8', 'real'],
      ['manual-audit', 'real'],
      ['RQ-PS1A251031Q8-retry', 'real'],
    ];
    expect(cases.map(([id]) => classifyMergeJob(id))).toEqual(cases.map(([, cls]) => cls));
  });
});

describe('realMergeReport', () => {
  const fixture = [
    launch('RQ-PS1A251031Q8', at('15:00')),
    merged('RQ-PS1A251031Q8', at('19:00')),
    launch('RQ-PS1A251031Q8', at('16:00')),
    launch('RQ-STACK9A251031Q8', at('17:00')),
    merged('RQ-STACK9A251031Q8', at('18:00')),
    launch('RQ-REAL-WORK-1', at('16:30')),
    merged('RQ-REAL-WORK-1', at('19:30')),
    merged('RQ-REAL-WORK-2', at('19:45')),
    merged('RQ-PS4A251031Q8', '2026-10-30T10:00:00Z'),
    launch('RQ-PS4A251031Q8', '2026-10-30T09:00:00Z'),
    outcome('RQ-OPEN-1', at('19:00'), 'OPEN'),
    JSON.stringify({ job: 'RQ-FINISH-1', event: 'finish', ts: at('19:00'), tokens_total: 5 }),
    'not json',
    '{"event":"outcome"}',
    '',
  ].join('\n');

  it('counts in-window merges per class, the per-hour rate and median launch-to-merge minutes', () => {
    const report = realMergeReport(fixture, 24, NOW);
    expect(report).toMatchObject({ schema: 'fleet.real-merges.v1', hours: 24, malformed: 2 });
    expect(report.rows).toEqual([
      { class: 'author', merges: 2, mergesPerHour: 0.083, medianLaunchToMergeMinutes: 150 },
      { class: 'real', merges: 2, mergesPerHour: 0.083, medianLaunchToMergeMinutes: 180 },
      { class: 'total', merges: 4, mergesPerHour: 0.167, medianLaunchToMergeMinutes: 180 },
    ]);
  });

  it('keeps the earliest launch and earliest merge per job and requires a non-negative duration', () => {
    const report = realMergeReport([
      launch('RQ-REAL-WORK-1', at('18:00')),
      launch('RQ-REAL-WORK-1', at('19:00')),
      merged('RQ-REAL-WORK-1', at('19:30')),
      merged('RQ-REAL-WORK-1', at('19:45')),
      launch('RQ-REAL-WORK-2', at('19:50')),
      merged('RQ-REAL-WORK-2', at('19:45')),
    ].join('\n'), 24, NOW);
    expect(report.rows).toEqual([
      { class: 'author', merges: 0, mergesPerHour: 0, medianLaunchToMergeMinutes: null },
      { class: 'real', merges: 2, mergesPerHour: 0.083, medianLaunchToMergeMinutes: 90 },
      { class: 'total', merges: 2, mergesPerHour: 0.083, medianLaunchToMergeMinutes: 90 },
    ]);
  });

  it('supports job_id/id fields, rejects an invalid window and bounds future merges', () => {
    const input = [
      JSON.stringify({ job_id: 'RQ-REAL-1', event: 'launch', ts: at('18:00') }),
      JSON.stringify({ id: 'RQ-REAL-1', event: 'outcome', state: 'merged', ts: at('19:00') }),
      JSON.stringify({ job: 'RQ-REAL-2', event: 'outcome', state: 'MERGED', ts: at('21:00') }),
    ].join('\n');
    const report = realMergeReport(input, 24, NOW);
    expect(report.rows[2]).toEqual({ class: 'total', merges: 1, mergesPerHour: 0.042, medianLaunchToMergeMinutes: 60 });
    expect(() => realMergeReport('', 0, NOW)).toThrow('Invalid reporting window');
    expect(() => realMergeReport('', -1, NOW)).toThrow('Invalid reporting window');
    expect(() => realMergeReport('', 1, Number.NaN)).toThrow('Invalid reporting window');
  });
});

describe('main', () => {
  it('prints a text table over the fixture ledger in the default location', async () => {
    writeFixture([
      launch('RQ-PS1A251031Q8', iso(5 * H)),
      merged('RQ-PS1A251031Q8', iso(1 * H)),
      launch('RQ-REAL-WORK-1', iso(4 * H)),
      merged('RQ-REAL-WORK-1', iso(30 * 60 * 1000)),
      merged('RQ-PS9A251031Q8', iso(26 * H)),
      'not json',
    ]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--hours', '24'])).toBe(0);
    expect(String(output.mock.calls[0]![0]).split('\n')).toEqual([
      'class merges per_hour median_min',
      'author 1 0.042 240.0',
      'real 1 0.042 210.0',
      'total 2 0.083 225.0',
      'Malformed rows: 1',
    ]);
  });

  it('prints the fleet.real-merges.v1 report with --json', async () => {
    writeFixture([
      launch('RQ-REAL-WORK-1', iso(3 * H)),
      merged('RQ-REAL-WORK-1', iso(1 * H)),
      merged('RQ-REAL-WORK-2', iso(2 * H)),
    ]);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--hours', '24', '--json'])).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ schema: 'fleet.real-merges.v1', hours: 24, malformed: 0 });
    expect(Number.isFinite(Date.parse(report.generatedAt))).toBe(true);
    expect(report.rows).toEqual([
      { class: 'author', merges: 0, mergesPerHour: 0, medianLaunchToMergeMinutes: null },
      { class: 'real', merges: 2, mergesPerHour: 0.083, medianLaunchToMergeMinutes: 120 },
      { class: 'total', merges: 2, mergesPerHour: 0.083, medianLaunchToMergeMinutes: 120 },
    ]);
  });

  it('reads an explicit --jobs path and resolves the ledger under a bare HOME', async () => {
    const file = join(dir, 'elsewhere.jsonl');
    writeFileSync(file, merged('RQ-REAL-WORK-1', iso(1 * H)) + '\n');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--jobs', file, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0])).rows[2].merges).toBe(1);
    mkdirSync(join(dir, '.ashlr-runs', 'metrics'), { recursive: true });
    writeFileSync(join(dir, '.ashlr-runs', 'metrics', 'jobs.jsonl'), merged('RQ-REAL-WORK-1', iso(1 * H)) + '\n');
    vi.stubEnv('HOME', dir);
    vi.stubEnv('ASHLR_RUNS_DIR', undefined);
    expect(await main(['--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.calls[1]![0])).rows[2].merges).toBe(1);
  });

  it('reports empty totals when the ledger is absent', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--json'])).toBe(0);
    const report = JSON.parse(String(output.mock.calls[0]![0]));
    expect(report).toMatchObject({ malformed: 0 });
    expect(report.rows).toEqual([
      { class: 'author', merges: 0, mergesPerHour: 0, medianLaunchToMergeMinutes: null },
      { class: 'real', merges: 0, mergesPerHour: 0, medianLaunchToMergeMinutes: null },
      { class: 'total', merges: 0, mergesPerHour: 0, medianLaunchToMergeMinutes: null },
    ]);
    expect(await main([])).toBe(0);
    expect(String(output.mock.calls[1]![0])).toContain('total 0 0.000 -');
  });

  it('exits 1 without echoing internals when the ledger is unreadable and 2 for invalid arguments', async () => {
    writeFixture([merged('RQ-REAL-WORK-1', iso(1 * H))]);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await main(['--jobs', join(dir, 'metrics')])).toBe(1);
    expect(error).toHaveBeenCalledWith('fleet real-merges: metrics unavailable');
    for (const args of [['--hours', '0'], ['--hours', '169'], ['--hours', 'x'], ['--hours'], ['--jobs'], ['--jobs', '--json'], ['--json', '--json'], ['--bogus']]) {
      expect(await main(args)).toBe(2);
      expect(String(error.mock.calls.at(-1)![0])).toContain('Usage: node scripts/fleet-real-merges.mjs');
    }
    expect(await main(['--help'])).toBe(0);
  });
});
