import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { readReplyState } from '../src/core/comms/reply-state.js';

type Channel = 'slack' | 'imessage' | 'bus' | undefined;
const now = Date.parse('2026-11-25T12:00:00Z');

function check(requestChannel: Channel, replyChannel: Channel, kind: 'verified' | 'blocked', accepted: boolean): void {
  const root = mkdtempSync(join(tmpdir(), 'reply-proof-channel-'));
  try {
    const post = (id: string, channel: Channel, body: BusEnvelope['body'], at: number) => {
      const envelope: BusEnvelope = { id, from: 'fake-peer', to: 'fake-lane', priority: 'P1', ttl: 10_000_000, body,
        ...(channel ? { channel, channel_ref: `fake-${id}`,
          sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true }, external: false } : {}) };
      expect(appendBusInbox(envelope, { root, now: () => at }).status).toBe('posted');
    };
    post('fake-request', requestChannel, { kind: 'work' }, now - 2_000);
    post('fake-reply', replyChannel, { inReplyTo: 'fake-request',
      ...(kind === 'verified' ? { verified: { tests: 'passed' } } : { blocked: { dependency: 'review' } }) }, now - 1_000);
    const { evidence, sources } = collectBusWorkItemEvidence('fake-request', { root, now });
    expect(sources.inbox).toBe('found');
    expect(Boolean(kind === 'verified' ? evidence.verified : evidence.blocker)).toBe(accepted);
    expect(readReplyState('fake-request', { root, now }).state).toBe(accepted ? kind.toUpperCase() : 'RECEIVED');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

it.each(['verified', 'blocked'] as const)('partitions %s evidence by transport', kind => {
  for (const [request, reply] of [['slack', 'imessage'], ['imessage', 'slack'], ['slack', 'bus'], [undefined, 'slack']] as const) {
    check(request, reply, kind, false);
  }
  for (const [request, reply] of [['slack', 'slack'], ['imessage', 'imessage'], ['bus', 'bus'],
    ['bus', undefined], [undefined, 'bus'], [undefined, undefined]] as const) {
    check(request, reply, kind, true);
  }
});
