import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { filterWorklog, worklog } from '../src/core/fleet/worklog.js';

describe('work log', () => {
  it('orders merged outcomes, joins launch details and counts malformed lines', async () => {
    const text = await readFile(new URL('./fixtures/worklog/jobs.jsonl', import.meta.url), 'utf8');
    const report = worklog(text, Date.parse('2026-11-09T00:00:00Z'), Date.parse('2026-11-10T00:00:00Z'));
    expect(filterWorklog(report.entries, 'phantom', 'work').map(e => e.job)).toEqual(['J1']);
    expect(filterWorklog(report.entries, 'locus', 'work')).toEqual([]);
    expect(filterWorklog(report.entries, undefined, 'fast').map(e => e.job)).toEqual(['J2']);
    expect(report.malformedLines).toBe(1);
    expect(report.entries.map(e => e.job)).toEqual(['J2', 'J1']);
    expect(report.entries[1]).toMatchObject({ repo: 'phantom', lane: 'work', model: 'model-a', openToMergeSeconds: 42 });
    expect(report.entries[0]).toMatchObject({ model: null, url: null, openToMergeSeconds: null });
  });
});
