import { describe, expect, it } from 'vitest';
import type { FleetShippedReport, ShippedPr } from '../../../../core/fleet/shipped.js';
import { openWords, repoParts, rowSpan, shippedOf, shippedRows, shippedSummary, shippedWindow, slowestRow } from './shipped-card-model.js';

const SINCE = '2026-11-19T12:00:00.000Z', NOW = '2026-11-20T12:00:00.000Z';
const pr = (over: Partial<ShippedPr> = {}): ShippedPr => ({
  repo: 'ashlrai/phantom', number: 7, title: 'Show shipped work', url: 'https://example.invalid/not-used', mergedAt: '2026-11-20T06:00:00.000Z',
  jobId: 'RQ-ONE-1', lane: 'claude', openToMergeSeconds: 3600, ...over,
});
function report(items: ShippedPr[], over: Partial<FleetShippedReport> = {}): FleetShippedReport {
  return { schema: 'fleet.shipped.v1', since: SINCE, generatedAt: NOW, complete: true, items, byRepo: {},
    totals: { merged: items.length, mergedPerHour: items.length / 24, medianOpenToMergeSeconds: 840 }, ...over };
}

describe('shippedOf', () => {
  it('accepts only a fleet.shipped.v1 payload with a list', () => {
    expect(shippedOf(report([]))).not.toBeNull();
    expect(shippedOf({ schema: 'shipped.v1', items: [] })).toBeNull();
    expect(shippedOf({ schema: 'fleet.shipped.v1' })).toBeNull();
    expect(shippedOf({ error: 'nope' })).toBeNull();
    expect(shippedOf(null)).toBeNull();
  });
});

describe('shippedRows', () => {
  it('links from the checked repository and number, never from the payload URL', () => {
    const [row] = shippedRows(report([pr()]));
    expect(row).toMatchObject({ key: 'ashlrai/phantom#7', label: 'phantom', href: 'https://github.com/ashlrai/phantom/pull/7', openSeconds: 3600, lane: 'claude', jobId: 'RQ-ONE-1' });
    expect(row!.mergedMs).toBe(Date.parse('2026-11-20T06:00:00.000Z'));
  });

  it('keeps what the feed does not hold as null instead of a zero', () => {
    const [row] = shippedRows(report([{ repo: 'ashlrai/locus', number: 3, title: 'T' } as ShippedPr]));
    expect(row).toMatchObject({ mergedMs: null, lane: null, jobId: null, openSeconds: null });
    expect(shippedRows(report([pr({ openToMergeSeconds: -5, mergedAt: 'not a date' })]))[0]).toMatchObject({ openSeconds: null, mergedMs: null });
  });

  it('leaves out a row that cannot be linked', () => {
    const rows = shippedRows(report([pr({ repo: 'ashlrai/phantom/../x' }), pr({ number: 0 }), pr({ repo: '' }), null as unknown as ShippedPr, pr({ number: 9 })]));
    expect(rows.map(row => row.number)).toEqual([9]);
  });
});

describe('repoParts', () => {
  it('counts the rows listed, most first then by name', () => {
    const rows = shippedRows(report([pr({ number: 1 }), pr({ number: 2, repo: 'ashlrai/locus' }), pr({ number: 3 }), pr({ number: 4, repo: 'ashlrai/lexicon' })]));
    expect(repoParts(rows)).toEqual([
      { repo: 'ashlrai/phantom', label: 'phantom', merged: 2, share: 0.5 },
      { repo: 'ashlrai/lexicon', label: 'lexicon', merged: 1, share: 0.25 },
      { repo: 'ashlrai/locus', label: 'locus', merged: 1, share: 0.25 },
    ]);
    expect(repoParts([])).toEqual([]);
  });
});

describe('openWords', () => {
  it('uses two units at most', () => {
    expect(openWords(40)).toBe('40 seconds');
    expect(openWords(840)).toBe('14 min');
    expect(openWords(3600)).toBe('1 h');
    expect(openWords(3 * 3600 + 12 * 60)).toBe('3 h 12 min');
    expect(openWords(52 * 3600)).toBe('2 d 4 h');
    expect(openWords(48 * 3600)).toBe('2 d');
  });
});

describe('the window and a row on it', () => {
  const window = shippedWindow(report([]))!;
  it('reads the window from the feed and refuses a guessed one', () => {
    expect(window).toEqual({ startMs: Date.parse(SINCE), endMs: Date.parse(NOW) });
    expect(shippedWindow(report([], { since: 'x' }))).toBeNull();
    expect(shippedWindow(report([], { since: NOW, generatedAt: SINCE }))).toBeNull();
  });

  it('places the merge and the time open before it', () => {
    const [row] = shippedRows(report([pr({ mergedAt: '2026-11-20T06:00:00.000Z', openToMergeSeconds: 6 * 3600 })]));
    expect(rowSpan(row!, window)).toEqual({ from: 0.5, to: 0.75, clipped: false });
  });

  it('clips a pull request opened before the window and says so', () => {
    const [row] = shippedRows(report([pr({ mergedAt: '2026-11-19T18:00:00.000Z', openToMergeSeconds: 48 * 3600 })]));
    expect(rowSpan(row!, window)).toEqual({ from: 0, to: 0.25, clipped: true });
  });

  it('draws no line for an unknown time open and nothing for an unplaceable merge', () => {
    const rows = shippedRows(report([pr({ openToMergeSeconds: null }), pr({ number: 8, mergedAt: '2026-11-18T00:00:00.000Z' }), pr({ number: 9, mergedAt: 'x' })]));
    expect(rowSpan(rows[0]!, window)).toEqual({ from: null, to: 0.75, clipped: false });
    expect(rowSpan(rows[1]!, window)).toBeNull();
    expect(rowSpan(rows[2]!, window)).toBeNull();
  });
});

describe('shippedSummary', () => {
  it('states the totals of a complete report and names the longest open', () => {
    const full = report([pr({ number: 1 }), pr({ number: 2, repo: 'ashlrai/locus', openToMergeSeconds: 3 * 3600 + 12 * 60 }), pr({ number: 3, openToMergeSeconds: null })]);
    const rows = shippedRows(full);
    expect(slowestRow(rows)!.number).toBe(2);
    expect(shippedSummary(full, rows)).toEqual({
      headline: '3 merged across 2 repositories, 0.1 per hour.',
      pace: 'Median open to merge: 14 min. Longest open: locus #2, 3 h 12 min.',
    });
  });

  it('says unknown for a median the report does not hold', () => {
    const one = report([pr({ openToMergeSeconds: null })], { totals: { merged: 1, mergedPerHour: 1 / 24, medianOpenToMergeSeconds: null } });
    expect(shippedSummary(one, shippedRows(one))).toEqual({ headline: '1 merged in phantom, 0.0 per hour.', pace: 'Median open to merge: unknown.' });
  });

  it('gives no total for an incomplete report', () => {
    const partial = report([pr()], { complete: false, totals: { merged: null, mergedPerHour: null, medianOpenToMergeSeconds: null } });
    expect(shippedSummary(partial, shippedRows(partial))).toEqual({ headline: '1 merged pull request listed. Some results are unavailable, so totals are unknown.', pace: null });
  });

  it('says nothing merged only when the complete report counts none', () => {
    expect(shippedSummary(report([]), [])).toEqual({ headline: 'Nothing merged in the last 24 hours.', pace: null });
  });
});
