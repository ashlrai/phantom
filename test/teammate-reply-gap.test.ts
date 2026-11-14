import { describe, expect, it } from 'vitest';
import { teammateReplyGap, type ReplyGapEvent } from '../src/core/comms/teammate-reply-gap.js';

const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);
const min = (n: number) => NOW - n * 60_000;
const ev = (direction: ReplyGapEvent['direction'], at: number): ReplyGapEvent => ({ teammate: 'Ashlr.', direction, at });

describe('teammateReplyGap', () => {
  it('is ok inside the warn window', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(2))], NOW);
    expect(gap).toMatchObject({ teammate: 'Ashlr.', unansweredCount: 1, oldestUnansweredMs: 120_000, state: 'ok' });
  });
  it('is late at 6 minutes and counts every waiting text', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(6)), ev('inbound', min(1))], NOW);
    expect(gap).toMatchObject({ unansweredCount: 2, oldestUnansweredMs: 360_000, state: 'late', lastInboundAt: min(1), lastOutboundAt: null });
  });
  it('clears when an outbound follows the inbound', () => {
    const [gap] = teammateReplyGap([ev('inbound', min(20)), ev('outbound', min(15))], NOW);
    expect(gap).toMatchObject({ unansweredCount: 0, oldestUnansweredMs: 0, state: 'ok', lastOutboundAt: min(15) });
  });
  it('is unknown with no evidence source', () => {
    expect(teammateReplyGap(null, NOW).map(gap => gap.state)).toEqual(['unknown']);
  });
  it('returns metadata only', () => {
    const rows = teammateReplyGap([{ ...ev('inbound', min(9)), body: 'hi', phone: '+15555550100' } as ReplyGapEvent], NOW);
    expect(Object.keys(rows[0]!).sort()).toEqual(['lastInboundAt', 'lastOutboundAt', 'oldestUnansweredMs', 'state', 'teammate', 'unansweredCount']);
    expect(JSON.stringify(rows)).not.toMatch(/\+1555|"hi"|body|phone/);
  });
});
