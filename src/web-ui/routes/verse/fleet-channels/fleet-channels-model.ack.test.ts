import { expect, it } from 'vitest';
import { annotateAck } from '../fleet-inbox/inbox-ack-model.js';
import { ackByChannel } from './fleet-channels-model.js';

const runs = { generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] };
// The newest leader pass ran at 04:15Z (00:15 ET); the next is due at 04:30Z
// and is overdue once the 3-minute grace lapses (04:33Z).

it('rolls annotated entries up per channel', () => {
  const entries = [
    // telegram: two waiting — annotated once while the next pass is still due, once after it is overdue
    ...annotateAck([{ at: '2026-10-31 00:16', source: 'Telegram', priority: 'P0', text: 'fake telegram order A' }], runs, Date.parse('2026-10-31T04:24:00Z')),
    ...annotateAck([{ at: '2026-10-31 00:17', source: 'Telegram', priority: 'P0', text: 'fake telegram order B' }], runs, Date.parse('2026-10-31T04:39:00Z')),
    // desktop: one seen
    ...annotateAck([{ at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: 'fake desktop order' }], runs, Date.parse('2026-10-31T04:20:00Z')),
  ];
  const map = ackByChannel(entries);
  expect(map.get('telegram')).toEqual({ seen: 0, waiting: 2, overdue: true });
  expect(map.get('desktop')).toEqual({ seen: 1, waiting: 0, overdue: false });
});

it('counts unknown entries in neither bucket', () => {
  const entries = annotateAck([
    { at: 'not-a-time', source: 'Telegram', priority: 'P0', text: 'fake garbled row' },
    { at: '2026-10-31 00:16', source: 'Telegram', priority: 'P0', text: 'fake telegram order' },
  ], runs, Date.parse('2026-10-31T04:24:00Z'));
  expect(entries[0]!.ack).toBe('unknown');
  expect(ackByChannel(entries).get('telegram')).toEqual({ seen: 0, waiting: 1, overdue: false });
});

it('returns an empty map for empty input', () => {
  expect(ackByChannel([]).size).toBe(0);
});
