import { expect, it } from 'vitest';
import { lastExchange } from './last-exchange-model.js';
import { buildSteering } from './steering-model.js';
import type { LeaderJournalV1 } from '../leader-journal/leader-journal-model.js';

const now = Date.parse('2026-10-31T11:59:00Z');
const orders = buildSteering({ inbox: [
  { at: '2026-10-31 07:41', source: 'Phantom desktop', text: 'x'.repeat(140) },
  { at: '2026-10-31 07:30', source: 'fake phone', text: 'older' },
] });
function journal(minutesAgo: number): LeaderJournalV1 {
  return { v: 1, generatedAt: new Date(now).toISOString(),
    sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
    passes: [
      { at: 'invalid', sections: [] },
      { at: new Date(now - 120 * 60_000).toISOString(), sections: [] },
      { at: new Date(now - minutesAgo * 60_000).toISOString(), sections: [{ title: 'Pass', bullets: ['Acknowledged; workers moving', 'second bullet'] }] },
    ], ingest: [], ingested: [], rejectedLastHour: 0 };
}
it('handles no entries and no journal', () => {
  for (const value of [null, undefined]) {
    expect(lastExchange([], value, now)).toMatchObject({ order: null, pass: null, eta: null, tone: 'neutral' });
    expect(lastExchange([], value, now).text).toContain('no pass recorded yet');
  }
});
it('shows the newest order with a 120 character preview', () => {
  const result = lastExchange([...orders].reverse(), null, now);
  expect(result.order).toEqual({ at: '2026-10-31 07:41', source: 'Phantom desktop', preview: 'x'.repeat(120) });
  expect(result.text).toContain('You · 07:41 ET · Phantom desktop:');
});
it('uses the newest valid journal pass, even newer than the order', () => {
  const result = lastExchange(orders, journal(9), now);
  expect(result.pass).toEqual({ atMs: now - 9 * 60_000, agoText: '9 min ago', summary: 'Acknowledged; workers moving' });
  expect(result.text).toContain('Leaders · last pass 07:50 (9 min ago): Acknowledged; workers moving · next pass due in about 6 min');
  expect(result.tone).toBe('ok');
});
it('warns when overdue by 12 minutes', () => {
  expect(lastExchange(orders, journal(27), now)).toMatchObject({ tone: 'warning', eta: { kind: 'overdue', minutes: 12 } });
});
it('uses danger when overdue by 40 minutes', () => {
  expect(lastExchange(orders, journal(55), now)).toMatchObject({ tone: 'danger', eta: { kind: 'overdue', minutes: 40 } });
});
it('keeps exactly 30 minutes overdue at warning and ignores invalid pass stamps', () => {
  expect(lastExchange([], journal(45), now).tone).toBe('warning');
  const invalid = journal(9); invalid.passes = [{ at: 'invalid', sections: [] }];
  expect(lastExchange([], invalid, now).pass).toBeNull();
});
