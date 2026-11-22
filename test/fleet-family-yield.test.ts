import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collapseFamily, familyVerdict, familyYield, launchFamily, readFamilyYield, shouldPauseFamily, type FamilyYieldRow } from '../src/core/fleet/family-yield.js';
import { classifyYieldEmpty } from '../src/core/fleet/empty-why-classify.js';
import { writeDropJob } from '../src/core/fleet/drop-job-writer.js';
import { mkdirSync } from 'node:fs';
import { shouldEmitRecut } from '../src/core/fleet/recut-gate.js';
import { cmdFleetYield, familyYieldLines } from '../src/cli/fleet-yield.js';

const now = Date.parse('2026-11-18T18:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const launch = (job: string, hoursAgo: number) => row({ event: 'launch', job, lane: 'claude', tier: 'work', ts: at(hoursAgo) });
const finish = (job: string, hoursAgo: number, fields: Record<string, unknown>) => row({ event: 'finish', job, ts: at(hoursAgo), ...fields });
const pr = (job: string, n: number) => row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${n}` });
const merged = (job: string, hoursAgo: number) => row({ event: 'outcome', job, state: 'MERGED', ts: at(hoursAgo) });

/** Nov 18 in miniature. */
function fixture(): string[] {
  const lines: string[] = [];
  // stop: a recut family over many areas, 7 runs, 6 empty at 85000 tokens each, 1 merged.
  ['API', 'CLI', 'CORE', 'WEBUI', 'MCP', 'TESTONLY'].forEach((area, i) => {
    const job = `RQ-PHX-RECUT${area}C${600 + i}`;
    lines.push(launch(job, 12 - i), finish(job, 11.5 - i, { empty: true, tokens_total: 85_000 }));
  });
  lines.push(launch('RQ-PHX-RECUTDOCSC606', 4), finish('RQ-PHX-RECUTDOCSC606', 3.5, { empty: false, tokens_total: 40_000 }),
    pr('RQ-PHX-RECUTDOCSC606', 1), merged('RQ-PHX-RECUTDOCSC606', 3));
  // watch: one-test filler, 1 merged of 3.
  for (const [i, id] of ['RQ-MD12A111815Q8', 'RQ-MD13A111816Q8', 'RQ-MD14A111817Q8'].entries()) {
    lines.push(launch(id, 9 - i), finish(id, 8.5 - i, { empty: i > 0, tokens_total: 10_000 }));
    if (i === 0) lines.push(pr(id, 2), merged(id, 8));
  }
  // keep: desk jobs, 1 merged of 2; the merged one never reported tokens.
  lines.push(launch('RQ-CL-DESK-1795042045', 6), finish('RQ-CL-DESK-1795042045', 5, { empty: false }), pr('RQ-CL-DESK-1795042045', 3), merged('RQ-CL-DESK-1795042045', 4));
  lines.push(launch('RQ-CL-DESK-1795042999', 2), finish('RQ-CL-DESK-1795042999', 1, { empty: true, tokens_total: 5_000 }));
  // A job with no number, launched twice: the first run empty, the second merged.
  lines.push(launch('RQ-ROUTER-MUSTSPLIT', 10), finish('RQ-ROUTER-MUSTSPLIT', 9, { empty: true, tokens_total: 2_000 }));
  lines.push(launch('RQ-ROUTER-MUSTSPLIT', 5), finish('RQ-ROUTER-MUSTSPLIT', 4, { empty: false, tokens_total: 3_000 }),
    pr('RQ-ROUTER-MUSTSPLIT', 4), merged('RQ-ROUTER-MUSTSPLIT', 1));
  // Outside the window: never counted.
  lines.push(launch('RQ-PHX-RECUTOLDC500', 30), finish('RQ-PHX-RECUTOLDC500', 29, { empty: true, tokens_total: 85_000 }));
  return lines;
}

describe('collapseFamily', () => {
  it.each([
    ['RQ-PHX-RECUTAPIC606', 'RQ-PHX-RECUT*C*'],
    ['RQ-PHX-RECUTCLIC607', 'RQ-PHX-RECUT*C*'],
    ['RQ-PHX-RECUTCOREFLEETC556', 'RQ-PHX-RECUT*C*'],
    ['RQ-MD12A111815Q8', 'RQ-MD*A*Q8'],
    ['RQ-CL-DESK-1795042045', 'RQ-CL-DESK-*'],
    ['RQ-PHX-SLACKCOMPOSER498S', 'RQ-PHX-SLACKCOMPOSER*S'],
    ['RQ-DEVINCLOUD-RESTOCKGUARD-N17', 'RQ-DEVINCLOUD-RESTOCKGUARD-N*'],
    ['RQ-FAMYIELDN19NQ8', 'RQ-FAMYIELDN*NQ8'],
  ])('%s -> %s, and its anchored pattern matches it', (id, family) => {
    const hit = collapseFamily(id)!;
    expect(hit.family).toBe(family);
    expect(hit.pattern).toMatch(/^\^.*\$$/);
    expect(new RegExp(hit.pattern).test(id)).toBe(true);
  });

  it('keeps ids with no number as their own family', () => {
    expect(collapseFamily('RQ-ROUTER-MUSTSPLIT')).toBeNull();
  });

  it('builds narrow patterns', () => {
    const recut = new RegExp(collapseFamily('RQ-PHX-RECUTAPIC606')!.pattern);
    expect(recut.test('RQ-PHX-RECUTWEBUIC1')).toBe(true);
    expect(recut.test('RQ-PHX-RECUTAPIC606X')).toBe(false);
    expect(recut.test('XRQ-PHX-RECUTAPIC606')).toBe(false);
    expect(recut.test('RQ-PHX-RECUTC5')).toBe(false);
    const filler = new RegExp(collapseFamily('RQ-MD12A111815Q8')!.pattern);
    expect(filler.test('RQ-MD1A2Q8')).toBe(true);
    expect(filler.test('RQ-MDXA2Q8')).toBe(false);
  });
});

describe('familyVerdict', () => {
  it('stops only with 6+ finished runs under 0.2, watches under 0.4, keeps the rest', () => {
    expect(familyVerdict({ finished: 6, merged_per_launch: 0.19 })).toBe('stop');
    expect(familyVerdict({ finished: 5, merged_per_launch: 0 })).toBe('watch');
    expect(familyVerdict({ finished: 6, merged_per_launch: 0.2 })).toBe('watch');
    expect(familyVerdict({ finished: 10, merged_per_launch: 0.39 })).toBe('watch');
    expect(familyVerdict({ finished: 10, merged_per_launch: 0.4 })).toBe('keep');
  });
});

describe('familyYield', () => {
  const report = familyYield(fixture(), now, 24);
  const all = [...report.families, ...report.single];
  const family = (name: string): FamilyYieldRow => all.find(r => r.family === name)!;

  it('groups by family with the three verdicts, most wasted tokens first', () => {
    expect(report).toMatchObject({ schema: 'fleet.family-yield.v1', version: 1, known: true, launches: 14, merged: 4 });
    expect(report.families.map(r => [r.family, r.verdict])).toEqual([
      ['RQ-PHX-RECUT*C*', 'stop'], ['RQ-MD*A*Q8', 'watch'], ['RQ-CL-DESK-*', 'keep'],
    ]);
    expect(family('RQ-PHX-RECUT*C*')).toMatchObject({
      jobs: 7, launches: 7, finished: 7, empty: 6, prs: 1, merged: 1, tokens_total: 550_000, tokens_unknown: 0,
      tokens_per_merged: 550_000, wasted_tokens: 510_000, wasted_tokens_partial: false, last_seen: at(3),
    });
    expect(family('RQ-PHX-RECUT*C*').merged_per_launch).toBeCloseTo(1 / 7);
    expect(family('RQ-MD*A*Q8')).toMatchObject({ launches: 3, merged: 1, empty: 2, wasted_tokens: 20_000 });
  });

  it('counts a job launched twice as two launches of one single job', () => {
    expect(report.single.map(r => r.family)).toEqual(['RQ-ROUTER-MUSTSPLIT']);
    expect(family('RQ-ROUTER-MUSTSPLIT')).toMatchObject({ jobs: 1, launches: 2, finished: 2, empty: 1, merged: 1, merged_per_launch: 0.5,
      tokens_total: 5_000, wasted_tokens: 2_000, verdict: 'keep' });
  });

  it('counts a merge recorded as reverted as reverted, never as a held merge', () => {
    const lines = [
      launch('RQ-REVTEST-1001', 5), finish('RQ-REVTEST-1001', 4.5, { empty: false, tokens_total: 1_000 }),
      pr('RQ-REVTEST-1001', 7), merged('RQ-REVTEST-1001', 4), row({ job: 'RQ-REVTEST-1001', event: 'revert', ts: at(3) }),
      launch('RQ-REVTEST-1002', 3), finish('RQ-REVTEST-1002', 2.5, { empty: true, tokens_total: 500 }),
    ];
    const out = familyYield(lines, now, 24);
    expect(out).toMatchObject({ launches: 2, merged: 0, reverted: 1 });
    expect(out.families[0]).toMatchObject({ family: 'RQ-REVTEST-*', jobs: 2, launches: 2, finished: 2, empty: 1, prs: 1, merged: 0, reverted: 1,
      merged_per_launch: 0, wasted_tokens: 1_500, verdict: 'watch',
      reason: '0 merged of 2 launches, 1 reverted, 1 empty, 1500 tokens on unmerged runs' });
  });

  it('shows a merged job with no token count as unknown, not zero', () => {
    expect(family('RQ-CL-DESK-*')).toMatchObject({ merged: 1, tokens_total: 5_000, tokens_unknown: 1, tokens_per_merged: null, wasted_tokens: 5_000 });
    const lone = familyYield([launch('RQ-CL-DESK-1', 2), pr('RQ-CL-DESK-1', 9), merged('RQ-CL-DESK-1', 1)], now, 24).single[0]!;
    expect(lone).toMatchObject({ merged: 1, finished: 0, tokens_total: null, tokens_unknown: 1, tokens_per_merged: null, wasted_tokens: 0 });
    const unmerged = familyYield([launch('RQ-CL-DESK-2', 2), finish('RQ-CL-DESK-2', 1, { empty: true })], now, 24);
    expect(unmerged.single[0]).toMatchObject({ tokens_total: null, wasted_tokens: null });
    expect(unmerged.wasted_tokens).toBeNull();
    expect(familyYieldLines(unmerged)[0]).toBe('1 launches in the last 24 hours, 0 merged, unknown tokens on unmerged runs');
  });

  it('prints one tab-separated stop row per stop family, 24 hours ahead', () => {
    const until = Math.floor(now / 1000) + 86_400;
    expect(report.stops).toEqual([{ family: 'RQ-PHX-RECUT*C*', pattern: '^RQ-PHX-RECUT[A-Z]+C[0-9]+$', until, reason: 'yield_1of7_empty6',
      line: `^RQ-PHX-RECUT[A-Z]+C[0-9]+$\t${until}\tyield_1of7_empty6` }]);
    const lines = familyYieldLines(report);
    expect(lines[0]).toBe('14 launches in the last 24 hours, 4 merged, 537000 tokens on unmerged runs');
    expect(lines).toContain(report.stops[0]!.line);
    expect(lines).toContain('  stop  RQ-PHX-RECUT*C*: 1 merged of 7 launches, 6 empty, 510000 tokens on unmerged runs; last seen 2026-11-18T15:00:00.000Z');
  });

  it('handles an empty window', () => {
    for (const lines of [[], [launch('RQ-PHX-RECUTOLDC500', 30)], ['{', 'null']]) {
      const empty = familyYield(lines, now, 24);
      expect(empty).toMatchObject({ known: true, launches: 0, merged: 0, wasted_tokens: 0, families: [], single: [], stops: [] });
      expect(familyYieldLines(empty)).toEqual(['No launches in the last 24 hours']);
    }
  });
});

describe('phm fleet yield --json', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it('prints the fleet.family-yield.v1 shape', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'family-yield-')); dirs.push(dir);
    const path = join(dir, 'jobs.jsonl');
    writeFileSync(path, `${fixture().join('\n')}\n`);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetYield(['--hours', '24', '--json', '--metrics', path], undefined, now)).toBe(0);
    const json = JSON.parse(String(log.mock.calls[0]![0])) as Record<string, unknown>;
    expect(Object.keys(json).sort()).toEqual(['families', 'known', 'lanes', 'launch_families', 'launches', 'merged', 'reverted', 'schema', 'single', 'stops', 'tiers',
      'version', 'wasted_tokens', 'wasted_tokens_partial', 'window_hours']);
    const rows = json.families as Record<string, unknown>[];
    expect(Object.keys(rows[0]!).sort()).toEqual(['empty', 'family', 'finished', 'jobs', 'last_seen', 'launches', 'merged', 'merged_per_launch',
      'prs', 'reason', 'reverted', 'tokens_per_merged', 'tokens_total', 'tokens_unknown', 'verdict', 'wasted_tokens', 'wasted_tokens_partial']);
    expect(json.stops).toEqual([expect.objectContaining({ family: 'RQ-PHX-RECUT*C*', pattern: '^RQ-PHX-RECUT[A-Z]+C[0-9]+$', reason: 'yield_1of7_empty6' })]);
    expect(json.lanes).toEqual([expect.objectContaining({ name: 'claude', launches: 14 })]);
  });

  it('prints unknown, never zero, when the metrics file is missing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetYield(['--json', '--metrics', join(tmpdir(), 'family-yield-missing', 'jobs.jsonl')], undefined, now)).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ known: false, launches: null, merged: null, wasted_tokens: null, families: [] });
  });
});


describe('precise launch families', () => {
  it.each([
    ['RQ-PHX-SCRIPTSLAND793B', 'RQ-PHX-SCRIPTSLAND'], ['RQ-PHX-SCRIPTSLAND793', 'RQ-PHX-SCRIPTSLAND'],
    ['RQ-AREA2LAND793B', 'RQ-AREA2LAND'], ['RQ-PHX-SCRIPTSLAND793BB', 'RQ-PHX-SCRIPTSLAND793BB'],
    ['RQ-NO-NUMBER', 'RQ-NO-NUMBER'],
  ])('groups %s as %s', (id, expected) => expect(launchFamily(id)).toBe(expected));

  it('counts launches, unique published PRs, merges and EMPTY-only tokens in the 24 h cohort', () => {
    const a = 'RQ-PHX-SCRIPTSLAND793B', b = 'RQ-PHX-SCRIPTSLAND793', c = 'RQ-PHX-SCRIPTSLAND794';
    const report = familyYield([
      launch(a, 3), finish(a, 2, { empty: true, tokens_total: 1_500_000 }),
      launch(b, 3), finish(b, 2, { tokens_total: 50 }), pr(b, 1), pr(b, 1), merged(b, 1), merged(b, 1),
      launch(c, 3), finish(c, 2, { tokens_total: 900 }), // unmerged PR work is not EMPTY waste
      launch('RQ-OLD9', 25), launch('RQ-FUTURE9', -1),
    ], now, 24);
    expect(report.launch_families).toEqual([expect.objectContaining({ family: 'RQ-PHX-SCRIPTSLAND', launches: 3,
      prs: 1, merged: 1, empty: 1, merged_per_launch: 1 / 3, empty_tokens: 1_500_000, empty_tokens_partial: false,
      sentence: "SCRIPTSLAND: 1 of 3 merged, 1.5M tokens on empty runs; 1 of 3 empty, mostly 'reason unknown'" })]);
  });

  it('ranks the worst rates first and preserves unknown and partial EMPTY usage', () => {
    const report = familyYield([launch('RQ-UNKNOWN1', 3), finish('RQ-UNKNOWN1', 2, { empty: true }),
      launch('RQ-PARTIAL1', 3), finish('RQ-PARTIAL1', 2, { empty: true, tokens_total: 20 }),
      launch('RQ-PARTIAL2', 3), finish('RQ-PARTIAL2', 2, { empty: true }),
      launch('RQ-GOOD1', 3), pr('RQ-GOOD1', 9), merged('RQ-GOOD1', 1)], now, 24);
    expect(report.launch_families.map(r => r.family)).toEqual(['RQ-PARTIAL', 'RQ-UNKNOWN', 'RQ-GOOD']);
    expect(report.launch_families[0]).toMatchObject({ empty_tokens: 20, empty_tokens_partial: true });
    expect(report.launch_families[0]!.sentence).toContain('at least 20 tokens');
    expect(report.launch_families[1]).toMatchObject({ empty_tokens: null, empty_tokens_partial: true });
    expect(report.launch_families[2]).toMatchObject({ empty_tokens: 0, empty_tokens_partial: false });
  });
});

describe('EMPTY reason pause', () => {
  it.each([
    ['No eligible PR', 'no_eligible_source'], ['source PR already merged', 'no_eligible_source'],
    ['Worker finished with no changes produced.', 'no_diff'], ['precheck skipped: stale source', 'precheck_skip'],
    ['MCP tool failed; no diff', 'worker_error'], ['RESULT EMPTY', 'unknown'],
    ['No eligible PR; permission denied', 'worker_error'],
    [`No eligible PR\n${'working\n'.repeat(61)}RESULT EMPTY`, 'unknown'],
  ])('classifies fixture %s', (log, reason) => expect(classifyYieldEmpty(log)).toBe(reason));
  const history = (name = 'CONSOLELAND', count = 4) => Array.from({ length: count }, (_, i) => {
    const job = `RQ-PHX-${name}${793 + i}${i === 0 ? 'B' : ''}`;
    return [launch(job, 10 - i), finish(job, 9.5 - i, { empty: true, summary: i % 2 ? 'no diff' : 'No eligible PR' })];
  }).flat();
  it('groups letter siblings and pauses only the last N proven empty finished launches', () => {
    const lines = history(), stats = familyYield(lines, now, 24).launch_families[0]!;
    expect(stats).toMatchObject({ family: 'RQ-PHX-CONSOLELAND', paused: true, empty_reasons: { no_diff: 2, no_eligible_source: 2, unknown: 0 } });
    expect(shouldPauseFamily(stats, 5)).toBe(false);
    expect(shouldPauseFamily(undefined)).toBe(false);
    expect(shouldPauseFamily(stats, 0)).toBe(false);
    expect(shouldEmitRecut({ family: stats.family, stopList: [], lastJobs: [], masterTouched: true, diffContained: false, yieldStats: stats }).code).toBe('family-paused');
    for (const fields of [{ empty: false }, { empty: true }, { empty: true, summary: 'worker_error' }, { empty: true, summary: 'precheck_skip' }]) {
      const updated = familyYield([...lines, launch('RQ-PHX-CONSOLELAND799', 1), finish('RQ-PHX-CONSOLELAND799', 0.5, fields)], now, 24);
      expect(shouldPauseFamily(updated.launch_families[0])).toBe(false);
    }
    expect(shouldPauseFamily(familyYield([...lines, launch('RQ-PHX-CONSOLELAND799', 1)], now, 24).launch_families[0])).toBe(true);
  });
  it('uses bounded log evidence, and prevents LAND, recut and red-fix drops before writing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'family-pause-'));
    try {
      mkdirSync(join(dir, 'metrics'));
      const lines = ['CONSOLELAND', 'RECUT', 'REDFIX'].flatMap(name => history(name));
      lines.push(launch('RQ-LOG1', 2), finish('RQ-LOG1', 1, { empty: true }));
      writeFileSync(join(dir, 'metrics/jobs.jsonl'), lines.join('\n'));
      writeFileSync(join(dir, 'RQ-LOG1.log'), 'No eligible PR');
      const report = await readFamilyYield(join(dir, 'metrics/jobs.jsonl'), 24, now);
      expect(report.launch_families.find(r => r.family === 'RQ-LOG')?.empty_reasons.no_eligible_source).toBe(1);
      for (const id of ['CONSOLELAND800', 'RECUT800', 'REDFIX800']) {
        await expect(writeDropJob(dir, { id, lane: 'codex-personal', tier: 'work', body: 'Find a source PR and finish it.' }, () => new Date(now))).rejects.toThrow('family paused');
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
