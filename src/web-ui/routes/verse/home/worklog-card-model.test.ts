import { describe, expect, it } from 'vitest';
import type { WorklogReport } from '../../../../core/fleet/worklog.js';
import { DAY_CELLS, cellWords, dayEvents, daySentence, dayWindow, kindRows, unreadSources, worklogOf } from './worklog-card-model.js';

const END = Date.parse('2026-11-20T12:00:00.000Z');
const at = (hoursAgo: number) => new Date(END - hoursAgo * 3_600_000).toISOString();
const row = (kind: string, hoursAgo: number, more: Record<string, unknown> = {}) => ({ at: at(hoursAgo), kind, job: null, lane: null, repo: null, text: `${kind} ${hoursAgo}`, url: null, count: 1, ...more });

describe('worklogOf', () => {
  it('takes only a worklog.v3 payload with rows', () => {
    expect(worklogOf({ schema: 'worklog.v3', rows: [] })).not.toBeNull();
    for (const other of [null, 'x', { schema: 'home.v1' }, { schema: 'worklog.v3' }, { schema: 'worklog.v2', rows: [] }]) expect(worklogOf(other)).toBeNull();
  });
});

describe('dayEvents', () => {
  it('keeps the order given and leaves out rows with no words or an unknown kind', () => {
    const events = dayEvents([row('merged', 1), null, { at: at(2), kind: 'merged', text: ' ' }, row('deployed', 3), row('incident', 4)]);
    expect(events.map(event => event.kind)).toEqual(['merged', 'incident']);
  });
  it('links only a GitHub pull request address', () => {
    const [pr, other, script] = dayEvents([row('merged', 1, { url: 'https://github.com/ashlrai/phantom/pull/7' }), row('merged', 2, { url: 'https://example.invalid/pull/7' }), row('merged', 3, { url: 'javascript:alert(1)' })]);
    expect(pr!.href).toBe('https://github.com/ashlrai/phantom/pull/7');
    expect(other!.href).toBeNull();
    expect(script!.href).toBeNull();
  });
  it('reads an unparseable time as unknown and a missing count as one', () => {
    const [event] = dayEvents([{ at: 'soon', kind: 'launched', text: 'Launched a job' }]);
    expect(event).toMatchObject({ atMs: null, count: 1, job: null, lane: null });
    expect(dayEvents([row('launched', 1, { count: 3 }), row('launched', 2, { count: 0.5 })]).map(e => e.count)).toEqual([3, 1]);
  });
});

describe('dayWindow', () => {
  it('ends when the report was received and covers its hours', () => {
    expect(dayWindow(24, END)).toEqual({ startMs: END - 86_400_000, endMs: END });
  });
  it('is unknown without the hours or the read time', () => {
    for (const [hours, read] of [[null, END], [0, END], [24, null], [24, undefined], [Number.NaN, END]] as const) expect(dayWindow(hours, read)).toBeNull();
  });
});

describe('kindRows', () => {
  const window = dayWindow(24, END)!;
  it('gives one row per kind present, in the work log order, counting what each line stands for', () => {
    const rows = kindRows(dayEvents([row('incident', 1), row('launched', 2, { count: 3 }), row('merged', 3), row('launched', 5)]), window);
    expect(rows.map(r => [r.kind, r.label, r.events])).toEqual([['merged', 'Merged', 1], ['launched', 'Launched', 4], ['incident', 'Incident', 1]]);
  });
  it('places each event in its slice of the window, oldest first', () => {
    const [launched] = kindRows(dayEvents([row('launched', 0), row('launched', 0.2), row('launched', 12, { count: 2 }), row('launched', 24)]), window);
    expect(launched!.cells).toHaveLength(DAY_CELLS);
    expect(launched!.cells[0]).toBe(1);
    expect(launched!.cells[24]).toBe(2);
    expect(launched!.cells[DAY_CELLS - 1]).toBe(2);
    expect(launched!.peak).toBe(2);
    expect(launched!.lastMs).toBe(END);
  });
  it('counts an event outside the window or without a time, but gives it no slice', () => {
    const [merged] = kindRows(dayEvents([row('merged', 30), row('merged', -1), { at: 'soon', kind: 'merged', text: 'Merged' }]), window);
    expect(merged!.events).toBe(3);
    expect(merged!.cells.every(n => n === 0)).toBe(true);
    expect(merged!.peak).toBe(0);
  });
  it('draws no slices at all without a window', () => {
    const [merged] = kindRows(dayEvents([row('merged', 1)]), null);
    expect(merged).toMatchObject({ events: 1, cells: [], peak: 0 });
  });
});

describe('daySentence', () => {
  it('counts the events by kind', () => {
    const rows = kindRows(dayEvents([row('merged', 1), row('launched', 2, { count: 3 }), row('empty', 3)]), null);
    expect(daySentence(rows, 24)).toBe('5 events in the last 24 hours: 1 merged, 3 launched, 1 no change.');
    expect(daySentence(kindRows(dayEvents([row('leader', 1)]), null), 1)).toBe('1 event in the last hour: 1 leader.');
  });
  it('says so when nothing is recorded, and does not name hours it was not given', () => {
    expect(daySentence([], 24)).toBe('No work recorded in the last 24 hours.');
    expect(daySentence([], null)).toBe('No work recorded.');
    expect(daySentence(kindRows(dayEvents([row('merged', 1)]), null), null)).toBe('1 event in this read: 1 merged.');
  });
});

describe('unreadSources', () => {
  it('names every source the report could not read', () => {
    const report = { schema: 'worklog.v3', hours: 24, rows: [], entries: [], malformedLines: 0, sources: { jobs: { state: 'ok' }, events: { state: 'unknown', reason: 'No dispatch events log has been written yet.' }, leader: { state: 'unknown', reason: 'The leader plan log could not be read.' } } } as WorklogReport;
    expect(unreadSources(report)).toEqual(['No dispatch events log has been written yet.', 'The leader plan log could not be read.']);
    expect(unreadSources({ ...report, sources: undefined } as unknown as WorklogReport)).toEqual([]);
  });
});

describe('cellWords', () => {
  it('names how long one slice covers', () => {
    expect(cellWords(24)).toBe('30 min');
    expect(cellWords(48)).toBe('1 h');
    expect(cellWords(6)).toBe('8 min');
  });
});
