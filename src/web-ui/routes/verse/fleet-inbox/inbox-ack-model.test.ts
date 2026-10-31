import { describe, expect, it } from 'vitest';
import { annotateAck, seenCounts } from './inbox-ack-model.js';

const now = Date.parse('2026-10-31T04:20:00Z');
const entries = [
  { at: '2026-10-31 00:13', source: 'desktop', priority: 'P0', text: 'Older' },
  { at: '2026-10-31 00:16', source: 'telegram', priority: 'P0', text: 'Newer' },
  { at: 'bad', source: 'email', priority: 'P0', text: 'Invalid' },
];
const runs = { generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }, { ageSeconds: 600 }] };

describe('inbox acknowledgements', () => {
  it('uses the newest pass and the shared source labels', () => {
    const result = annotateAck(entries, runs, now);
    expect(result.map(e => e.ack)).toEqual(['seen', 'waiting', 'unknown']);
    expect(result.map(e => e.ackLabel)).toEqual(['Seen by a leader pass', 'Waiting · next pass in ~10 min', 'Unknown']);
    expect(result.map(e => e.sourceLabel)).toEqual(['Phantom desktop', 'Telegram', 'Email']);
    expect(seenCounts(result)).toEqual({ seen: 1, waiting: 1, overdue: false });
  });

  it('reports unknown without a usable snapshot or pass', () => {
    for (const snapshot of [undefined, {}, { ...runs, generatedAt: 'bad' }, { ...runs, leaders: [{ ageSeconds: null }] }, { ...runs, leaders: [null] }]) {
      expect(annotateAck(entries, snapshot, now).every(e => e.ack === 'unknown')).toBe(true);
    }
    expect(seenCounts(annotateAck(entries, undefined, now))).toEqual({ seen: 0, waiting: 0, overdue: false });
  });
});
