import { describe, expect, it } from 'vitest';
import type { AgentBusReceipt } from '../fleet-bus/agent-bus-queries.js';
import { mirrorByChannel } from './channel-bus-mirror.js';
import { channelKey, channelLabel, channelSetupHint, IMESSAGE_DOCTOR_USAGE, rollupChannels } from './fleet-channels-model.js';

const now = Date.parse('2026-11-04T12:00:00Z');
const entry = (source: string, at = '2026-11-04T11:59:00Z') => ({ source, at, text: 'test message' });

describe('iMessage channel', () => {
  it('normalizes iMessage and SMS first while retaining other channel mappings', () => {
    for (const source of ['imessage', 'iMessage', 'sms', 'telegram sms']) expect(channelKey(source)).toBe('imessage');
    expect(channelLabel('imessage')).toBe('iMessage');
    for (const source of ['telegram', 'email', 'page', 'mobile', 'desktop'] as const) expect(channelKey(source)).toBe(source);
  });

  it('rolls up iMessage counts and last seen without counting them as other', () => {
    const rows = rollupChannels({ inbox: [entry('imessage'), entry('iMessage', '2026-11-04T11:58:00Z'), entry('unknown')] }, now)!.rows;
    expect(rows.find(row => row.key === 'imessage')).toMatchObject({ total: 2, lastHour: 2, last24h: 2, lastAt: '2026-11-04T11:59:00Z' });
    expect(rows.find(row => row.key === 'other')?.total).toBe(1);
  });

  it('offers the doctor command only while silent', () => {
    const silent = rollupChannels({ inbox: [] }, now)!.rows.find(row => row.key === 'imessage')!;
    expect(channelSetupHint('imessage', silent)).toEqual({
      command: IMESSAGE_DOCTOR_USAGE,
      runCommand: 'phm imessage doctor',
      copyWhat: 'the iMessage doctor command',
      detail: 'Checks Full Disk Access for Messages and the allowlist. Then `phm imessage poll --apply` baselines and starts taking texts from your own handle.',
    });
    expect(IMESSAGE_DOCTOR_USAGE).toBe('usage: phm imessage doctor');
    expect(channelSetupHint('imessage', { ...silent, total: 1 })).toBeNull();
  });

  it('keeps iMessage local even if a bus receipt claims a mirror', () => {
    const receipt: AgentBusReceipt = { cursor: 1, receivedAt: now, envelope: { id: 'test', from: 'mason', to: 'leaders', priority: 'P0', ttl: 1000, body: { kind: 'interjection', channel: 'imessage' } } };
    expect(mirrorByChannel([entry('imessage')], [receipt], now).get('imessage')).toMatchObject({ inbox: 1, mirrored: 0, tone: 'none', text: 'kept local: 1 in the last hour, not mirrored to the bus' });
  });
});
