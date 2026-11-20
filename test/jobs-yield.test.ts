import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobKind, jobVerdict, jobYield, unknownJobYield, type JobYieldFamily } from '../src/core/fleet/slot-yield.js';
import { readJobYield } from '../src/core/fleet/metrics-series.js';
import { readMetricsPanel } from '../src/core/fleet/metrics-panel.js';
import { cmdJobs } from '../src/cli/jobs-empty.js';
import { cmdJobsYield, jobYieldLines } from '../src/cli/jobs-yield.js';

const now = Date.parse('2026-11-18T00:00:00Z');
const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);
const launch = (job: string, repo = 'phantom', hoursAgo = 2) => row({ event: 'launch', job, repo, lane: 'work', tier: 'mid', ts: at(hoursAgo) });
const finish = (job: string, empty: boolean) => row({ event: 'finish', job, empty, ts: at(1) });
const pr = (job: string) => row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: at(1) });
const outcome = (job: string, state: string) => row({ event: 'outcome', job, state, ts: at(0.5) });
const skip = (job: string, repo?: string) => row({ event: 'precheck_skip', job, repo, lane: 'work', code: 13, ts: at(1) });
const merged = (job: string, repo?: string) => [launch(job, repo), finish(job, false), pr(job), outcome(job, 'MERGED')];
const empty = (job: string, repo?: string) => [launch(job, repo), finish(job, true)];
const family = (lines: string[], name: string): JobYieldFamily => jobYield(lines, now, 24).families.find(f => f.family === name)!;

// Fixture families. Counts are per family, in the order launches / empty / skipped / merged.
const allMerge = Array.from({ length: 4 }, (_, i) => merged(`RQ-DOCS-FIX-${i + 1}`)).flat();
const allEmptyRecut = Array.from({ length: 6 }, (_, i) => empty(`RQ-PHX-RECUTCOREC${561 + i}`)).flat();
const fillerWithSkips = [...Array.from({ length: 7 }, (_, i) => empty(`RQ-MD${i + 1}A11180${i}Q8`, 'md')).flat(),
  skip('RQ-MD8A111807Q8', 'md'), skip('RQ-MD8A111807Q8', 'md'), skip('RQ-MD1A111800Q8')];
const mixed = [...merged('RQ-PHX-RECUTWEBC561'), ...merged('RQ-PHX-RECUTWEBC562'), ...Array.from({ length: 8 }, (_, i) => empty(`RQ-PHX-RECUTWEBC${563 + i}`)).flat(),
  // A PR that closed unmerged and one still open: slots used, nothing merged.
  launch('RQ-PHX-RECUTWEBC571'), finish('RQ-PHX-RECUTWEBC571', false), pr('RQ-PHX-RECUTWEBC571'), outcome('RQ-PHX-RECUTWEBC571', 'CLOSED'),
  launch('RQ-PHX-RECUTWEBC572'), finish('RQ-PHX-RECUTWEBC572', false), pr('RQ-PHX-RECUTWEBC572'), outcome('RQ-PHX-RECUTWEBC572', 'OPEN')];

describe('jobKind', () => {
  it.each([
    ['RQ-PHX-RECUTCOREC566', 'RQ-PHX-RECUTCORE'], ['RQ-PHX-RECUTCOREC562', 'RQ-PHX-RECUTCORE'], ['RQ-PHX-RECUTTESTONLYC556', 'RQ-PHX-RECUTTESTONLY'],
    ['RQ-PHX-SLACKREACQUIRE566S', 'RQ-PHX-SLACKREACQUIRE'], ['RQ-FAMILYYIELDN18RQ8', 'RQ-FAMILYYIELD'], ['RQ-EMPTYWORKN21Q8', 'RQ-EMPTYWORK'],
    ['RQ-PR-LEVERAGE-1', 'RQ-PR-LEVERAGE'], ['RQ-DEVINCLOUD-CLAIMDRIFT2-N17', 'RQ-DEVINCLOUD-CLAIMDRIFT'], ['RQ-DEVINCLOUD-LAND6731C-N17', 'RQ-DEVINCLOUD-LAND'],
    ['RQ-CI-ECO-CRON-ONLY-SUITES', 'RQ-CI-ECO-CRON-ONLY-SUITES'], ['RQ-RECUTDEDUPQ8', 'RQ-RECUTDEDUP'], ['RQ-RCFPHX6812Q8', 'RQ-RCFPHX'], ['RQ-7', 'RQ'], ['42', '42'],
  ])('%s is kind %s', (id, kind) => expect(jobKind(id)).toBe(kind));

  it('groups one-test filler by repo: the launch repo, else the repo code in the id', () => {
    expect(jobKind('RQ-MD3A111800Q8', 'md')).toBe('one-test filler md');
    expect(jobKind('RQ-LOCUS2A111723Q8', 'locus')).toBe('one-test filler locus');
    expect(jobKind('RQ-LOCUS2A111723Q8')).toBe('one-test filler locus');
  });
});

describe('jobVerdict', () => {
  it.each([
    [{ launches: 10, running: 0, merged: 3 }, 'keep'], [{ launches: 1, running: 0, merged: 1 }, 'keep'],
    [{ launches: 10, running: 0, merged: 2 }, 'watch'], [{ launches: 10, running: 0, merged: 1 }, 'watch'],
    [{ launches: 5, running: 0, merged: 0 }, 'watch'], [{ launches: 0, running: 0, merged: 0 }, 'watch'],
    [{ launches: 6, running: 0, merged: 0 }, 'stop'], [{ launches: 11, running: 0, merged: 1 }, 'stop'],
    // Six launches, two still running: only four have ended, so it is too early to stop.
    [{ launches: 6, running: 2, merged: 0 }, 'watch'],
  ] as const)('%j is %s', (counts, verdict) => expect(jobVerdict(counts)).toBe(verdict));
});

describe('jobYield', () => {
  it('keeps a family where every launch merged', () => {
    expect(family(allMerge, 'RQ-DOCS-FIX')).toEqual({ family: 'RQ-DOCS-FIX', launches: 4, running: 0, empty: 0, skipped: 0, prs: 4, merged: 4, reverted: 0,
      merged_per_launch: 1, verdict: 'keep', reason: '4 merged from 4 launches' });
  });

  it('stops a recut family where every launch came back empty', () => {
    expect(family(allEmptyRecut, 'RQ-PHX-RECUTCORE')).toMatchObject({ launches: 6, empty: 6, merged: 0, merged_per_launch: 0, verdict: 'stop',
      reason: '0 merged from 6 launches, 6 empty' });
  });

  it('stops a filler family and counts its precheck skips, including a skipped job that never launched', () => {
    expect(family(fillerWithSkips, 'one-test filler md')).toMatchObject({ launches: 7, empty: 7, skipped: 3, merged: 0, verdict: 'stop',
      reason: '0 merged from 7 launches, 7 empty, 3 skipped before launch' });
  });

  it('watches a mixed family between the two rates; closed and open PRs are not merges', () => {
    expect(family(mixed, 'RQ-PHX-RECUTWEB')).toMatchObject({ launches: 12, empty: 8, prs: 4, merged: 2, verdict: 'watch' });
    expect(family(mixed, 'RQ-PHX-RECUTWEB').merged_per_launch).toBeCloseTo(2 / 12);
  });

  it('reports zero launches for empty input, with a schema and version', () => {
    expect(jobYield([], now, 24)).toEqual({ schema: 'jobs.yield.v1', version: 1, window_hours: 24, known: true, launches: 0, merged: 0, reverted: 0, empty: 0, skipped: 0,
      stop_slots: 0, summary: 'No launches in the last 24 hours', families: [], stop_first: [] });
  });

  it('sorts stop, watch, keep and writes the top line in plain words', () => {
    const report = jobYield([...allMerge, ...allEmptyRecut, ...fillerWithSkips, ...mixed, 'not json', '[]', row({ event: 'launch' })], now, 24);
    expect(report.families.map(f => [f.family, f.verdict])).toEqual([['one-test filler md', 'stop'], ['RQ-PHX-RECUTCORE', 'stop'], ['RQ-PHX-RECUTWEB', 'watch'], ['RQ-DOCS-FIX', 'keep']]);
    expect(report).toMatchObject({ launches: 29, merged: 6, empty: 21, skipped: 3, stop_slots: 13, summary: '13 of 29 launches went to 2 job kinds that merged nothing' });
    expect(report.stop_first).toEqual([
      { family: 'one-test filler md', slots: 7, merged: 0, reason: '0 merged from 7 launches, 7 empty, 3 skipped before launch' },
      { family: 'RQ-PHX-RECUTCORE', slots: 6, merged: 0, reason: '0 merged from 6 launches, 6 empty' }]);
  });

  it('names at most five kinds to stop, most slots first, and says "rarely merge" when one of them merged', () => {
    const lines = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((letter, n) => Array.from({ length: 6 + n }, (_, i) => empty(`RQ-BAD${letter}-${i + 1}`)).flat());
    // The one merge is older than the family's last 3 launches, so it does not keep the kind live.
    lines.push(...merged('RQ-BADF-99').map(line => line.replace(at(2), at(3))));
    const report = jobYield(lines, now, 24);
    expect(report.families.filter(f => f.verdict === 'stop')).toHaveLength(6);
    expect(report.stop_first.map(s => [s.family, s.slots])).toEqual([['RQ-BADF', 12], ['RQ-BADE', 10], ['RQ-BADD', 9], ['RQ-BADC', 8], ['RQ-BADB', 7]]);
    expect(report.summary).toBe('52 of 52 launches went to 6 job kinds that rarely merge');
  });

  it('does not tell a kind to stop while its launches are still running', () => {
    const lines = Array.from({ length: 6 }, (_, i) => launch(`RQ-FRESH-${i + 1}`));
    expect(family(lines, 'RQ-FRESH')).toMatchObject({ launches: 6, running: 6, verdict: 'watch', reason: '0 merged from 6 launches, 6 still running' });
    expect(jobYield(lines, now, 24).summary).toBe('6 launches, 0 merged; no job kind to stop');
  });

  it('shows a kind that was only ever skipped as unknown yield, and ignores rows outside the window', () => {
    const lines = [skip('RQ-LOCUS2A111723Q8', 'locus'), ...empty('RQ-OLD-1').map(line => line.replace(at(2), at(30))),
      row({ event: 'precheck_skip', job: 'RQ-LOCUS3A111724Q8', repo: 'locus', ts: at(30) }), row({ event: 'precheck_skip', job: 'RQ-LOCUS4A111725Q8', repo: 'locus' })];
    expect(jobYield(lines, now, 24).families).toEqual([{ family: 'one-test filler locus', launches: 0, running: 0, empty: 0, skipped: 1, prs: 0, merged: 0, reverted: 0,
      merged_per_launch: null, verdict: 'watch', reason: '0 merged from 0 launches, 1 skipped before launch' }]);
  });

  it('counts a merge recorded as reverted as reverted, never as a held merge', () => {
    const revertedMerge = (job: string, evidence: Record<string, unknown>) => [...merged(job), row({ job, ts: at(0.4), ...evidence })];
    const lines = [
      ...revertedMerge('RQ-DOCS-FIX-1', { event: 'revert' }),
      ...revertedMerge('RQ-DOCS-FIX-2', { reverted: true }),
      ...revertedMerge('RQ-DOCS-FIX-3', { reverted_at: '2026-11-17T23:00:00Z' }),
      ...revertedMerge('RQ-DOCS-FIX-4', { event: 'outcome', state: 'REVERTED' }),
      ...merged('RQ-DOCS-FIX-5'),
      // Explicit reverted:false is not evidence; the merge still holds.
      ...[...merged('RQ-DOCS-FIX-6'), row({ job: 'RQ-DOCS-FIX-6', reverted: false, ts: at(0.4) })],
    ];
    const report = jobYield(lines, now, 24);
    expect(report).toMatchObject({ launches: 6, merged: 2, reverted: 4 });
    expect(report.families).toEqual([{ family: 'RQ-DOCS-FIX', launches: 6, running: 0, empty: 0, skipped: 0, prs: 6, merged: 2, reverted: 4,
      merged_per_launch: 2 / 6, verdict: 'keep', reason: '2 merged from 6 launches, 4 reverted' }]);
  });

  it('lets a kind whose merges all reverted reach a stop verdict', () => {
    const lines = Array.from({ length: 6 }, (_, i) => [...merged(`RQ-BADREVERT-${i + 1}`), row({ job: `RQ-BADREVERT-${i + 1}`, event: 'revert', ts: at(0.4) })]).flat();
    const report = jobYield(lines, now, 24);
    expect(report.families[0]).toMatchObject({ family: 'RQ-BADREVERT', launches: 6, merged: 0, reverted: 6, merged_per_launch: 0, verdict: 'stop',
      reason: '0 merged from 6 launches, 6 reverted' });
    expect(report).toMatchObject({ merged: 0, reverted: 6, stop_slots: 6 });
    expect(report.stop_first).toEqual([{ family: 'RQ-BADREVERT', slots: 6, merged: 0, reason: '0 merged from 6 launches, 6 reverted' }]);
    expect(report.summary).toBe('6 of 6 launches went to 1 job kind that merged nothing');
  });

  it('keeps revert evidence for a job whose rows arrive before its launch', () => {
    const lines = [row({ job: 'RQ-EARLYREV-1', event: 'revert', ts: at(3) }), ...merged('RQ-EARLYREV-1')];
    expect(jobYield(lines, now, 24).families[0]).toMatchObject({ launches: 1, merged: 0, reverted: 1 });
  });

  it('counts terminal rows from the metrics-outcomes reconciler as merges', () => {
    // The reconciler copies each PUBLISHED row into a terminal row without an
    // event:"outcome" marker: it keeps the publish row's fields and adds the
    // reconciler source. Both publish dialects must count.
    const recon = (fields: Record<string, unknown>) => row({ ts: at(0.5), reconciledAt: at(0.5), source: 'metrics-outcomes-reconciler', ...fields });
    const lines = [
      // Dialect one: the copy keeps event:"publish" plus job/url.
      launch('RQ-RECONCILEA-1'), finish('RQ-RECONCILEA-1', false), pr('RQ-RECONCILEA-1'),
      recon({ event: 'publish', job: 'RQ-RECONCILEA-1', url: 'https://example.invalid/pr/a', outcome: 'MERGED', mergedAt: at(0.5) }),
      // Dialect two: no event at all; the job is jobId and the PR is prUrl. Its
      // own PUBLISHED row is event-less too and must not count as a merge.
      launch('RQ-RECONCILEB-1'), finish('RQ-RECONCILEB-1', false),
      row({ outcome: 'PUBLISHED', jobId: 'RQ-RECONCILEB-1', prUrl: 'https://example.invalid/pr/b', ts: at(1) }),
      recon({ outcome: 'MERGED', jobId: 'RQ-RECONCILEB-1', prUrl: 'https://example.invalid/pr/b', mergedAt: at(0.5) }),
      // The status field carries the terminal state when the publish row had no outcome key.
      launch('RQ-RECONCILEC-1'), finish('RQ-RECONCILEC-1', false),
      recon({ status: 'CLOSED', jobId: 'RQ-RECONCILEC-1', prUrl: 'https://example.invalid/pr/c' }),
    ];
    const report = jobYield(lines, now, 24);
    expect(report).toMatchObject({ launches: 3, merged: 2, reverted: 0 });
    expect(report.families.find(f => f.family === 'RQ-RECONCILEA')).toMatchObject({ merged: 1, merged_per_launch: 1, verdict: 'keep' });
    expect(report.families.find(f => f.family === 'RQ-RECONCILEB')).toMatchObject({ merged: 1, merged_per_launch: 1, verdict: 'keep' });
    expect(report.families.find(f => f.family === 'RQ-RECONCILEC')).toMatchObject({ merged: 0, merged_per_launch: 0, verdict: 'watch' });
  });
});

describe('phm jobs yield', () => {
  const dirs: string[] = [];
  beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now); });
  afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
  const ledger = (lines: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-yield-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'jobs.jsonl'), lines.join('\n'));
    return join(dir, 'jobs.jsonl');
  };

  it('prints the summary, the kinds to stop first and every kind', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobs(['yield', '--metrics', ledger([...allMerge, ...allEmptyRecut]), '--since', '1d'], undefined)).toBe(0);
    expect(out.mock.calls).toEqual([[[
      '6 of 10 launches went to 1 job kind that merged nothing',
      'Stop first:',
      '  1. RQ-PHX-RECUTCORE: 6 slots, 0 merged',
      'Job kinds:',
      '  stop  RQ-PHX-RECUTCORE: 0 merged from 6 launches, 6 empty; merged per launch 0.00',
      '  keep  RQ-DOCS-FIX: 4 merged from 4 launches; merged per launch 1.00',
    ].join('\n')]]);
  });

  it('prints jobs.yield.v1 JSON from a file read through the real reader', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobsYield(['--json', '--metrics', ledger(fillerWithSkips)], undefined, now)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toMatchObject({ schema: 'jobs.yield.v1', version: 1, known: true, launches: 7, skipped: 3,
      stop_first: [{ family: 'one-test filler md', slots: 7 }] });
  });

  it('prints only the stop prefix through the jobs CLI, excluding keep and watch kinds', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobs(['yield', '--stop-list', '--metrics', ledger([...allMerge, ...allEmptyRecut, ...mixed]), '--since', '1d'])).toBe(0);
    expect(out.mock.calls).toEqual([['RQ-PHX-RECUTCORE']]);
  });

  it('lists every stop kind in report order, including filler and kinds beyond the top five', async () => {
    const lines = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap(letter => Array.from({ length: 6 }, (_, i) => empty(`RQ-BAD${letter}-${i + 1}`)).flat());
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobsYield(['--metrics', ledger([...lines, ...fillerWithSkips]), '--stop-list'], undefined, now)).toBe(0);
    expect(out.mock.calls).toEqual([['one-test filler md\nRQ-BADA\nRQ-BADB\nRQ-BADC\nRQ-BADD\nRQ-BADE\nRQ-BADF']]);
  });

  it.each([{ lines: [] }, { lines: allMerge }, { lines: mixed }])('prints nothing when no kind should stop (%#)', async ({ lines }) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobsYield(['--stop-list', '--metrics', ledger(lines)], undefined, now)).toBe(0);
    expect(out).not.toHaveBeenCalled();
  });

  it.each([['--stop-list', '--json'], ['--json', '--stop-list']])('keeps the full versioned JSON unchanged with %s %s', async (...flags) => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const metrics = ledger([...allMerge, ...allEmptyRecut, ...mixed]);
    expect(await cmdJobsYield(['--json', '--metrics', metrics], undefined, now)).toBe(0);
    expect(await cmdJobsYield([...flags, '--metrics', metrics], undefined, now)).toBe(0);
    expect(out.mock.calls[1]).toEqual(out.mock.calls[0]);
    expect(JSON.parse(String(out.mock.calls[1]![0]))).toMatchObject({ schema: 'jobs.yield.v1', version: 1,
      families: [{ verdict: 'stop' }, { verdict: 'watch' }, { verdict: 'keep' }] });
  });

  it('keeps unknown reads out of the stop list and preserves unknown JSON', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const args = ['--stop-list', '--metrics', ledger([])];
    const read = async () => false;
    expect(await cmdJobsYield(args, read, now)).toBe(1);
    expect(out).not.toHaveBeenCalled();
    expect(err.mock.calls).toEqual([['Job yield: unknown (job metrics file unreadable)']]);
    expect(await cmdJobsYield([...args, '--json'], read, now)).toBe(0);
    expect(JSON.parse(String(out.mock.calls[0]![0]))).toEqual(unknownJobYield(24));
  });

  it('shows an unreadable or interrupted read as unknown, never zero', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdJobsYield(['--metrics', join(tmpdir(), 'jobs-yield-missing', 'jobs.jsonl')], undefined, now)).toBe(0);
    expect(out.mock.calls).toEqual([['Job yield: unknown (job metrics file unreadable)']]);
    for (const throws of [false, true]) {
      const report = await readJobYield('/unreadable', 24, now, async (_, onLine) => {
        for (const line of allEmptyRecut) onLine(line);
        if (throws) throw new Error('unreadable');
        return false;
      });
      expect(report).toEqual(unknownJobYield(24));
      expect(report).toMatchObject({ known: false, launches: null, stop_slots: null, families: [], stop_first: [] });
    }
    expect(jobYieldLines(unknownJobYield(24))).toEqual(['Job yield: unknown (job metrics file unreadable)']);
  });

  it('prints help and rejects bad arguments', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdJobsYield(['--help'])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toContain('jobs.yield.v1');
    expect(String(out.mock.calls[0]![0])).toContain('Run phm jobs yield --stop-list to print only the job kinds to stop, one per line.');
    expect(String(out.mock.calls[0]![0])).toContain('With --json, the full report is unchanged, even with --stop-list.');
    for (const args of [['--since', '0h'], ['--since', 'soon'], ['--since'], ['--metrics'], ['--json', '--json'], ['--stop-list', '--stop-list'], ['--nope']]) expect(await cmdJobsYield(args)).toBe(2);
    expect(err).toHaveBeenCalledTimes(7);
  });

  it('serves the same report to the Metrics view', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jobs-yield-panel-'));
    dirs.push(dir);
    expect((await readMetricsPanel(dir, now)).jobYield).toEqual(unknownJobYield(24));
  });
});
