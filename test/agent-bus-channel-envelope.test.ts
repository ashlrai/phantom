import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateBusEnvelope, parseBusEnvelope, BUS_CHANNELS } from '../src/core/fleet/bus-envelope.js';

const legacy = { id: 'id', from: 'agent', to: 'team', priority: 'P1', ttl: 10, body: null };
const channel = { ...legacy, channel: 'slack', channel_ref: 'opaque chat id', sender: { agent_id: 'agent', vendor: 'local', human: false, team: true }, external: false, origin_bridge: 'bridge-1' };

describe('channel bus envelope', () => {
  it('preserves legacy and channel messages across the wire', () => {
    expect(validateBusEnvelope(legacy).ok).toBe(true);
    const result = validateBusEnvelope(channel);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected valid message');
    expect(parseBusEnvelope(result.json)).toEqual(result);
    expect(result.value).toEqual(channel);
  });
  it.each(BUS_CHANNELS)('accepts channel %s', (kind) => {
    expect(validateBusEnvelope({ ...channel, channel: kind }).ok).toBe(true);
  });
  it('accepts an absent origin for messages not posted by a bridge', () => {
    const { origin_bridge: _origin, ...message } = channel;
    expect(validateBusEnvelope(message).ok).toBe(true);
  });
  it.each(['channel', 'channel_ref', 'sender', 'external'])('requires %s when metadata is present', (key) => {
    const message: Record<string, unknown> = { ...channel };
    delete message[key];
    expect(validateBusEnvelope(message).ok).toBe(false);
  });
  it.each([
    { channel: 'unknown' }, { channel_ref: '' }, { channel_ref: 'chat\nother' },
    { sender: { ...channel.sender, human: 'yes' } }, { sender: { ...channel.sender, extra: true } },
    { sender: { ...channel.sender, team: false }, external: false }, { external: 'false' },
    { origin_bridge: '' }, { origin_bridge: 'bridge\n' },
  ])('rejects invalid channel metadata %#', (patch) => {
    expect(validateBusEnvelope({ ...channel, ...patch }).ok).toBe(false);
  });
  it('rejects untrusted metadata getters without calling them', () => {
    let called = false;
    const sender = { ...channel.sender, get team() { called = true; return true; } };
    expect(validateBusEnvelope({ ...channel, sender }).ok).toBe(false);
    expect(called).toBe(false);
  });
  it('publishes a separate schema with the same required metadata group', () => {
    const schema = JSON.parse(readFileSync(new URL('../schema/bus.channel.v2.schema.json', import.meta.url), 'utf8'));
    expect(schema.properties.channel.enum).toEqual([...BUS_CHANNELS]);
    expect(schema.dependencies.origin_bridge).toEqual(['channel', 'channel_ref', 'sender', 'external']);
  });
});
