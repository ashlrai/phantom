import { describe, expect, it } from 'vitest';
import { unansweredRows } from './leader-unanswered-model.js';

const now = Date.parse('2026-10-31T05:00:00Z'); // 01:00 Eastern
const order = (at: string, text: string) => ({ at, text, source: 'email' });

describe('unansweredRows', () => {
  it('shows the oldest five with a short preview and the full follow-up', () => {
    const full = 'x'.repeat(120);
    const inbox = Array.from({ length: 7 }, (_, i) => order(`2026-10-30 23:${String(10 + i).padStart(2, '0')}`, i === 0 ? full : `Order ${i}`));
    const rows = unansweredRows({ inbox, events: [] }, now);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({ at: '2026-10-30 23:10', age: '1 h 50 min', text: 'x'.repeat(100), askAgain: `Still unanswered after 1 h 50 min: ${full}` });
    expect(rows.map((row) => row.at)).toEqual(inbox.slice(0, 5).map((entry) => entry.at));
  });

  it('includes the 30-minute boundary and excludes reactions, newer and malformed orders', () => {
    const inbox = [order('2026-10-30 23:00', 'Answered'), order('2026-10-30 23:30', 'Launched'),
      order('2026-10-31 00:30', 'Boundary'), order('2026-10-31 00:31', 'Too new'), order('bad', 'Invalid')];
    const events = [{ at: '2026-10-30T23:05:00Z', kind: 'LEADER', text: 'pass' },
      { at: '2026-10-30T23:35:00Z', kind: 'LAUNCH', text: 'work' }];
    expect(unansweredRows({ inbox, events }, now)).toEqual([{ at: '2026-10-31 00:30', age: '30 min', text: 'Boundary', askAgain: 'Still unanswered after 30 min: Boundary' }]);
    expect(unansweredRows(null, now)).toEqual([]);
  });
});
