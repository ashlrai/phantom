import { describe, expect, it } from 'vitest';
import { fleetRepoRate } from '../src/cli/fleet-repo-rate.js';

const now = Date.parse('2026-11-03T12:00:00Z');

describe('fleet repo-rate ±HHMM offset', () => {
  it('counts MERGED rows with ±HHMM offsets and ignores bad ts', () => {
    // -0500 → 11:00Z (1 hour ago, within 6h window)
    // +0330 → 10:00Z (2 hours ago, within 6h window)
    // bad ts → rejected
    const row1 = JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-03T06:00:00-0500', url: 'https://github.com/ashlrai/phantom/pull/100', ttm_s: 150 });
    const row2 = JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-03T13:30:00+0330', url: 'https://github.com/ashlrai/phantom/pull/101', ttm_s: 250 });
    const row3 = JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-03T13:00:00Xbad', url: 'https://github.com/ashlrai/phantom/pull/102' });
    const report = fleetRepoRate([row1, row2, row3].join('\n'), 6, 2, false, now);
    expect(report.by_repo).toEqual([
      { repo: 'ashlrai/phantom', merged: 2, median_ttm_s: 200, newest_merge_at: '2026-11-03T11:00:00.000Z', checked: true, red: false },
    ]);
    expect(report.red).toBe(false);
    expect(report.ignored_rows).toBe(1);
  });

  it('preserves Z and ±HH:MM behaviour (unchanged)', () => {
    // Z → 11:00Z (1 hour ago, within 6h window)
    // +05:30 → 10:30Z (1.5 hours ago, within 6h window)
    const row1 = JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-03T11:00:00Z', url: 'https://github.com/ashlrai/phantom/pull/200', ttm_s: 100 });
    const row2 = JSON.stringify({ event: 'outcome', state: 'MERGED', ts: '2026-11-03T16:00:00+05:30', url: 'https://github.com/ashlrai/phantom/pull/201' });
    const report = fleetRepoRate([row1, row2].join('\n'), 6, 2, true, now);
    expect(report.by_repo).toEqual([
      { repo: 'ashlrai/phantom', merged: 2, median_ttm_s: 100, newest_merge_at: '2026-11-03T11:00:00.000Z', checked: true, red: false },
    ]);
    expect(report.ignored_rows).toBe(0);
  });
});
