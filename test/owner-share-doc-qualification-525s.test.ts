import { describe, expect, it } from 'vitest';
import { prepareOwnerChatShare } from '../src/core/agents/chat-owner-intent.js';
import { AGENT_REGISTRY_VERSION, stableAgentId } from '../src/core/agents/bus-identity.js';
import { ownerEnvelopeDigest, verifiedOwnerChat } from '../src/core/agents/chat-owner-receipts.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const now = 1_794_873_600_000;
function fixture() {
  return {
    sourceNamespace: 'imessage:fixture-account', physicalMessageId: 'fixture-message',
    receipt: { channel: 'imessage', verifiedSenderId: 'owner@example.test', receivedAt: new Date(now).toISOString(),
      body: JSON.stringify({ kind: 'agent-chat.share', channel: 'engineering', thread: 'run:one', text: 'Selected text' }) },
    configSource: '[mason]\nidentities=[{channel="imessage",id="owner@example.test"}]\n[team]\nidentities=[{channel="bus",id="agent:alice"}]',
    commsSource: 'confirmedByMason=true',
    registry: { version: AGENT_REGISTRY_VERSION, identities: [{ id: stableAgentId('alice'), handle: 'alice', displayName: 'Alice', aliases: [], runtimes: [], createdAt: 1 }], channels: [{ name: 'engineering', members: ['alice'], createdBy: 'alice', createdAt: 1 }] },
    now, paused: false, killed: false,
  };
}

describe('owner share source qualification', () => {
  it('requires explicit intent, provenance, recipient approval and an active gate', () => {
    const input = fixture();
    expect(prepareOwnerChatShare(input)).toMatchObject({ status: 'prepared', requiresVerifiedIngress: true, grantsExecutionAuthority: false });
    expect(prepareOwnerChatShare({ ...input, receipt: { ...input.receipt, body: 'Private message' } }).status).toBe('refused');
    expect(prepareOwnerChatShare({ ...input, physicalMessageId: '' }).status).toBe('refused');
    expect(prepareOwnerChatShare({ ...input, commsSource: 'confirmedByMason=false' }).status).toBe('refused');
    expect(prepareOwnerChatShare({ ...input, paused: true }).status).toBe('refused');
    expect(prepareOwnerChatShare({ ...input, killed: true }).status).toBe('refused');
  });
  it('recognizes only a matching accepted local receipt for its recipient', () => {
    const prepared = prepareOwnerChatShare(fixture());
    if (prepared.status !== 'prepared') throw new Error('fixture refused');
    const envelope: BusEnvelope = { id: prepared.messageId, from: 'owner:local', to: 'group:engineering:general', priority: 'P0', ttl: 1000,
      body: { kind: 'note', thread: prepared.thread, text: prepared.text }, channel: 'bus', channel_ref: 'group:engineering:general',
      sender: { agent_id: 'owner:local', vendor: 'phantom', human: true, team: true }, external: false, origin_bridge: 'agent-chat-owner' };
    const receipt = { id: prepared.messageId, recipients: prepared.recipientIds, contentDigest: prepared.contentDigest,
      envelopeDigest: ownerEnvelopeDigest(envelope), state: 'accepted' as const, cursor: 1, receivedAt: now };
    expect(verifiedOwnerChat(envelope, 1, [receipt], stableAgentId('alice'))).toBe(true);
    expect(verifiedOwnerChat(envelope, 1, [{ ...receipt, state: 'pending' }], stableAgentId('alice'))).toBe(false);
    expect(verifiedOwnerChat(envelope, 1, [receipt], stableAgentId('bob'))).toBe(false);
    expect(verifiedOwnerChat(envelope, 2, [receipt], stableAgentId('alice'))).toBe(false);
  });
});
