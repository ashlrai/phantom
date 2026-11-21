/** The Models board's work reading: counts and bars come from the per-model throughput report and nothing else. */
import { describe, expect, it } from 'vitest';
import { barHeight, launchedBy, spanWords, workBoard, workColumns, workWords } from './model-work-model.js';
import { workCounts, workGroup, workReport } from './model-work.test-support.js';

const IDS = ['opus', 'fresh', 'b-unknown'];
const groups = [
  workGroup('opus', { launched: 7, merged: 3, finished: 6, empty: 1 }, { 3: { launched: 2 }, 22: { launched: 4, merged: 1 }, 23: { launched: 1, merged: 2 } }),
  workGroup('fresh', { launched: 1, merged: 0, finished: 0, empty: 0 }, { 23: { launched: 1 } }),
  workGroup('other-9', { launched: 2, merged: 1, finished: 2, empty: 2 }, { 10: { launched: 2, merged: 1 } }),
  workGroup('unknown', { launched: 5, merged: 2, finished: 5, empty: 0 }, { 12: { launched: 5, merged: 2 } }),
];
const read = (report: Parameters<typeof workBoard>[0]['report'], failed = false, hours = 24) => workBoard({ report, failed, hours, ids: IDS });

describe('work words', () => {
  it('says the counts the report holds, and unknown for one it does not', () => {
    expect(workWords(workCounts({ launched: 12, merged: 5, finished: 10, empty: 2 }))).toBe('12 jobs launched, 5 PRs merged, 2 of 10 finished jobs empty');
    expect(workWords(workCounts({ launched: 1, merged: 1 }))).toBe('1 job launched, 1 PR merged, none finished');
    expect(workWords(workCounts({ launched: 3, merged: 0, finished: null, empty: null }))).toBe('3 jobs launched, 0 PRs merged');
    expect(workWords(workCounts({ launched: null, merged: null }))).toBe('unknown');
    expect([spanWords(24), spanWords(168), spanWords(6), spanWords(1)]).toEqual(['24 hours', '7 days', '6 hours', '1 hour']);
  });
});

describe('work columns', () => {
  it('keeps a bar an hour for a day and folds a week into 24 bars of 7 hours', () => {
    const day = workColumns(groups[0]!);
    expect(day).toHaveLength(24);
    expect(day[22]).toEqual({ start: '2026-11-18T10:00:00.000Z', hours: 1, launched: 4, merged: 1 });
    const week = workColumns(workGroup('opus', {}, { 0: { launched: 1 }, 6: { launched: 2, merged: 1 }, 7: { launched: 5 }, 167: { merged: 3 } }, 168));
    expect(week).toHaveLength(24);
    expect(week.map(column => column.hours)).toEqual(Array(24).fill(7));
    expect([week[0]!.launched, week[0]!.merged, week[1]!.launched, week[23]!.merged]).toEqual([3, 1, 5, 3]);
  });

  it('gives one job a visible bar and nothing no bar', () => {
    expect([barHeight(0, 40), barHeight(1, 40), barHeight(20, 40), barHeight(40, 40)]).toEqual([0, 12, 50, 100]);
  });
});

describe('work board', () => {
  it('joins each model to its group, compares rows against one peak and names what no row counts', () => {
    const board = read(workReport(groups));
    expect(board).toMatchObject({ state: 'ok', span: '24 hours', columnHours: 1, peak: 4 });
    expect(board.line).toBe('Last 24 hours: 15 jobs launched, 6 PRs merged, 3 of 13 finished jobs empty, under 3 model names.');
    expect(board.unnamed).toBe('No model is named for 5 of 15 launches and 2 of 6 merged PRs, so no row counts them.');
    expect(board.strangers).toEqual([{ name: 'other-9', words: '2 jobs launched, 1 PR merged, 2 of 2 finished jobs empty' }]);
    expect(board.works.get('opus')).toMatchObject({ kind: 'worked', words: '7 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty', spoken: 'opus jobs launched over the last 24 hours, a bar per hour: most in one bar 4' });
    expect(board.works.get('opus')!.columns).toHaveLength(24);
    // The report was read and holds no group for it: a measured nothing, not a gap.
    expect(board.works.get('b-unknown')).toEqual({ kind: 'idle', totals: null, columns: [], words: 'no work recorded in the last 24 hours', spoken: 'b-unknown: no work recorded in the last 24 hours' });
    expect(launchedBy(board, ['opus', 'fresh'])).toBe(8);
    expect(launchedBy(board, ['b-unknown'])).toBe(0);
  });

  it('says so when nothing was recorded, and leaves the unnamed sentence out when every launch names a model', () => {
    const quiet = read(workReport([]));
    expect(quiet).toMatchObject({ state: 'ok', line: 'No job or PR was recorded in the last 24 hours.', unnamed: null, strangers: [], peak: 1 });
    expect([...quiet.works.values()].map(work => work.kind)).toEqual(['idle', 'idle', 'idle']);
    expect(read(workReport(groups.slice(0, 2))).unnamed).toBeNull();
    expect(read(workReport(groups.slice(0, 2))).line).toBe('Last 24 hours: 8 jobs launched, 3 PRs merged, 1 of 6 finished jobs empty, under 2 model names.');
  });

  it('reads a week as 7 days with a bar per 7 hours', () => {
    const week = read(workReport([workGroup('opus', { launched: 9, merged: 4 }, { 0: { launched: 9 } }, 168)], { hours: 168 }), false, 168);
    expect(week).toMatchObject({ span: '7 days', columnHours: 7, peak: 9 });
    expect(week.works.get('opus')!.spoken).toBe('opus jobs launched over the last 7 days, a bar per 7 hours: most in one bar 9');
  });

  it('leaves every model unknown, never idle, when the report or the metrics file cannot be read', () => {
    const failed = read(null, true);
    expect(failed).toMatchObject({ state: 'unread', line: 'Work in the last 24 hours is unknown: the per-model throughput report could not be read.', unnamed: null, strangers: [] });
    expect([...failed.works.values()].map(work => [work.kind, work.words])).toEqual(Array(3).fill(['unread', 'work unknown']));
    expect(launchedBy(failed, IDS)).toBeNull();
    const unreadable = read(workReport([], { metrics: 'unreadable', totals: workCounts({ launched: null, merged: null, finished: null, empty: null }) }));
    expect(unreadable).toMatchObject({ state: 'unread', line: 'Work in the last 24 hours is unknown: the job metrics file could not be read.' });
    expect(unreadable.works.get('opus')!.kind).toBe('unread');
    const reading = read(null, false, 168);
    expect(reading).toMatchObject({ state: 'reading', line: 'Reading the last 7 days of work.' });
    expect(reading.works.get('opus')).toMatchObject({ kind: 'reading', words: 'reading work' });
    expect(launchedBy(reading, IDS)).toBeNull();
  });
});
