import { describe, expect, it } from 'vitest';
import { claimedRows, claimedTell } from './claimed-rows.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const at = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const claim = (job: string, seconds: number) => ({ job, lane: 'work', tier: 'mid', at: at(seconds) });
const worker = (job: string) => ({ job, repo: 'example/repo', lane: 'work', tier: 'mid', ageSeconds: 30 });
const runs = { claimed: [claim('old', 420), claim('running', 60), claim('new', 120)],
  workers: [worker('running')], lastTick: at(180) };

describe('claimed jobs', () => {
  it('filters running jobs and orders the remaining claims newest first', () => {
    expect(claimedRows(runs, now)).toEqual([
      { job: 'new', lane: 'work', tier: 'mid', ageSeconds: 120, ageText: '02:00', startedElsewhere: false },
      { job: 'old', lane: 'work', tier: 'mid', ageSeconds: 420, ageText: '07:00', startedElsewhere: false },
    ]);
    expect(claimedTell(claimedRows(runs, now), runs, now)).toEqual({
      text: 'Dispatch is not starting claimed jobs (oldest 7 min, last tick 3 min ago)', tone: 'warn',
    });
  });

  it('uses strict five, fifteen and twenty minute thresholds', () => {
    const tell = (claimAge: number, tickAge: number) => {
      const input = { ...runs, workers: [], claimed: [claim('job', claimAge)], lastTick: at(tickAge) };
      return claimedTell(claimedRows(input, now), input, now);
    };
    expect(tell(299, 0)).toBeNull();
    expect(tell(300, 0)).toBeNull();
    expect(tell(301, 1200)?.tone).toBe('warn');
    expect(tell(900, 0)?.tone).toBe('warn');
    expect(tell(901, 0)?.tone).toBe('bad');
    expect(tell(301, 1201)?.tone).toBe('bad');
  });

  it('does not infer claims from missing data, and handles unknown or future timestamps', () => {
    const missing = { ...runs, claimed: undefined };
    expect(claimedRows(missing, now)).toEqual([]);
    expect(claimedTell(claimedRows(runs, now), missing, now)).toBeNull();
    const input = { ...runs, claimed: [claim('future', -60), { ...claim('invalid', 0), at: 'invalid' }, claim('old', 420)], lastTick: null };
    const rows = claimedRows(input, now);
    expect(rows.map(row => [row.job, row.ageSeconds])).toEqual([['future', 0], ['old', 420]]);
    expect(claimedTell(rows, input, now)?.text).toContain('last tick unknown');
  });
});
