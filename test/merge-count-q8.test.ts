import { describe, expect, it } from 'vitest';
import { readMetrics } from '../src/core/fleet/metrics-glance.js';
import { briefText, buildFleetBrief } from '../src/core/fleet/status-brief.js';
import { buildThroughput } from '../src/core/fleet/throughput.js';

const NOW = Date.parse('2026-11-26T01:09:01-05:00');
const pr = (n: number) => `https://github.com/ashlrai/phantom/pull/${n}`;
const outcome = (n: number, ts: string, extra = {}) => ({ job: `RQ-TEST-${n}`, url: pr(n), ts, outcome: 'MERGED', ...extra });
const ledger = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n');
const throughput = (rows: unknown[], now = NOW) => buildThroughput({ ledger: ledger(rows), now, hours: 1, by: 'repo', metricsPath: '/fixture' });
async function summary(rows: unknown[], now = NOW) {
  const metrics = await readMetrics({ now, reader: { status: async () => null, jobs: async () => ledger(rows) } });
  const brief = buildFleetBrief({ metrics, guardian: null, runway: null }, now);
  return { metrics, brief, text: briefText(brief) };
}

describe('last-hour merge summary', () => {
  it('carries six outcomes between 00:14 and 01:03 through the metrics reader and status renderer', async () => {
    // Synthetic PRs reproduce the reported interval, with the producer dialects mixed.
    const rows = [
      outcome(1, '2026-11-26T00:14:00-05:00'),
      outcome(2, '2026-11-26T00:22:00-0500', { event: 'outcome' }),
      outcome(3, '2026-11-26T05:31:00Z', { event: 'publish', source: 'metrics-outcomes-reconciler' }),
      outcome(4, '2026-11-26T00:42:00-05:00', { type: 'published' }),
      outcome(5, '2026-11-26T11:24:00+0530', { kind: 'outcome' }),
      outcome(6, '2026-11-26T01:08:00-05:00', { mergedAt: '2026-11-26 01:03:00-0500' }),
    ];
    for (const ordered of [rows, [...rows].reverse()]) {
      const result = await summary(ordered);
      expect(result.metrics).toMatchObject({ merged: 6, merged_per_hour: { last_1h: 6, last_6h: 1, last_24h: 0.25 } });
      expect(result.brief.merged).toEqual({ lastHour: 6, last24h: 6 });
      expect(result.text[0]).toBe('Merged: 6 in the last hour, 6 in 24 hours.');
      expect(throughput(ordered).totals).toMatchObject({ merged: 6, published: 0, median_publish_to_merge_s: null });
    }
  });

  it.each(['2026-11-26T01:09:01-05:00', '2026-11-26T06:09:01Z', '2026-11-26T11:39:01+0530'])(
    'includes both rolling-hour boundaries with as-of %s, but neither adjacent millisecond', async stamp => {
      const now = Date.parse(stamp), since = now - 3_600_000;
      const result = await summary([since - 1, since, now, now + 1].map((at, i) => outcome(i + 1, new Date(at).toISOString())), now);
      expect(result.brief.merged).toEqual({ lastHour: 2, last24h: 3 });
      expect(result.text[0]).toBe('Merged: 2 in the last hour, 3 in 24 hours.');
    });

  it('deduplicates outcomes across jobs, equivalent offsets and URL spellings before windowing', async () => {
    const rows = [
      outcome(1, '2026-11-26T00:14:00-0500'),
      outcome(1, '2026-11-26T05:14:00Z', { job: 'RQ-RETRY', url: 'https://github.com/ASHLRAI/PHANTOM/pull/1/' }),
      outcome(2, '2026-11-26T00:09:00-05:00'),
      outcome(2, '2026-11-26T01:03:00-05:00', { job: 'RQ-REEMIT' }),
    ];
    for (const ordered of [rows, [...rows].reverse()]) expect((await summary(ordered)).brief.merged).toEqual({ lastHour: 1, last24h: 2 });
  });

  it('uses the merge time, excludes future merges and never counts terminal rows as publications', () => {
    const ts = '2026-11-26T01:03:00-05:00';
    const rows = [
      outcome(1, ts, { event: 'publish', mergedAt: '2026-11-26T00:09:00-0500' }),
      outcome(2, ts, { event: 'outcome', mergedAt: new Date(NOW + 1).toISOString() }),
      outcome(3, ts, { event: 'publish', outcome: 'CLOSED' }),
      outcome(4, ts, { outcome: 'PUBLISHED' }),
      outcome(5, ts, { event: 'publish', outcome: 'PUBLISHED' }),
      outcome(6, ts, { event: 'outcome', mergedAt: 'invalid' }),
      { event: 'MERGED', url: pr(7), ts },
    ];
    expect(rows.map(row => throughput([row]).totals.merged)).toEqual([0, 0, 0, 0, 0, 1, 1]);
    expect(rows.map(row => throughput([row]).totals.published)).toEqual([0, 0, 0, 1, 1, 0, 0]);
    const report = throughput(rows);
    expect(report.totals).toMatchObject({ merged: 2, published: 2, median_publish_to_merge_s: null });
  });
});
