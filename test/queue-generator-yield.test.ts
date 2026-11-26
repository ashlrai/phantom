import { describe, expect, it, vi } from 'vitest';
import { cmdQueueYield } from '../src/cli/queue-yield.js';
import { generatorYield, readGeneratorYield } from '../src/core/queue/generator-yield.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = Date.parse('2026-11-09T12:00:00Z');
const row = (fields: object) => JSON.stringify({ ts: '2026-11-09T10:00:00Z', ...fields });
describe('generator yield', () => {
  it('joins events, groups generators, and counts malformed lines', () => {
    const report = generatorYield([
      row({ job: 'RQ-FOOA123Q8', event: 'launch' }),
      row({ job: 'RQ-FOOA123Q8', event: 'finish', empty: false, tokens_total: 100, diff_lines: 10 }),
      row({ job: 'RQ-FOOA123Q8', event: 'outcome', state: 'MERGED' }),
      row({ job: 'RQ-WORKN9SQ8', event: 'finish', empty: true, tokens_total: 20 }),
      row({ job: 'FIXUP-X', src: 'custom', event: 'finish', empty: false, tokens_total: 30 }),
      row({ job: 'OTHER', event: 'launch' }), '{broken',
    ].join('\n'), 24, now);
    expect(report.malformedLines).toBe(1);
    expect(report.generators).toEqual([
      { generator: 'custom', jobs: 1, prs: 0, merged: 0, drafted: 0, rejected: 0, launched: 0, rejections: {}, emptyRate: 0, medianDiffLines: null, tokensPerMergedPr: null },
      { generator: 'filler', jobs: 1, prs: 1, merged: 1, drafted: 0, rejected: 0, launched: 1, rejections: {}, emptyRate: 0, medianDiffLines: 10, tokensPerMergedPr: 100 },
      { generator: 'leader', jobs: 1, prs: 0, merged: 0, drafted: 0, rejected: 0, launched: 0, rejections: {}, emptyRate: 1, medianDiffLines: null, tokensPerMergedPr: null },
      { generator: 'unknown', jobs: 1, prs: 0, merged: 0, drafted: 0, rejected: 0, launched: 1, rejections: {}, emptyRate: null, medianDiffLines: null, tokensPerMergedPr: null },
    ]);
  });
  it('does not invent token totals and excludes events outside the window', () => {
    const report = generatorYield([row({ job: 'RQ-DRAIN-1', state: 'MERGED' }), row({ job: 'RQ-DRAIN-2', empty: true }), JSON.stringify({ job: 'OLD', ts: '2026-11-01T00:00:00Z' })].join('\n'), 24, now);
    expect(report.generators).toMatchObject([{ generator: 'drain', jobs: 2, merged: 1, tokensPerMergedPr: null }]);
  });
  it('uses the newest recorded measurements when older receipts are appended late', () => {
    const job = 'RQ-DRAIN-1';
    const report = generatorYield([
      row({ job, event: 'finish', ts: '2026-11-09T10:30:00Z', empty: false, tokens_total: 100, diff_lines: 10 }),
      row({ job, state: 'MERGED', ts: '2026-11-09T11:00:00Z' }),
      row({ job, event: 'finish', empty: true, tokens_total: 20, diff_lines: 0 }),
    ].join('\n'), 24, now);
    expect(report.generators).toMatchObject([
      { generator: 'drain', jobs: 1, merged: 1, emptyRate: 0, medianDiffLines: 10, tokensPerMergedPr: 100 },
    ]);
  });
  it('reads the jobs-ledger field dialect', () => {
    const report = generatorYield([
      JSON.stringify({ job_id: 'RQ-FOOA9Q8', type: 'finish', timestamp: '2026-11-09T10:00:00Z', result: 'empty', pr_url: 'https://github.com/x/y/pull/1' }),
      JSON.stringify({ id: 'RQ-FOOA9Q8', kind: 'outcome', status: 'MERGED', at: '2026-11-09T10:05:00Z', html_url: 'https://github.com/x/y/pull/1' }),
    ].join('\n'), 24, now);
    expect(report.generators).toEqual([
      { generator: 'filler', jobs: 1, prs: 1, merged: 1, drafted: 0, rejected: 0, launched: 0, rejections: {}, emptyRate: 1, medianDiffLines: null, tokensPerMergedPr: null },
    ]);
  });
  it('counts each decision once per source without crediting a duplicate generator for another source PR', () => {
    const decisions = [
      row({ job: 'RQ-X', src: 'ideas', event: 'drafted' }),
      row({ job: 'RQ-X', src: 'bets', event: 'rejected', reason: 'duplicate' }),
      row({ job: 'RQ-DONE', src: 'bets', event: 'rejected', reason: 'already_completed' }),
      row({ job: 'RQ-OLD', src: 'bets', event: 'drafted', ts: '2026-11-01T00:00:00Z' }),
    ];
    const report = generatorYield([
      row({ job: 'RQ-X', event: 'launch' }), row({ job: 'RQ-X', pr: 'https://github.com/x/y/pull/1', tokens: 12 }),
    ].join('\n'), 24, now, [...decisions, ...decisions].join('\n'));
    expect(report.generators).toMatchObject([
      { generator: 'bets', drafted: 0, rejected: 2, launched: 0, jobs: 0, prs: 0, rejections: { duplicate: 1, already_completed: 1 } },
      { generator: 'ideas', drafted: 1, rejected: 0, launched: 1, jobs: 1, prs: 1 },
    ]);
  });
  it.each([
    { src: undefined, attributed: 'unknown' },
    { src: 'ideas', attributed: 'ideas' },
  ])('attributes competing drafts to $attributed using the job evidence', ({ src, attributed }) => {
    const job = 'RQ-FOOA123Q8';
    const jobs = [row({ job, src, event: 'launch' }), row({ job, state: 'MERGED' })].join('\n');
    const drafts = ['ideas', 'ideas', 'bets'].map(source => row({ job, src: source, event: 'drafted' }));

    for (const decisions of [drafts, [...drafts].reverse()]) {
      const { generators } = generatorYield(jobs, 24, now, decisions.join('\n'));
      expect(generators.filter(group => group.drafted > 0).map(group => [group.generator, group.drafted]))
        .toEqual([['bets', 1], ['ideas', 1]]);
      expect(generators.filter(group => group.jobs > 0)).toMatchObject([
        { generator: attributed, jobs: 1, launched: 1, prs: 1, merged: 1 },
      ]);
    }
  });
  it.each([
    { unreadable: 'jobs.jsonl', readable: 'generation.jsonl', event: 'drafted', jobsKnown: false, generationKnown: true },
    { unreadable: 'generation.jsonl', readable: 'jobs.jsonl', event: 'launch', jobsKnown: true, generationKnown: false },
  ])('retains readable evidence when $unreadable cannot be read', async ({ unreadable, readable, event, jobsKnown, generationKnown }) => {
    const dir = await mkdtemp(join(tmpdir(), 'generator-yield-'));
    try {
      const metrics = join(dir, 'metrics');
      await mkdir(metrics);
      await mkdir(join(metrics, unreadable));
      await writeFile(join(metrics, readable), row({ job: 'RQ-X', src: 'ideas', event }));
      expect(await readGeneratorYield(dir, 24, now)).toMatchObject({
        known: true,
        jobsKnown,
        generationKnown,
        generators: [{ generator: 'ideas', drafted: generationKnown ? 1 : 0, launched: jobsKnown ? 1 : 0 }],
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reads generation-only ledgers and distinguishes missing evidence', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'generation-'));
    try {
      expect(await readGeneratorYield(dir, 24, now)).toMatchObject({ known: false, generationKnown: false });
      await mkdir(join(dir, 'metrics'));
      await writeFile(join(dir, 'metrics/generation.jsonl'), row({ job: 'RQ-X', src: 'ideas', event: 'drafted' }));
      expect(await readGeneratorYield(dir, 24, now)).toMatchObject({ known: true, generationKnown: true, generators: [{ generator: 'ideas', drafted: 1, launched: 0, prs: 0 }] });
      await writeFile(join(dir, 'metrics/generation.jsonl'), row({ job: 'RQ-X', src: 'ideas', event: 'drafted', ts: new Date().toISOString() }));
      vi.stubEnv('ASHLR_RUNS_DIR', dir);
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(await cmdQueueYield(['--json'])).toBe(0);
      expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ jobsKnown: false, generationKnown: true, generators: [{ generator: 'ideas', drafted: 1 }] });
      expect(await cmdQueueYield([])).toBe(0);
      expect(log.mock.calls.flat().join('\n')).toContain('Generator\tDrafted\tRejected\tLaunched');
    } finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); }
  });
});
