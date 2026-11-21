import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetYield, jobFamily, jobYield } from '../src/core/fleet/slot-yield.js';
import { cmdFleetYield, familyYieldLines, type YieldLineReader } from '../src/cli/fleet-yield.js';
import { readFamilyYield } from '../src/core/fleet/family-yield.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const now = Date.parse('2026-11-17T00:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const launch = (job: string, hoursAgo: number, lane = 'codex-personal', tier = 'work') =>
  row({ event: 'launch', job, lane, model: 'fake-model', tier, ts: at(hoursAgo) });
const finish = (job: string, fields: Record<string, unknown>) => row({ event: 'finish', job, ...fields });
const pr = (job: string, n: number) => row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${n}` });
const outcome = (job: string, state: string) => row({ event: 'outcome', job, state, ttm_s: 150 });

/** Nov 16 in miniature: 13 recut launches yield 3 PRs; 5 leader launches yield 5 merged PRs. */
function fixture(): string[] {
  const lines: string[] = [];
  // Relaunched job: first run empty, second run opens a PR that merges. Two launches, one merge.
  lines.push(launch('RQ-PHX-RECUTAPIC500', 20), finish('RQ-PHX-RECUTAPIC500', { empty: true, tokens_total: 1000, wall_s: 100 }));
  lines.push(launch('RQ-PHX-RECUTAPIC500', 18), finish('RQ-PHX-RECUTAPIC500', { empty: false, tokens_total: 3000, wall_s: 300 }),
    pr('RQ-PHX-RECUTAPIC500', 1), outcome('RQ-PHX-RECUTAPIC500', 'MERGED'));
  // PR with no outcome yet, and its finish row has no token count.
  lines.push(launch('RQ-PHX-RECUTCOREC497', 10), finish('RQ-PHX-RECUTCOREC497', { empty: false, wall_s: 200 }), pr('RQ-PHX-RECUTCOREC497', 2));
  // PR that closed unmerged, published as abort after a retry.
  lines.push(launch('RQ-PHX-RECUTWEBUIC458', 9), finish('RQ-PHX-RECUTWEBUIC458', { empty: false, tokens_total: 2000, wall_s: 250 }),
    pr('RQ-PHX-RECUTWEBUIC458', 3), outcome('RQ-PHX-RECUTWEBUIC458', 'CLOSED'));
  for (let i = 0; i < 9; i++) {
    const job = `RQ-PHX-RECUTSRCC${470 + i}`;
    lines.push(launch(job, 8 - i * 0.5), finish(job, { empty: true, tokens_total: 500, wall_s: 60 }), row({ event: 'publish', job, class: 'empty' }));
  }
  for (const [i, letter] of ['A', 'B', 'C', 'D', 'E'].entries()) {
    const job = `RQ-LEADJOBN16${letter}Q8`;
    lines.push(launch(job, 6 - i, 'claude', 'frontier'), finish(job, { empty: false, tokens_total: 10_000, wall_s: 600 }), pr(job, 10 + i), outcome(job, 'MERGED'));
  }
  // Launched before the window: its later rows must not count.
  lines.push(launch('RQ-PHX-RECUTOLDC300', 30), finish('RQ-PHX-RECUTOLDC300', { empty: true }), outcome('RQ-PHX-RECUTOLDC300', 'MERGED'));
  // An aborted run on another family, plus malformed lines.
  lines.push(launch('RQ-LOCUS1A111623Q8', 2, 'zai', 'work'), row({ event: 'publish', job: 'RQ-LOCUS1A111623Q8', class: 'abort_timeout' }), '{', 'null', '[]');
  return lines;
}

describe('jobFamily', () => {
  it.each([
    ['RQ-PHX-RECUTAPIC500', 'RQ-PHX-RECUT*'],
    ['RQ-PHX-RECUTCOREC497', 'RQ-PHX-RECUT*'],
    ['RQ-PHX-RECUTCOREFLEETC485', 'RQ-PHX-RECUT*'],
    ['RQ-PHX-SLACKCOMPOSERRETURN499S', 'RQ-PHX-SLACK*'],
    ['RQ-PHX-SLACKTHREAD498S', 'RQ-PHX-SLACK*'],
    ['RQ-LOCUS1A111623Q8', 'RQ-LOCUS*'],
    ['RQ-SLOTYIELDN16NQ8', 'leader'],
    ['RQ-LOADSRCN16AQ8', 'leader'],
    ['RQ-PR-LEVERAGE-1', 'RQ-PR-LEVERAGE*'],
    ['RQ-ROUTER-MUSTSPLIT', 'RQ-ROUTER-MUSTSPLIT'],
  ])('%s -> %s', (id, family) => expect(jobFamily(id)).toBe(family));
});

describe('fleetYield', () => {
  const report = fleetYield(fixture(), now, 24);
  const family = (name: string) => report.families.find(r => r.name === name)!;

  it('counts each launch once, credits a relaunch merge once, and ignores runs before the window', () => {
    expect(report.launches).toBe(19);
    expect(family('RQ-PHX-RECUT*')).toMatchObject({ launches: 13, prs: 3, merged: 1, empty: 10, aborted: 0, finished: 13 });
    expect(family('RQ-PHX-RECUT*').merged_per_launch).toBeCloseTo(1 / 13);
    expect(family('RQ-PHX-RECUT*').verdict).toMatch(/^RQ-PHX-RECUT\*: 3 PRs from 13 launches, 1 merged, 10 empty/);
    expect(family('leader')).toMatchObject({ launches: 5, prs: 5, merged: 5, empty: 0, merged_per_launch: 1, tokens: 50_000, tokens_per_merged: 10_000, median_run_s: 600 });
    expect(family('leader').verdict).toBe('leader: 5 PRs from 5 launches, 5 merged, 0 empty, 10000 tokens per merged PR');
  });

  it('shows missing tokens as unknown, never zero', () => {
    const recut = family('RQ-PHX-RECUT*');
    expect(recut).toMatchObject({ tokens: 10_500, tokens_measured: 12, tokens_per_merged: null });
    expect(recut.verdict).toContain('tokens per merged PR unknown');
    const locus = family('RQ-LOCUS*');
    expect(locus).toMatchObject({ launches: 1, finished: 0, tokens: null, aborted: 1, median_run_s: null, tokens_per_merged: null });
  });

  it('sorts worst yield first among families with 5+ launches, then small families', () => {
    expect(report.families.map(r => r.name)).toEqual(['RQ-PHX-RECUT*', 'leader', 'RQ-LOCUS*']);
    expect(report.lanes.map(r => [r.name, r.launches])).toEqual([['codex-personal', 13], ['claude', 5], ['zai', 1]]);
    expect(report.tiers.map(r => [r.name, r.launches])).toEqual([['work', 14], ['frontier', 5]]);
  });

  it('rejects a non-positive window', () => {
    expect(() => fleetYield([], now, 0)).toThrow(RangeError);
  });
});

describe('jobs-ledger dialect', () => {
  it('credits reconciler PUBLISHED and MERGED rows keyed by jobId/prUrl/outcome', () => {
    const lines = [
      launch('RQ-DIALECT-1', 3),
      row({ jobId: 'RQ-DIALECT-1', prUrl: 'https://github.com/example/fake/pull/21', outcome: 'PUBLISHED', timestamp: at(2) }),
      row({ jobId: 'RQ-DIALECT-1', prUrl: 'https://github.com/example/fake/pull/21', outcome: 'MERGED', mergedAt: at(1), reconciledAt: at(0.5), source: 'metrics-outcomes-reconciler' }),
    ];
    const report = fleetYield(lines, now, 24);
    expect(report.families).toEqual([expect.objectContaining({ name: 'RQ-DIALECT*', launches: 1, prs: 1, merged: 1, reverted: 0 })]);
  });

  it('credits a reconciler row that kept event:publish with a resolved phase', () => {
    const lines = [
      launch('RQ-DIALECT-2', 3),
      row({ event: 'publish', job: 'RQ-DIALECT-2', class: 'pr', url: 'https://github.com/example/fake/pull/22', ts: at(2) }),
      row({ event: 'publish', jobId: 'RQ-DIALECT-2', prUrl: 'https://github.com/example/fake/pull/22', outcome: 'MERGED', mergedAt: at(1), source: 'metrics-outcomes-reconciler' }),
    ];
    expect(fleetYield(lines, now, 24).families[0]).toMatchObject({ launches: 1, prs: 1, merged: 1 });
  });

  it('reads status/closedAt terminal rows without merging them', () => {
    const lines = [
      launch('RQ-DIALECT-3', 3),
      row({ jobId: 'RQ-DIALECT-3', prUrl: 'https://github.com/example/fake/pull/23', status: 'PUBLISHED', ts: at(2) }),
      row({ jobId: 'RQ-DIALECT-3', prUrl: 'https://github.com/example/fake/pull/23', status: 'CLOSED', closedAt: at(1), source: 'metrics-outcomes-reconciler' }),
    ];
    expect(fleetYield(lines, now, 24).families[0]).toMatchObject({ launches: 1, prs: 1, merged: 0 });
  });

  it('accepts type/kind event names, job_id/id keys, pool lanes and timestamp aliases', () => {
    const lines = [
      row({ type: 'launch', job_id: 'RQ-DIALECT-4', pool: 'zai', timestamp: at(3) }),
      row({ kind: 'finish', id: 'RQ-DIALECT-4', empty: false, wall_s: 100, recordedAt: at(2) }),
      row({ kind: 'outcome', jobId: 'RQ-DIALECT-4', outcome: 'MERGED', updatedAt: at(1) }),
    ];
    const report = fleetYield(lines, now, 24);
    expect(report.families[0]).toMatchObject({ launches: 1, prs: 0, merged: 1, finished: 1 });
    expect(report.lanes.map(r => [r.name, r.launches])).toEqual([['zai', 1]]);
  });

  it('counts skipped_empty and skipped_empty-style skips but not dry-run precheck_skip rows', () => {
    const lines = [
      row({ event: 'skipped_empty', job: 'RQ-DIALECT-SK1', repo: 'phantom', ts: at(1) }),
      row({ event: 'precheck_skip', job: 'RQ-DIALECT-SK2', repo: 'phantom', applied: false, ts: at(1) }),
      row({ event: 'precheck_skip', job: 'RQ-DIALECT-SK2', repo: 'phantom', ts: at(1) }),
    ];
    expect(jobYield(lines, now, 24).families).toEqual([expect.objectContaining({ family: 'RQ-DIALECT-SK', launches: 0, skipped: 2 })]);
  });

  it('reads merged:true as merge evidence and keeps reconciler merges revert-sticky', () => {
    const lines = [
      launch('RQ-DIALECT-5', 3),
      row({ jobId: 'RQ-DIALECT-5', merged: true, ts: at(2) }),
      launch('RQ-DIALECT-6', 3),
      row({ jobId: 'RQ-DIALECT-6', prUrl: 'https://github.com/example/fake/pull/26', outcome: 'PUBLISHED', ts: at(2) }),
      row({ jobId: 'RQ-DIALECT-6', prUrl: 'https://github.com/example/fake/pull/26', outcome: 'MERGED', mergedAt: at(1.5) }),
      row({ job: 'RQ-DIALECT-6', reverted: true, ts: at(1) }),
    ];
    expect(fleetYield(lines, now, 24).families[0]).toMatchObject({ launches: 2, prs: 1, merged: 1, reverted: 1 });
  });

  it('does not let a phase-less outcome row overwrite a recorded merge', () => {
    const lines = [
      launch('RQ-DIALECT-7', 3),
      pr('RQ-DIALECT-7', 7),
      outcome('RQ-DIALECT-7', 'MERGED'),
      row({ event: 'outcome', job: 'RQ-DIALECT-7', ts: at(0.4) }),
    ];
    expect(fleetYield(lines, now, 24).families[0]).toMatchObject({ launches: 1, prs: 1, merged: 1 });
  });
});

describe('cmdFleetYield', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('is registered and validates arguments without reading', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await FLEET_SUBCOMMAND_LOADERS.yield!()).cmdFleetYield).toBe(cmdFleetYield);
    const read = vi.fn<YieldLineReader>(async () => true);
    for (const args of [['--since'], ['--since', '0h'], ['--since', '1w'], ['--hours'], ['--hours', '0'], ['--hours', '-1'], ['--hours', '9000'],
      ['--hours', '2', '--since', '2h'], ['--json', '--json'], ['--metrics'], ['bad']]) {
      expect(await cmdFleetYield(args, read, now)).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('reads a metrics file and prints family verdict lines, lanes and tiers, or JSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-yield-')); dirs.push(dir);
    const path = join(dir, 'jobs.jsonl');
    writeFileSync(path, `${fixture().join('\n')}\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetYield(['--since', '1d', '--metrics', path], undefined, now)).toBe(0);
    const text = String(log.mock.calls[0]![0]);
    expect(text.split('\n').slice(0, 3)).toEqual([
      '19 launches in the last 24 hours, 6 merged, 7500+ tokens on unmerged runs',
      'Job families, most wasted tokens first:',
      '  stop  RQ-PHX-RECUT*C*: 1 merged of 13 launches, 10 empty, 7500+ tokens on unmerged runs; last seen 2026-11-16T20:00:00.000Z',
    ]);
    expect(text).toContain('By lane:\n  codex-personal: 3 PRs from 13 launches');
    expect(await cmdFleetYield(['--json', '--hours', '24', '--metrics', path], undefined, now)).toBe(0);
    const json = JSON.parse(String(log.mock.calls[1]![0]));
    expect(json).toMatchObject({ schema: 'fleet.family-yield.v1', known: true, window_hours: 24, launches: 19 });
    expect(json.families[0]).toMatchObject({ family: 'RQ-PHX-RECUT*C*', tokens_per_merged: null, verdict: 'stop' });
  });

  it('reports unknown when the metrics file is missing', async () => {
    const report = await readFamilyYield(join(tmpdir(), 'fleet-yield-missing', 'jobs.jsonl'), 24, now);
    expect(report).toMatchObject({ known: false, launches: null, wasted_tokens: null });
    expect(familyYieldLines(report)).toEqual(['Family yield: unknown (job metrics file unreadable)']);
  });
});
