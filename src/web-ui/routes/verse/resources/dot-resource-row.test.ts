import { describe, expect, it } from 'vitest';
import type { CommsStatus } from '../fleet-inbox/comms-status-model.js';
import { DOT_NO_READING, dotResourceRow } from './dot-resource-row.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function status(over: { lastAckAt?: string | null; teammate?: CommsStatus['teammate'] } = {}): CommsStatus {
  const lastAckAt = over.lastAckAt === undefined ? minutesAgo(12) : over.lastAckAt;
  return {
    generatedAt: minutesAgo(0),
    imessage: { configuration: { state: 'configured', reason: '' }, chatDb: { state: 'readable', reason: '' }, cursor: { state: 'present', reason: '' },
      ackSource: 'healthy', lastAckAt, acks24h: 3, nextStep: null },
    teammate: over.teammate === undefined
      ? { windowHours: 24, targetMinutes: 5, texts: 4, answered: 3, unanswered: 2, medianMinutes: 7.5, withinTarget: 2, oldestUnanswered: { ageMinutes: 20 }, sourceState: 'healthy' }
      : over.teammate,
    teammateSource: 'healthy', drafts: null, emailOutbox: null, sources: { drafts: 'healthy', emailOutbox: 'healthy' },
  };
}

describe('dotResourceRow', () => {
  it('is active with a recent reply, and carries the fixed identity text', () => {
    expect(dotResourceRow(status(), NOW)).toMatchObject({
      label: 'Dot (Ashlr.)', model: 'Astra 6', usageNote: 'own usage, not plan usage',
      lastReplyAgo: '12m ago', medianReplyMinutes: 7.5, waitingCount: 2, state: 'active',
    });
  });

  it('is quiet when the last reply is older than an hour', () => {
    expect(dotResourceRow(status({ lastAckAt: minutesAgo(180) }), NOW)).toMatchObject({ state: 'quiet', lastReplyAgo: '3h ago' });
  });

  it('reads a real zero waiting count as 0, not missing', () => {
    const t = { windowHours: 24, targetMinutes: 5, texts: 1, answered: 1, unanswered: 0, medianMinutes: 2, withinTarget: 1, oldestUnanswered: null, sourceState: 'healthy' } as const;
    expect(dotResourceRow(status({ teammate: t }), NOW).waitingCount).toBe(0);
  });

  it.each([
    ['no status read', null],
    ['no reply on record', status({ lastAckAt: null, teammate: null })],
    ['unparseable reply time', status({ lastAckAt: 'not-a-date' })],
  ])('is unknown with %s and shows no number', (_name, input) => {
    const row = dotResourceRow(input, NOW);
    expect(row.state).toBe('unknown');
    expect(row.lastReplyAgo).toBe(DOT_NO_READING);
    expect(row.lastReplyAgo).not.toMatch(/\d/);
    if (input === null || input.teammate === null) {
      expect(row.medianReplyMinutes).toBeNull();
      expect(row.waitingCount).toBeNull();
    }
  });

  it('drops reply speed and waiting count when the teammate log is not healthy', () => {
    const t = { windowHours: 24, targetMinutes: 5, texts: 0, answered: 0, unanswered: 0, medianMinutes: null, withinTarget: 0, oldestUnanswered: null, sourceState: 'degraded' } as const;
    expect(dotResourceRow(status({ teammate: t }), NOW)).toMatchObject({ medianReplyMinutes: null, waitingCount: null, state: 'active' });
  });
});
