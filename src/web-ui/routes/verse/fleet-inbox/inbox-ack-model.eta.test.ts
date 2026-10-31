import { expect, it } from 'vitest';
import { annotateAck, seenCounts } from './inbox-ack-model.js';

const entries = [
  { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: 'Seen' },
  { at: '2026-10-31 00:16', source: 'telegram', priority: 'P0', text: 'Waiting' },
];
const runs = { generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] };

it('annotates waiting entries and counts an overdue pass without changing seen labels', () => {
  const due = annotateAck(entries, runs, Date.parse('2026-10-31T04:24:00Z'));
  expect(due.map(entry => entry.ackLabel)).toEqual(['Seen by a leader pass', 'Waiting · next pass in ~6 min']);
  expect(seenCounts(due)).toEqual({ seen: 1, waiting: 1, overdue: false });
  const late = annotateAck(entries, runs, Date.parse('2026-10-31T04:39:00Z'));
  expect(late.map(entry => entry.ackLabel)).toEqual(['Seen by a leader pass', 'Waiting · pass overdue by 9 min']);
  expect(seenCounts(late)).toEqual({ seen: 1, waiting: 1, overdue: true });
  expect(seenCounts([late[0]!])).toEqual({ seen: 1, waiting: 0, overdue: false });
});
