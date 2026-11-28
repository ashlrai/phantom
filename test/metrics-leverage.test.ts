import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildLeverageReport, classifyMerge, isTestPath, parseLeverageSources,
  readLeverageInputs, readLeverageReport,
} from '../src/core/metrics/leverage-class.js';
import { cmdMetrics } from '../src/cli/metrics.js';

const fixtures = [
  { name: 'fleet by job id', facts: { jobId: 'RQ-DVL-FLEET-12' }, expected: 'fleet' },
  { name: 'fleet by title', facts: { title: 'router: pick the cheaper pool' }, expected: 'fleet' },
  { name: 'fleet by path', facts: { paths: ['src/core/queue/claim.ts', 'test/claim.test.ts'] }, expected: 'fleet' },
  { name: 'product by job id', facts: { jobId: 'RQ-DESKTOP-TILE' }, expected: 'product' },
  { name: 'product by path', facts: { paths: ['src/web-ui/routes/show/ShowView.tsx'] }, expected: 'product' },
  { name: 'docs by paths', facts: { paths: ['docs/CLI-REFERENCE.md', 'README.md'] }, expected: 'docs' },
  { name: 'docs beats fleet words', facts: { jobId: 'RQ-DVL-FLEET-3', paths: ['docs/fleet.md'] }, expected: 'docs' },
  { name: 'filler: one test', facts: { jobId: 'RQ-ONE', paths: ['test/one.test.ts'] }, expected: 'filler' },
  { name: 'filler: link check', facts: { title: 'link check for docs' }, expected: 'filler' },
  { name: 'unknown: nothing to go on', facts: {}, expected: 'unknown' },
  { name: 'unknown: unrelated words and paths', facts: { jobId: 'RQ-ODD', paths: ['lib/x.ts'] }, expected: 'unknown' },
] as const;

describe('classifyMerge', () => {
  for (const f of fixtures) it(f.name, () => expect(classifyMerge(f.facts)).toBe(f.expected));
});

describe('buildLeverageReport', () => {
  const now = Date.parse('2026-11-18T12:00:00Z');
  const row = (job: string, minutesAgo: number, n: number) => JSON.stringify({ event: 'outcome', state: 'MERGED', job, ts: new Date(now - minutesAgo * 60_000).toISOString(), url: `https://github.com/ashlrai/phantom/pull/${n}` });

  it('counts per class per hour and the fleet plus product share, unknowns included', () => {
    const jobs = [row('RQ-DVL-FLEET-1', 10, 1), row('RQ-DESKTOP-A', 20, 2), row('RQ-ODD', 30, 3), row('RQ-ODD2', 70, 4), row('RQ-OLD', 60 * 30, 5)].join('\n');
    const report = buildLeverageReport(jobs, null, now, 24);
    expect(report.schema).toBe('metrics.leverage.v1');
    expect(report.total).toBe(4);
    expect(report.totals).toEqual({ fleet: 1, product: 1, docs: 0, filler: 0, unknown: 2 });
    expect(report.leverageShare).toBe(0.5);
    expect(report.perHour).toHaveLength(24);
    expect(report.perHour![23]!.counts).toEqual({ fleet: 1, product: 1, docs: 0, filler: 0, unknown: 1 });
    expect(report.perHour![22]!.counts.unknown).toBe(1);
  });
  it('reads titles and paths from a PR export', () => {
    const prs = JSON.stringify([{ url: 'https://github.com/ashlrai/phantom/pull/1', mergedAt: '2026-11-18T11:50:00Z', title: 'add a test', files: ['test/a.test.ts'] }]);
    const report = buildLeverageReport(row('RQ-ODD', 10, 1), prs, now, 24);
    expect(report.totals!.filler).toBe(1);
  });
  it('is unknown, not zero, with no ledger, and null share with no merges', () => {
    const none = buildLeverageReport(null, null, now);
    expect(none).toMatchObject({ known: false, total: null, totals: null, leverageShare: null, perHour: null });
    expect(buildLeverageReport('', null, now).leverageShare).toBeNull();
  });
  it('reports jobsTruncated only for a bounded tail read', () => {
    const jobs = row('RQ-DVL-FLEET-1', 10, 1);
    expect(buildLeverageReport(jobs, null, now).sources.jobsTruncated).toBe(false);
    expect(buildLeverageReport({ text: jobs, truncated: true }, null, now).sources).toMatchObject({ jobs: 'available', jobsTruncated: true });
    expect(buildLeverageReport(null, null, now).sources.jobsTruncated).toBe(false);
  });
});

describe('readLeverageReport', () => {
  it('reads the newest bounded tail of an oversized jobs ledger', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leverage-tail-'));
    mkdirSync(join(dir, 'metrics'));
    // Append-only ledger larger than the 16 MiB tail window: the head sentinel
    // must fall outside the window and the newest outcome row must still fold.
    const limit = 16 * 1024 * 1024;
    const now = Date.now();
    const recent = JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'RQ-DVL-FLEET-TAIL', ts: new Date(now - 60_000).toISOString(), url: 'https://github.com/ashlrai/phantom/pull/901' });
    writeFileSync(join(dir, 'metrics', 'jobs.jsonl'), 'HEAD-SENTINEL\n' + 'A'.repeat(limit) + '\n' + recent + '\n');
    const report = await readLeverageReport({ runsDir: dir, now });
    expect(report.sources).toMatchObject({ jobs: 'available', jobsTruncated: true });
    expect(report.total).toBe(1);
    expect(report.totals!.fleet).toBe(1);
    // A small ledger reads whole and reports no truncation.
    const small = mkdtempSync(join(tmpdir(), 'leverage-small-'));
    mkdirSync(join(small, 'metrics'));
    writeFileSync(join(small, 'metrics', 'jobs.jsonl'), recent + '\n');
    const whole = await readLeverageReport({ runsDir: small, now });
    expect(whole.sources.jobsTruncated).toBe(false);
    expect(whole.total).toBe(1);
  });
});

describe('phm metrics leverage', () => {
  it('prints typed JSON with a schema id and rejects bad flags', async () => {
    const out: string[] = [];
    expect(await cmdMetrics(['leverage', '--json', '--hours', '6'], { out: s => out.push(s), err: s => out.push(s) })).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.schema).toBe('metrics.leverage.v1');
    expect(parsed.hours).toBe(6);
    expect(parsed.sources.jobsTruncated).toBe(false);
    expect(await cmdMetrics(['leverage', '--hours', '0'], { out: () => {}, err: () => {} })).toBe(2);
    expect(await cmdMetrics(['leverage', '--bad', 'x'], { out: () => {}, err: () => {} })).toBe(2);
    expect(await cmdMetrics(['leverage-mix', '--prs', 'a.json', '--prs', 'b.json'], { out: () => {}, err: () => {} })).toBe(2);
  });

  it('shares test-path detection, bounded input reads, and source parsing across leverage reports', async () => {
    expect(isTestPath('test/unit.test.ts')).toBe(true);
    expect(isTestPath('src/core/metrics/leverage-class.ts')).toBe(false);
    const inputs = await readLeverageInputs({ jobs: null, prsPath: '/nonexistent/prs.json' });
    expect(inputs).toEqual({ jobs: null, prsText: null });
    const now = Date.parse('2026-11-18T12:00:00Z');
    const parsed = parseLeverageSources({ text: 'not-json\n', truncated: true }, null, now - 3_600_000, now);
    expect(parsed.sources).toEqual({ jobs: 'degraded', jobsTruncated: true, pullRequests: 'missing' });
  });
});
