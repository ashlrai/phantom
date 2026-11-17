import { describe, expect, it } from 'vitest';
import { prepareOwnerChatShare } from '../src/core/agents/chat-owner-intent.js';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';
import { AGENT_REGISTRY_VERSION, stableAgentId } from '../src/core/agents/bus-identity.js';
const now = 1794873600000;
function fixture() {
  return {
    sourceNamespace: 'fixture-account-database', physicalMessageId: 'imessage-row:42',
    receipt: { channel: 'imessage', verifiedSenderId: 'owner@example.test', receivedAt: new Date(now).toISOString(),
      dedupeKey: 'a'.repeat(64), body: JSON.stringify({ kind: 'agent-chat.share', channel: 'engineering', thread: 'run:one', text: 'Review the tests.' }) } as ChannelEnvelope,
    configSource: '[mason]\nidentities=[{channel="imessage",id="owner@example.test"}]\n[team]\nidentities=[{channel="bus",id="agent:alice"}]',
    commsSource: 'confirmedByMason=true',
    registry: { version: AGENT_REGISTRY_VERSION, identities: [{ id: stableAgentId('alice'), handle: 'alice', displayName: 'Alice', aliases: [], runtimes: [], createdAt: 1 }], channels: [{ name: 'engineering', members: ['alice'], createdBy: 'alice', createdAt: 1 }] },
    now, paused: false, killed: false,
  };
}
describe('isolated owner-share preparation, not ingress', () => {
  it('prepares only exact selected text and target without sender disclosure', () => {
    const input = fixture(), result = prepareOwnerChatShare(input);
    expect(result).toMatchObject({ status: 'prepared', channel: 'engineering', thread: 'run:one', text: 'Review the tests.', requiresVerifiedIngress: true, grantsExecutionAuthority: false });
    expect(JSON.stringify(result)).not.toContain('owner@example.test');
    expect(prepareOwnerChatShare(input)).toEqual(result);
  });
  it('does not elevate teammate labels or body claims', () => {
    const input = fixture(); input.receipt.verifiedSenderId = 'teammate@example.test';
    expect(prepareOwnerChatShare(input)).toMatchObject({ status: 'refused' });
    const forged = fixture(); forged.receipt.body = JSON.stringify({ ...JSON.parse(forged.receipt.body), verifiedSenderId: 'owner@example.test', human: true });
    expect(prepareOwnerChatShare(forged)).toMatchObject({ status: 'refused' });
  });
  it.each(['Private note, do not share.', 'share this with engineering', JSON.stringify({ kind: 'note', text: 'run:one' })])('never routes private prose: %s', body => {
    const input = fixture(); input.receipt.body = body;
    expect(prepareOwnerChatShare(input)).toMatchObject({ status: 'refused' });
  });
  it.each(['paused', 'killed'] as const)('honors %s', key => {
    const input = fixture(); input[key] = true;
    expect(prepareOwnerChatShare(input)).toEqual({ status: 'refused', reason: 'stopped' });
  });
  it('requires current approval for every channel member', () => {
    const input = fixture(); input.registry.channels[0]!.members.push('bob');
    input.registry.identities.push({ ...input.registry.identities[0]!, id: stableAgentId('bob'), handle: 'bob' });
    expect(prepareOwnerChatShare(input)).toMatchObject({ status: 'refused' });
    const unconfirmed = fixture(); unconfirmed.commsSource = 'confirmedByMason=false';
    expect(prepareOwnerChatShare(unconfirmed)).toMatchObject({ status: 'refused' });
  });
  it('rejects desktop labels and future receipts', () => {
    const input = fixture(); input.receipt.channel = 'desktop';
    expect(prepareOwnerChatShare(input)).toMatchObject({ status: 'refused' });
    const future = fixture(); future.receipt.receivedAt = new Date(now + 1).toISOString();
    expect(prepareOwnerChatShare(future)).toMatchObject({ status: 'refused' });
  });
  it('refuses secrets concealed by JSON Unicode escapes', () => {
    const input = fixture();
    const synthetic = String.fromCharCode(115, 107, 45) + 'a'.repeat(48);
    const escaped = [...synthetic].map(char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0')).join('');
    input.receipt.body = input.receipt.body.replace('Review the tests.', escaped);
    expect(prepareOwnerChatShare(input)).toEqual({ status: 'refused', reason: 'secret-shaped' });
  });
  it('keeps stable event identity beyond the receipt dedupe window', () => {
    const input = fixture(), original = prepareOwnerChatShare(input);
    input.now += 11 * 60_000; input.receipt.dedupeKey = 'b'.repeat(64);
    const replay = prepareOwnerChatShare(input);
    expect(original.status).toBe('prepared'); expect(replay.status).toBe('prepared');
    if (original.status !== 'prepared' || replay.status !== 'prepared') return;
    expect(replay.messageId).toBe(original.messageId);
    expect(replay.contentDigest).toBe(original.contentDigest);
    expect(replay.recheckPolicyBeforeCommit).toBe(true);
  });
  it.each(['physicalMessageId', 'sourceNamespace'] as const)('fails closed without trusted %s', key => {
    const input = fixture(); input[key] = '';
    expect(prepareOwnerChatShare(input)).toEqual({ status: 'refused', reason: 'missing-physical-identity' });
  });
  it('does not collide physical events across account/source namespaces', () => {
    const input = fixture(), first = prepareOwnerChatShare(input);
    input.sourceNamespace = 'other-account-database';
    const second = prepareOwnerChatShare(input);
    if (first.status !== 'prepared' || second.status !== 'prepared') throw new Error('fixture refused');
    expect(first.messageId).not.toBe(second.messageId);
  });
  it('rejects dangling registered members even when allowlisted', () => {
    const input = fixture(); input.registry.identities = [];
    expect(prepareOwnerChatShare(input)).toMatchObject({ status: 'refused' });
  });
  it('binds changed target to changed digest but preserves source request ID', () => {
    const input = fixture(), original = prepareOwnerChatShare(input);
    input.receipt.body = JSON.stringify({ ...JSON.parse(input.receipt.body), thread: 'run:two' });
    const changed = prepareOwnerChatShare(input);
    expect(original.status).toBe('prepared'); expect(changed.status).toBe('prepared');
    if (original.status !== 'prepared' || changed.status !== 'prepared') return;
    expect(changed.messageId).toBe(original.messageId);
    expect(changed.contentDigest).not.toBe(original.contentDigest);
  });
});
