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
  it('excludes dispatcher no-ops from execution measures while retaining generator decisions', () => {
    const job = 'RQ-DRAIN-1';
    const skipped = 'RQ-DRAIN-2';
    const report = generatorYield([
      row({ job, event: 'launch' }),
      row({ job, event: 'finish', empty: false, tokens_total: 100, diff_lines: 8 }),
      row({ job, event: 'publish', state: 'MERGED' }),
      row({ job: skipped, event: 'outcome', state: 'DONE-NOOP', launched: false, reason: 'already_completed' }),
      row({ job, event: 'outcome', state: 'DONE-NOOP', launched: false, src: 'other', empty: true }),
    ].join('\n'), 24, now, [
      row({ job, event: 'drafted', src: 'drain' }),
      row({ job: skipped, event: 'drafted', src: 'drain' }),
    ].join('\n'));
    expect(report.generators).toMatchObject([
      { generator: 'drain', jobs: 1, drafted: 2, launched: 1, prs: 1, merged: 1,
        emptyRate: 0, medianDiffLines: 8, tokensPerMergedPr: 100 },
    ]);
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
  it.each(['launch', 'batch_claim'])('uses only current-attempt empty evidence after a %s', (event) => {
    const job = 'FIXUP-X';
    const firstFinish = row({ job, event: 'finish', empty: true });
    const dispatch = row({ job, event, batch: 'RQ-BATCH-X' });
    const receipts = [firstFinish, dispatch, firstFinish];
    const report = (rows: string[]) => generatorYield(rows.join('\n'), 24, now).generators;

    expect(report(receipts)).toMatchObject([{ generator: 'fixup', jobs: 1, emptyRate: null }]);
    expect(report([...receipts, row({ job, event: 'finish', empty: false }), dispatch]))
      .toMatchObject([{ generator: 'fixup', jobs: 1, emptyRate: 0 }]);
  });
  it('keeps reserialized receipt replays from replacing newer evidence at the same timestamp', () => {
    const job = 'RQ-DRAIN-1';
    const finish = row({ job, event: 'finish', src: 'old', empty: true, tokens_total: 20, diff_lines: 0 });
    const reordered = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(finish)).reverse()))
      .replace(/^{/, '{ ');
    const report = generatorYield([
      finish,
      row({ job, event: 'finish', src: 'drain', empty: false, tokens_total: 100, diff_lines: 8 }),
      reordered,
      row({ job, state: 'MERGED' }),
    ].join('\n'), 24, now);
    expect(report.generators).toMatchObject([
      { generator: 'drain', jobs: 1, merged: 1, emptyRate: 0, medianDiffLines: 8, tokensPerMergedPr: 100 },
    ]);
  });
  it('uses terminal timestamps to place reconciled receipts in the report window', () => {
    const report = generatorYield([
      row({ job: 'RQ-DRAIN-1', event: 'publish', outcome: 'MERGED',
        mergedAt: '2026-11-09T12:01:00Z' }),
      row({ job: 'FIXUP-1', event: 'publish', outcome: 'MERGED',
        ts: '2026-11-08T11:59:00Z', mergedAt: '2026-11-08T12:00:00Z' }),
      row({ job: 'RQ-DRAIN-2', event: 'publish', outcome: 'CLOSED',
        closedAt: '2026-11-09T12:01:00Z', prUrl: 'https://github.com/x/y/pull/2' }),
      row({ job: 'FIXUP-2', event: 'merged', mergedAt: 'invalid' }),
    ].join('\n'), 24, now);
    expect(report.malformedLines).toBe(0);
    expect(report.generators).toMatchObject([
      { generator: 'fixup', jobs: 2, prs: 2, merged: 2 },
    ]);
  });
  it('uses terminal fields ahead of nonterminal aliases and event names', () => {
    const report = generatorYield([
      row({ job: 'FIXUP-1', state: 'PUBLISHED', outcome: ' merged ', event: 'publish',
        ts: '2026-11-08T11:59:00Z', mergedAt: '2026-11-09T11:00:00Z', tokens_total: 20 }),
      row({ job: 'FIXUP-2', state: 'unknown', phase: 'MERGED', event: 'publish',
        mergedAt: '2026-11-09T12:01:00Z' }),
      row({ job: 'FIXUP-3', status: 'unknown', conclusion: 'CLOSED', event: 'merged',
        mergedAt: '2026-11-09T12:01:00Z', closedAt: '2026-11-09T11:00:00Z',
        prUrl: 'https://github.com/x/y/pull/3', tokens_total: 10 }),
    ].join('\n'), 24, now);
    expect(report.generators).toMatchObject([
      { generator: 'fixup', jobs: 2, prs: 2, merged: 1, tokensPerMergedPr: 30 },
    ]);
  });
  it('uses the first parseable ledger timestamp for jobs and generation decisions', () => {
    const job = 'RQ-X';
    const report = generatorYield([
      row({ job, event: 'launch', ts: 'invalid', timestamp: '2026-11-09 05:00:00-0500' }),
      row({ job, outcome: 'MERGED', mergedAt: 'invalid', ts: 'invalid', at: '2026-11-09T11:00:00Z' }),
      row({ job: 'FIXUP-Y', event: 'launch', ts: 'invalid', timestamp: 'invalid' }),
      row({ job: 'FIXUP-Z', event: 'launch', ts: '2026-11-09T12:01:00Z', timestamp: '2026-11-09T11:00:00Z' }),
    ].join('\n'), 24, now, row({ job, src: 'ideas', event: 'drafted', ts: 'invalid', recordedAt: '2026-11-09T09:00:00Z' }));
    expect(report.malformedLines).toBe(1);
    expect(report.generators).toMatchObject([
      { generator: 'ideas', jobs: 1, drafted: 1, launched: 1, prs: 1, merged: 1 },
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
  it('counts canonical PR links across aliases and retains explicit merge evidence', () => {
    const report = generatorYield([
      row({ job: 'FIXUP-ISSUE', url: 'https://github.com/x/y/issues/1' }),
      row({ job: 'FIXUP-RUN', html_url: 'https://github.com/x/y/actions/runs/2' }),
      row({ job: 'FIXUP-PLACEHOLDER', pr: 'unknown' }),
      row({ job: 'FIXUP-INVALID', prUrl: 'https://github.com/x/y/pull/0' }),
      row({ job: 'FIXUP-PR', pr: 'unknown', html_url: 'https://github.com/x/y/pull/3' }),
      row({ job: 'FIXUP-MERGED', state: 'MERGED' }),
    ].join('\n'), 24, now);
    expect(report.generators).toMatchObject([
      { generator: 'fixup', jobs: 6, prs: 2, merged: 1 },
    ]);
  });
  it('counts launched batch members once and excludes worker telemetry from generator totals', () => {
    const batch = 'RQ-BATCH-X';
    const member = 'RQ-FOOA123Q8';
    const report = generatorYield([
      row({ job: batch, event: 'launch', src: 'filler' }),
      row({ job: member, event: 'batch_claim', batch }),
      row({ job: member, event: 'batch_claim', batch }),
      row({ job: 'RQ-DRAIN-1', event: 'batch_claim', batch }),
      row({ job: 'RQ-DRAIN-2', event: 'batch_claim', batch: 'RQ-BATCH-UNLAUNCHED' }),
      row({ job: batch, event: 'finish', src: 'filler', empty: true, tokens_total: 500, diff_lines: 100 }),
      row({ job: member, state: 'MERGED', empty: false, tokens_total: 20, diff_lines: 6 }),
      row({ job: 'RQ-DRAIN-1:1', jobId: 'RQ-DRAIN-1', schema: 'fleet.session-pool.v1', event: 'launch' }),
      row({ job: 'RQ-DRAIN-2:1', jobId: 'RQ-DRAIN-2', schema: 'phm-node-runner.v1', event: 'launch' }),
    ].join('\n'), 24, now);
    expect(report.generators).toMatchObject([
      { generator: 'drain', jobs: 2, launched: 1, prs: 0 },
      { generator: 'filler', jobs: 1, launched: 1, merged: 1, emptyRate: 0, medianDiffLines: 6, tokensPerMergedPr: 20 },
    ]);
  });
  it('credits only claims with a worker launch at or after the claim timestamp', () => {
    const batch = 'RQ-BATCH-X';
    const report = generatorYield([
      row({ job: batch, event: 'launch', ts: '2026-11-09T10:30:00Z' }),
      row({ job: 'RQ-DRAIN-1', event: 'batch_claim', batch, ts: '2026-11-09T11:00:00Z' }),
      row({ job: 'FIXUP-X', event: 'batch_claim', batch, ts: '2026-11-09T11:00:00Z' }),
      row({ job: batch, event: 'launch', ts: '2026-11-09T09:30:00Z' }),
      row({ job: 'FIXUP-X', event: 'batch_claim', batch }),
    ].join('\n'), 24, now);
    expect(report.generators).toMatchObject([
      { generator: 'drain', jobs: 1, launched: 0 },
      { generator: 'fixup', jobs: 1, launched: 1 },
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
  it('keeps unknown sources out of job attribution while counting their decisions', () => {
    const explicit = 'RQ-DRAIN-EXPLICIT';
    const drafted = 'RQ-DRAIN-DRAFTED';
    const inferred = 'RQ-DRAIN-INFERRED';
    const report = generatorYield([
      row({ job: explicit, event: 'launch', src: 'bets' }),
      row({ job: explicit, state: 'MERGED', src: ' UnKnOwN ' }),
      row({ job: drafted, event: 'launch', src: 'unknown' }),
      row({ job: drafted, state: 'MERGED' }),
      row({ job: inferred, event: 'launch', src: 'UNKNOWN' }),
    ].join('\n'), 24, now, [
      row({ job: explicit, event: 'drafted', src: 'ideas' }),
      row({ job: drafted, event: 'drafted', src: 'ideas' }),
      row({ job: drafted, event: 'drafted', src: 'UNKNOWN' }),
      row({ job: inferred, event: 'drafted' }),
      row({ job: inferred, event: 'rejected', src: ' Unknown ', reason: 'duplicate' }),
    ].join('\n'));

    expect(report.generators).toMatchObject([
      { generator: 'bets', jobs: 1, launched: 1, merged: 1, drafted: 0 },
      { generator: 'drain', jobs: 1, launched: 1, merged: 0, drafted: 0 },
      { generator: 'ideas', jobs: 1, launched: 1, merged: 1, drafted: 2 },
      { generator: 'unknown', jobs: 0, launched: 0, drafted: 2, rejected: 1 },
    ]);
  });
  it('takes lifecycle and generation evidence only from their respective journals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'generator-yield-'));
    try {
      const metrics = join(dir, 'metrics');
      await mkdir(metrics);
      await Promise.all([
        writeFile(join(metrics, 'jobs.jsonl'), [
          row({ job: 'FIXUP-X', event: 'launch' }),
          row({ job: 'FIXUP-X', event: 'drafted', src: 'bets' }),
        ].join('\n')),
        writeFile(join(metrics, 'generation.jsonl'), [
          row({ job: 'FIXUP-X', event: 'drafted', src: 'ideas', state: 'MERGED',
            mergedAt: '2026-11-09T12:01:00Z' }),
          row({ job: 'FIXUP-X', event: 'merged' }),
          row({ job: 'FIXUP-Y', event: 'launch' }),
        ].join('\n')),
      ]);
      expect(await readGeneratorYield(dir, 24, now)).toMatchObject({
        jobsKnown: true,
        generationKnown: true,
        generators: [{ generator: 'ideas', jobs: 1, drafted: 1, launched: 1, prs: 0, merged: 0 }],
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
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
