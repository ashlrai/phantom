import { describe, expect, it } from 'vitest';
import { mobileTime } from './interject-ack-model.js';
import { inboxSeen } from './inbox-seen-model.js';

const now = Date.parse('2026-10-31T04:24:00Z');
const entries = [
  { at: '2026-10-31 00:13', source: 'desktop', priority: null, text: 'Seen' },
  { at: '2026-10-31 00:16', source: 'telegram', priority: 'P1', text: 'Waiting' },
];
const snapshot = { generatedAt: '2026-10-31T04:20:00Z', leaders: [{ ageSeconds: 300 }] };

describe('mobile inbox seen model', () => {
  it('reports a seen pass and a waiting ETA', () => {
    expect(inboxSeen(entries, snapshot, now)).toEqual({
      entries: [
        { ackLabel: `Seen by leaders ${mobileTime('2026-10-31T04:15:00Z')}`, tone: 'ok' },
        { ackLabel: 'Waiting · next pass due in about 6 min', tone: 'neutral' },
      ], waiting: 1, overdue: false,
    });
  });

  it('marks waiting entries overdue using the shared grace period', () => {
    expect(inboxSeen(entries, snapshot, Date.parse('2026-10-31T04:33:00Z'))).toMatchObject({
      entries: [{ tone: 'ok' }, { ackLabel: 'Waiting · leader pass overdue', tone: 'warning' }],
      waiting: 1, overdue: true,
    });
  });

  it('does not claim a pass when the snapshot or entry time is unknown', () => {
    expect(inboxSeen(entries, undefined, now)).toEqual({
      entries: entries.map(() => ({ ackLabel: 'Leader status unknown', tone: 'neutral' })), waiting: 0, overdue: false,
    });
    expect(inboxSeen([{ ...entries[0]!, at: 'bad' }], snapshot, now).entries[0]?.ackLabel).toBe('Leader status unknown');
  });

  it('handles an empty inbox', () => {
    expect(inboxSeen([], snapshot, now)).toEqual({ entries: [], waiting: 0, overdue: false });
  });
});
