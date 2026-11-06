import { expect, it } from 'vitest';
import { passIngestCounts, passWroteText } from './leader-journal-model.js';
import type { DropIngestedRow, JournalPass } from './leader-journal-model.js';

const pass = (at: string): JournalPass => ({ at, sections: [] });
const row = (at: string, leader = 'fake-leader'): DropIngestedRow => ({ at, id: 'fake-job', leader, lane: 'fake', tier: 'fake', title: 'Fake job' });

it('counts ingests in chronological pass windows through now', () => {
  const passes = [pass('2026-01-01T12:20:00Z'), pass('2026-01-01T12:00:00Z'), pass('2026-01-01T12:10:00Z'), pass('invalid')];
  const rows = [
    row('2026-01-01T11:59:59Z'), row('2026-01-01T12:00:00Z'), row('2026-01-01T12:02:00Z', 'another-fake-leader'),
    row('2026-01-01T12:20:00Z'), row('2026-01-01T12:29:00Z'), row('2026-01-01T12:30:00Z'),
    row('2026-01-01T12:30:01Z'), row('invalid'),
  ];
  const counts = passIngestCounts(passes, rows, Date.parse('2026-01-01T12:30:00Z'));
  expect(counts.get('2026-01-01T12:00:00Z')).toBe(2);
  expect(counts.get('2026-01-01T12:10:00Z')).toBe(0);
  expect(counts.get('2026-01-01T12:20:00Z')).toBe(3);
  expect(counts.get('invalid')).toBe(0);
  expect(passWroteText(0)).toEqual({ text: 'wrote 0 jobs', tone: 'warning' });
  expect(passWroteText(3)).toEqual({ text: 'wrote 3 jobs', tone: 'neutral' });
});
