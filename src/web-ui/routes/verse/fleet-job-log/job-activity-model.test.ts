import { describe, expect, it } from 'vitest';
import {
  activityCountsLine, entrySearchText, eventTimeLabel, filterActivityEntries, isJobActivity,
  type JobActivityEntry, type JobActivityV1,
} from './job-activity-model.js';

const base: JobActivityV1 = {
  schema: 'fleet.job.activity.v1',
  entries: [
    { kind: 'event', at: '2026-11-09T10:00:00+0000', event: 'launch', summary: 'lane=codex' },
    { kind: 'command', text: 'npm test', line: 3 },
    { kind: 'files', state: 'live', baseSha: 'abc1234', files: [{ path: 'src/a.ts', added: 2, removed: 1, status: 'modified' }], totals: { files: 1, added: 2, removed: 1 }, truncated: false, refusals: [] },
    { kind: 'report', name: 'notes', state: 'ok', source: 'notes', bytes: 10, truncated: false, text: 'done' },
  ],
  counts: { events: 1, commands: 1, files: 1, reports: 1 },
};

describe('isJobActivity', () => {
  it('accepts the wire shape and rejects malformed entries', () => {
    expect(isJobActivity(base)).toBe(true);
    expect(isJobActivity({ schema: 'fleet.job.v1' })).toBe(false);
    expect(isJobActivity({ ...base, entries: [{ kind: 'command', text: 'x' }] })).toBe(false);
    expect(isJobActivity({ ...base, entries: [{ kind: 'files', state: 'live', files: [{ path: '/abs', added: 0, removed: 0, status: 'modified' }], totals: { files: 0, added: 0, removed: 0 }, truncated: false }] })).toBe(false);
    expect(isJobActivity(null)).toBe(false);
  });
});

describe('filterActivityEntries', () => {
  it('returns everything for an empty query and matches across kinds', () => {
    const entries = base.entries!;
    expect(filterActivityEntries(entries, '  ')).toHaveLength(4);
    expect(filterActivityEntries(entries, 'NPM').map(e => e.kind)).toEqual(['command']);
    expect(filterActivityEntries(entries, 'src/a.ts').map(e => e.kind)).toEqual(['files']);
    expect(filterActivityEntries(entries, 'launch').map(e => e.kind)).toEqual(['event']);
    expect(filterActivityEntries(entries, 'notes').map(e => e.kind)).toEqual(['report']);
    expect(filterActivityEntries(entries, 'zzz')).toHaveLength(0);
  });
});

describe('entrySearchText / labels', () => {
  it('covers every kind for search', () => {
    for (const entry of base.entries as JobActivityEntry[]) {
      expect(typeof entrySearchText(entry)).toBe('string');
    }
    expect(entrySearchText(base.entries![3]!)).toContain('done');
  });
});

describe('activityCountsLine / eventTimeLabel', () => {
  it('formats counts and event times', () => {
    expect(activityCountsLine(base)).toBe('1 event · 1 command · 1 file · 1 report');
    expect(activityCountsLine({ schema: 'fleet.job.activity.v1', entries: [] })).toBe('0 events · 0 commands · 0 files · 0 reports');
    expect(eventTimeLabel('2026-11-09T10:04:05+0000')).toBe('10:04:05');
    expect(eventTimeLabel(null)).toBe('');
    expect(eventTimeLabel('not a date')).toBe('not a date');
  });
});
