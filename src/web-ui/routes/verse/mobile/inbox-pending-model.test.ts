import { describe, expect, it } from 'vitest';
import { inboxPending } from './inbox-pending-model.js';
import type { InboxSeen } from './inbox-seen-model.js';

const now = Date.parse('2026-10-31T04:24:00Z');
const seen: InboxSeen = { ackLabel: 'Seen', tone: 'ok' };
const waiting: InboxSeen = { ackLabel: 'Waiting', tone: 'neutral' };

describe('inboxPending', () => {
  it('counts messages awaiting a pass and shows its ETA', () => {
    expect(inboxPending([waiting, seen, waiting], { generatedAt: '2026-10-31T04:24:00Z', leaders: [{ ageSeconds: 480 }] }, now))
      .toEqual({ waiting: 2, text: '2 waiting for a leader pass · next due in 7 min', tone: 'warning' });
  });
  it('reports when all messages have been seen', () => {
    expect(inboxPending([seen], undefined, now)).toEqual({ waiting: 0, text: 'All messages seen by a leader', tone: 'ok' });
  });
  it('marks a pass over 30 minutes overdue as danger', () => {
    expect(inboxPending([waiting], { generatedAt: '2026-10-31T04:24:00Z', leaders: [{ ageSeconds: 55 * 60 }] }, now).tone).toBe('danger');
  });
});
