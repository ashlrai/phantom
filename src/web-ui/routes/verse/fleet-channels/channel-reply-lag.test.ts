import { describe, expect, it } from 'vitest';
import { channelsWaiting, deriveChannelReplyLag, REPLY_LAG_WARN_MS, replyLagForRow, type ReplyLagMessage } from './channel-reply-lag.js';

const now = Date.parse('2026-11-10T12:00:00Z');
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const inbound = (channel: string, minutesAgo: number, text = 'fake message'): ReplyLagMessage =>
  ({ channel, direction: 'inbound', at: at(minutesAgo), text });
const outbound = (channel: string, minutesAgo: number, text = 'fake reply'): ReplyLagMessage =>
  ({ channel, direction: 'outbound', at: at(minutesAgo), text });

describe('deriveChannelReplyLag', () => {
  it('answers with the first Leader message on the same channel after Mason\'s last', () => {
    const lags = deriveChannelReplyLag([
      inbound('slack', 20, 'Phantom status'),
      outbound('slack', 12),
    ], now);
    const lag = lags.get('slack');
    expect(lag).toMatchObject({ channel: 'slack', lastFromMasonAt: at(20), replyAt: at(12), waitingMs: null, overdue: false });
  });

  it('flags nothing when Mason is unanswered under ten minutes', () => {
    const lag = deriveChannelReplyLag([inbound('telegram', 9)], now).get('telegram');
    expect(lag).toMatchObject({ replyAt: null, waitingMs: 9 * 60_000, overdue: false });
  });

  it('flags a channel unanswered over ten minutes as overdue', () => {
    const lag = deriveChannelReplyLag([inbound('telegram', 15, 'Phantom status')], now).get('telegram');
    expect(lag).toMatchObject({ replyAt: null, waitingMs: 15 * 60_000, overdue: true, preview: 'Phantom status' });
  });

  it('does not count a reply on a different channel', () => {
    const lags = deriveChannelReplyLag([
      inbound('slack', 15),
      outbound('telegram', 14),
    ], now);
    expect(lags.get('slack')).toMatchObject({ replyAt: null, overdue: true });
    expect(lags.has('telegram')).toBe(false);
  });

  it('still waits when several Mason messages in a row follow the last reply', () => {
    const lags = deriveChannelReplyLag([
      inbound('imessage', 30, 'first fake message'),
      outbound('imessage', 29, 'fake earlier reply'),
      inbound('imessage', 20, 'second fake message'),
      inbound('imessage', 15, 'latest fake message'),
    ], now);
    expect(lags.get('imessage')).toMatchObject({ lastFromMasonAt: at(15), preview: 'latest fake message', replyAt: null, waitingMs: 15 * 60_000, overdue: true });
  });

  it('counts the reply that follows the newest of several Mason messages in a row', () => {
    const lags = deriveChannelReplyLag([
      inbound('email', 30, 'first fake message'),
      inbound('email', 25, 'second fake message'),
      outbound('email', 20),
    ], now);
    expect(lags.get('email')).toMatchObject({ lastFromMasonAt: at(25), replyAt: at(20), waitingMs: null });
  });

  it('keeps the newest Mason message per channel and truncates its preview to 80 characters', () => {
    const long = 'x'.repeat(100);
    const lag = deriveChannelReplyLag([
      inbound('desktop', 10, 'older fake message'),
      inbound('desktop', 5, long),
    ], now).get('desktop');
    expect(lag?.preview.length).toBeLessThanOrEqual(80);
    expect(lag?.preview.endsWith('…')).toBe(true);
  });

  it('ignores rows it cannot place on a clock and channels Mason never used', () => {
    const lags = deriveChannelReplyLag([
      { channel: 'slack', direction: 'inbound', at: 'not a date', text: 'fake bad clock' },
      outbound('slack', 1),
      outbound('email', 1),
    ], now);
    expect(lags.size).toBe(0);
  });
});

describe('replyLagForRow and channelsWaiting', () => {
  it('maps raw owner channels onto their pane rows and folds Slack into Other', () => {
    const lags = deriveChannelReplyLag([
      inbound('telegram', 5),
      inbound('slack', 15),
    ], now);
    expect(replyLagForRow(lags, 'telegram')?.channel).toBe('telegram');
    expect(replyLagForRow(lags, 'other')?.channel).toBe('slack');
    expect(replyLagForRow(lags, 'email')).toBeUndefined();
  });

  it('lets the folded Other row surface an overdue wait over a newer answered channel', () => {
    const lags = deriveChannelReplyLag([
      inbound('slack', 30),
      inbound('signal', 5),
      outbound('signal', 4),
    ], now);
    expect(replyLagForRow(lags, 'other')?.channel).toBe('slack');
  });

  it('counts each raw channel waiting past the warning age', () => {
    const lags = deriveChannelReplyLag([
      inbound('slack', REPLY_LAG_WARN_MS / 60_000 + 5),
      inbound('telegram', 60),
      inbound('email', 5),
      inbound('imessage', 30),
      outbound('imessage', 20),
    ], now);
    expect(channelsWaiting(lags)).toBe(2);
  });
});
