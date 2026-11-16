import { describe, expect, it } from 'vitest';
import { channelHealthLine, narrowChannelHealth, type ChannelHealthRow } from './channel-health-model.js';

const NOW = Date.parse('2026-11-13T12:00:00Z');
const row = (over: Partial<ChannelHealthRow> = {}): ChannelHealthRow => ({
  channel: 'slack', configured: true, processAlive: true, runtimeHost: 'h', lastInboundAt: null,
  lastReplyAt: '2026-11-13T11:56:00Z', unansweredCount: 0, state: 'LIVE', missing: [], ...over,
});
const payload = (channels: unknown[], extra: object = {}) => ({ channelHealth: { schemaVersion: 1, asOf: '2026-11-13T12:00:00Z', channels, ...extra } });

describe('narrowChannelHealth', () => {
  it('reads a full payload', () => {
    const v = narrowChannelHealth(payload([row(), row({ channel: 'imessage', state: 'BLOCKED', missing: ['bridge process'], unansweredCount: 2 })]));
    expect(v).toMatchObject({ available: true, asOf: '2026-11-13T12:00:00Z' });
    if (v.available) { expect(v.channels).toHaveLength(2); expect(v.channels[1]).toMatchObject({ state: 'BLOCKED', unansweredCount: 2 }); }
  });
  it('is unavailable when the field is absent or input is junk', () => {
    expect(narrowChannelHealth({})).toEqual({ available: false });
    expect(narrowChannelHealth(null)).toEqual({ available: false });
    expect(narrowChannelHealth('x')).toEqual({ available: false });
  });
  it('is unavailable when error is set', () => {
    expect(narrowChannelHealth(payload([row()], { error: 'boom' }))).toEqual({ available: false });
  });
  it('maps unknown state strings to UNKNOWN and drops bad rows', () => {
    const v = narrowChannelHealth(payload([{ ...row(), state: 'WEIRD' }, { channel: 'sms' }, 7]));
    expect(v.available && v.channels.map(c => c.state)).toEqual(['UNKNOWN']);
  });
  it('narrows processAlive to unknown', () => {
    const v = narrowChannelHealth(payload([{ ...row(), processAlive: 'maybe' }]));
    expect(v.available && v.channels[0]?.processAlive).toBe('unknown');
  });
});

describe('channelHealthLine', () => {
  it('shows last reply age when LIVE', () => expect(channelHealthLine(row(), NOW)).toBe('Slack LIVE, last reply 4m ago'));
  it('lists missing items', () => {
    expect(channelHealthLine(row({ channel: 'imessage', state: 'BLOCKED', missing: ['bridge process', 'config.imessage'] }), NOW))
      .toBe('iMessage BLOCKED: missing bridge process, config.imessage');
  });
  it('flags unknown process state when nothing is listed missing', () => {
    expect(channelHealthLine(row({ state: 'UNKNOWN', processAlive: 'unknown' }), NOW)).toBe('Slack UNKNOWN: process state unknown');
  });
});
