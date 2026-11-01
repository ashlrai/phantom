import { expect, it } from 'vitest';
import { buildSteering, unansweredHeadline, unansweredOrders } from './steering-model.js';

const now = Date.parse('2026-10-31T16:00:00Z'); // noon Eastern
const snapshot = {
  inbox: [
    { at: '2026-10-31 11:50', source: 'Chat', text: 'Fake recent order' },
    { at: '2026-10-31 11:15', source: 'Desktop', text: 'Fake quiet order' },
    { at: '2026-10-31 09:00', source: 'Telegram', text: 'Fake held order' },
    { at: '2026-10-31 10:00', source: 'Chat', text: 'Fake launched order' },
  ],
  events: [
    { at: '2026-10-31T09:01:00Z', kind: 'LANE_HOLD', text: 'Fake hold' },
    { at: '2026-10-31T10:01:00Z', kind: 'LAUNCH', text: 'Fake launch' },
  ],
};

it('finds old orders without a pass, launch or publish, including holds', () => {
  const list = unansweredOrders(buildSteering(snapshot), now);
  expect(list.map(({ text, ageMinutes }) => [text, ageMinutes])).toEqual([
    ['Fake held order', 180], ['Fake quiet order', 45],
  ]);
  expect(unansweredHeadline(list)).toBe('2 orders have had no leader reaction for 30+ min; oldest 3 h (Telegram).');
  expect(unansweredHeadline([])).toBeNull();
  expect(unansweredHeadline([{ ...list[0]!, ageMinutes: 130 }, list[1]!, list[1]!]))
    .toBe('3 orders have had no leader reaction for 30+ min; oldest 2 h 10 min (Telegram).');
  expect(unansweredHeadline([{ ...list[0]!, ageMinutes: 130 }])).toBe('1 order has had no leader reaction for 30+ min; oldest 2 h 10 min (Telegram).');
});

it('honors the boundary, optional threshold, incident-only orders and invalid clocks', () => {
  const entries = buildSteering({ inbox: [
    { at: '2026-10-31 10:30', source: 'Chat', text: 'Fake published' },
    { at: '2026-10-31 11:30', source: 'Chat', text: 'Fake boundary' },
    { at: '2026-10-31 11:31', source: 'Chat', text: 'Fake younger' },
    { at: 'bad', source: 'Chat', text: 'Fake malformed' },
    { at: '2026-10-31 12:01', source: 'Chat', text: 'Fake future' },
  ], events: [
    { at: '2026-10-31T10:31:00Z', kind: 'PUBLISHED', text: 'Fake publish' },
    { at: '2026-10-31T11:30:01Z', kind: 'INCIDENT', text: 'Fake incident' },
  ] });
  expect(unansweredOrders(entries, now).map(entry => entry.text)).toEqual(['Fake boundary']);
  expect(unansweredOrders(entries, now, 29).map(entry => entry.text)).toEqual(['Fake boundary', 'Fake younger']);
  expect(unansweredOrders(entries, NaN)).toEqual([]);
});

it('uses elapsed time across the Eastern daylight-saving transition', () => {
  const entries = buildSteering({ inbox: [{ at: '2026-11-01 00:30', source: 'Chat', text: 'Fake transition' }] });
  expect(unansweredOrders(entries, Date.parse('2026-11-01T07:00:00Z'))[0]?.ageMinutes).toBe(150);
});
