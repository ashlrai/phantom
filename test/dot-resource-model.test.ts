/**
 * RQ-PHX-DOTRESOURCEROW94: the Resources-drawer Dot card's pure model.
 * Every state is driven by fixtures and an injected clock; a missing fact is
 * never defaulted to a number, and no output field carries text content.
 */
import { describe, expect, it } from 'vitest';
import { readCommsStatus, type CommsStatus } from '../src/web-ui/routes/verse/fleet-inbox/comms-status-model.js';
import { DOT_NO_CONTACT, dotResourceFromStatus, dotResourceModel, type DotResourceInput } from '../src/web-ui/routes/verse/resources/dot-resource-model.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const input = (over: Partial<DotResourceInput> = {}): DotResourceInput => ({
  configured: true, lastInboundAt: minutesAgo(4), lastReplyAt: minutesAgo(1),
  pending: 0, oldestPendingMinutes: null, ...over,
});

function status(over: {
  configuration?: string; lastAckAt?: string | null; teammate?: CommsStatus['teammate'] | 'absent';
} = {}): CommsStatus {
  const teammate = over.teammate === 'absent' ? null : over.teammate === undefined ? {
    windowHours: 24, targetMinutes: 5, texts: 3, answered: 3, unanswered: 0, medianMinutes: 2,
    withinTarget: 3, oldestUnanswered: null, latestTextAt: minutesAgo(4), sourceState: 'healthy',
  } as const : over.teammate;
  return {
    generatedAt: minutesAgo(0),
    imessage: {
      configuration: { state: over.configuration ?? 'configured', reason: '' },
      chatDb: { state: 'readable', reason: '' }, cursor: { state: 'present', reason: '' },
      ackSource: 'ok', lastAckAt: over.lastAckAt === undefined ? minutesAgo(1) : over.lastAckAt,
      acks24h: 3, nextStep: null,
    },
    teammate,
    teammateSource: teammate === null ? 'missing' : teammate.sourceState,
    drafts: null, emailOutbox: null, sources: { drafts: 'healthy', emailOutbox: 'healthy' },
  };
}

describe('dotResourceModel', () => {
  it('is live on fresh contact and composes both age halves', () => {
    expect(dotResourceModel(input(), NOW)).toEqual({
      state: 'live', lastInboundAt: minutesAgo(4), lastReplyAt: minutesAgo(1),
      pending: 0, line: 'last from Dot 4m ago · last reply 1m ago',
    });
  });

  it('is waiting-on-fleet when the newest inbound is past 5m and the last reply is older', () => {
    expect(dotResourceModel(input({ lastInboundAt: minutesAgo(10), lastReplyAt: minutesAgo(30), pending: 1, oldestPendingMinutes: 10 }), NOW).state)
      .toBe('waiting-on-fleet');
  });

  it('is waiting-on-fleet when an answered-marker gap says so even while the newest inbound is fresh', () => {
    // A 2m "ack" text sits on top of a 20m unanswered request.
    const view = dotResourceModel(input({ lastInboundAt: minutesAgo(2), lastReplyAt: minutesAgo(1), pending: 1, oldestPendingMinutes: 20 }), NOW);
    expect(view).toMatchObject({ state: 'waiting-on-fleet', pending: 1 });
  });

  it.each([
    ['an unanswered inbound still inside the 5m grace', input({ lastInboundAt: minutesAgo(3), lastReplyAt: minutesAgo(30), pending: 1, oldestPendingMinutes: 3 }), 'live'],
    ['last contact older than the live window', input({ lastInboundAt: minutesAgo(200), lastReplyAt: minutesAgo(180) }), 'quiet'],
    ['configured with no contact on record', input({ lastInboundAt: null, lastReplyAt: null }), 'quiet'],
    ['a disabled transport, whatever the data says', input({ configured: false }), 'not-configured'],
    ['nothing readable at all', input({ configured: null, lastInboundAt: null, lastReplyAt: null, pending: null }), 'unknown'],
    ['a future contact (clock skew)', input({ lastInboundAt: new Date(NOW + 60_000).toISOString(), lastReplyAt: null }), 'live'],
  ])('is %s', (_name, fixture, state) => {
    expect(dotResourceModel(fixture, NOW).state).toBe(state);
  });

  it('drops a half of the line when its time is missing and keeps unparseable times out', () => {
    expect(dotResourceModel(input({ lastInboundAt: null, lastReplyAt: 'not-a-date' }), NOW))
      .toMatchObject({ state: 'quiet', lastReplyAt: null, line: DOT_NO_CONTACT });
    expect(dotResourceModel(input({ lastInboundAt: 'garbage' }), NOW).line).toBe('last reply 1m ago');
  });

  it('carries only the five view fields and never any text content', () => {
    const view = dotResourceModel(input(), NOW);
    expect(Object.keys(view).sort()).toEqual(['lastInboundAt', 'lastReplyAt', 'line', 'pending', 'state']);
    for (const key of ['text', 'handle', 'sender', 'senderId', 'chatId', 'rowid']) expect(view).not.toHaveProperty(key);
  });
});

describe('dotResourceFromStatus', () => {
  it.each([
    ['a healthy read', status(), { state: 'live', lastInboundAt: minutesAgo(4), lastReplyAt: minutesAgo(1), pending: 0 }],
    ['a disabled path check', status({ configuration: 'disabled' }), { state: 'not-configured' }],
    ['a failed status read', null, { state: 'unknown' }],
    ['every section unreadable', { ...status({ configuration: 'unknown', lastAckAt: null, teammate: 'absent' }), imessage: null }, { state: 'unknown' }],
  ])('maps %s', (_name, fixture, view) => {
    expect(dotResourceFromStatus(fixture, NOW)).toMatchObject(view);
  });

  it('contributes nothing from a teammate log that is not healthy', () => {
    const teammate = {
      windowHours: 24, targetMinutes: 5, texts: 2, answered: 1, unanswered: 1, medianMinutes: 4,
      withinTarget: 1, oldestUnanswered: { ageMinutes: 30 }, latestTextAt: minutesAgo(30), sourceState: 'degraded',
    } as const;
    expect(dotResourceFromStatus(status({ teammate }), NOW))
      .toMatchObject({ state: 'live', pending: null, lastInboundAt: null, line: 'last reply 1m ago' });
  });

  it('tolerates an older server that sends no latestTextAt, through the real reader', () => {
    const raw = status({ lastAckAt: minutesAgo(1) }) as unknown as Record<string, unknown>;
    raw.teammate = {
      windowHours: 24, targetMinutes: 5, texts: 2, answered: 2, unanswered: 0,
      medianMinutes: 3, withinTarget: 2, oldestUnanswered: null, sourceState: 'healthy',
    };
    const parsed = readCommsStatus({ version: 1, ...raw });
    expect(parsed?.teammate?.latestTextAt).toBeNull();
    expect(dotResourceFromStatus(parsed, NOW)).toMatchObject({ state: 'live', lastInboundAt: null });
  });
});
