/** dotReplyAge: the pure model behind the Leader thread's Dot reply-age line. */
import { describe, expect, it } from 'vitest';
import { dotReplyAge, DOT_REPLY_LATE_MINUTES } from '../src/web-ui/routes/verse/leader-thread/DotReplyAge.model.js';

const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

describe('dotReplyAge', () => {
  it('answered when the outbound time covers the last inbound', () => {
    const view = dotReplyAge({ lastInboundAt: iso(NOW - 4 * 60_000), lastOutboundAt: iso(NOW - 1 * 60_000), answered: true, source: 'healthy' }, NOW);
    expect(view).toMatchObject({ bucket: 'answered', answered: true, ageMinutes: 4, text: 'Dot: last text 4 min ago, answered' });
  });

  it('is late at 11 minutes unanswered', () => {
    const view = dotReplyAge({ lastInboundAt: iso(NOW - 11 * 60_000), lastOutboundAt: null, answered: false, source: 'healthy' }, NOW);
    expect(view).toMatchObject({ bucket: 'late', answered: false, ageMinutes: 11, text: 'Dot: last text 11 min ago, NOT answered' });
  });

  it('is ok at 3 minutes unanswered', () => {
    const view = dotReplyAge({ lastInboundAt: iso(NOW - 3 * 60_000), lastOutboundAt: null, answered: false, source: 'healthy' }, NOW);
    expect(view).toMatchObject({ bucket: 'ok', answered: false, text: 'Dot: last text 3 min ago, NOT answered' });
  });

  it(`turns late exactly at ${DOT_REPLY_LATE_MINUTES} minutes`, () => {
    expect(dotReplyAge({ lastInboundAt: iso(NOW - DOT_REPLY_LATE_MINUTES * 60_000), source: 'healthy' }, NOW).bucket).toBe('late');
    expect(dotReplyAge({ lastInboundAt: iso(NOW - (DOT_REPLY_LATE_MINUTES - 1) * 60_000), source: 'healthy' }, NOW).bucket).toBe('ok');
  });

  it('is unanswered when the outbound time predates the last inbound', () => {
    const view = dotReplyAge({ lastInboundAt: iso(NOW - 5 * 60_000), lastOutboundAt: iso(NOW - 30 * 60_000), answered: false, source: 'healthy' }, NOW);
    expect(view).toMatchObject({ bucket: 'ok', answered: false });
  });

  it.each([
    ['missing source', { source: 'missing', lastInboundAt: null, lastOutboundAt: null, answered: null }, 'Dot: no iMessage record yet'],
    ['no inbound text', { source: 'healthy', lastInboundAt: null, answered: null }, 'Dot: no iMessage record yet'],
    ['route not landed', null, 'Dot: reply status unknown'],
    ['read failed', { source: 'unavailable' }, 'Dot: reply status unknown'],
    ['unparseable time', { source: 'healthy', lastInboundAt: 'not-a-time' }, 'Dot: reply status unknown'],
  ])('unknown: %s', (_name, read, text) => {
    expect(dotReplyAge(read as Parameters<typeof dotReplyAge>[0], NOW)).toMatchObject({ bucket: 'unknown', ageMinutes: null, text });
  });
});
