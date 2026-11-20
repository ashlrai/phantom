import { describe, expect, it } from 'vitest';
import { buildLeverageReport, classifyMerge } from '../src/core/metrics/leverage-class.js';
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
});

describe('phm metrics leverage', () => {
  it('prints typed JSON with a schema id and rejects bad flags', () => {
    const out: string[] = [];
    expect(cmdMetrics(['leverage', '--json', '--hours', '6'], { out: s => out.push(s), err: s => out.push(s) })).toBe(0);
    const parsed = JSON.parse(out[0]!);
    expect(parsed.schema).toBe('metrics.leverage.v1');
    expect(parsed.hours).toBe(6);
    expect(cmdMetrics(['leverage', '--hours', '0'], { out: () => {}, err: () => {} })).toBe(2);
    expect(cmdMetrics(['leverage', '--bad', 'x'], { out: () => {}, err: () => {} })).toBe(2);
  });
});
