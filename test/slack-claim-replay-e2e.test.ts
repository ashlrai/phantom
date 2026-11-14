/**
 * Acceptance item 4, end to end through the real modules: a signed Slack peer
 * request lands once in the bus inbox, replays do not duplicate it, one owner
 * holds the durable claim through to a completed receipt, and the same text
 * arriving over iMessage merges instead of creating a second work item.
 * Fixtures are plainly fake; the helpers are copied from slack-bus-ingress.test.ts.
 */
import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSlackBusIngress, type SlackBusIngressPolicy, type SlackEventRequest } from '../src/core/comms/slack-bus-ingress.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import {
  CROSS_CHANNEL_WINDOW_MS, decideCrossChannelMerge, type RecentInboxEntry,
} from '../src/core/fleet/cross-channel-dedupe.js';

const NOW = 1_793_925_600_000;
const SECRET = 'fake-signing-secret-for-tests';
const TEXT = 'Fake request: summarize the offline test evidence.';

const policy = (): SlackBusIngressPolicy => ({
  enabled: true, workspaceId: 'T0FAKEWS', receiverAppId: 'A0FAKEAPP', selfBotId: 'B0FAKESELF', selfUserId: 'U0FAKESELF',
  bridgeId: 'fake-local-bridge',
  peers: [{ botId: 'B0FAKEPEER', appId: 'A0FAKEPEER', userId: 'U0FAKEPEER', agentId: 'fake-peer-agent', vendor: 'fake', bridgeId: 'fake-remote-bridge' }],
  routes: [{ channelId: 'C0FAKECH', audience: 'fleet-coordination', mode: 'peer', peerBotIds: ['B0FAKEPEER'], recipients: ['fake-recipient'] }],
});
const payload = () => ({
  type: 'event_callback', team_id: 'T0FAKEWS', api_app_id: 'A0FAKEAPP', event_id: 'Ev0FAKEREQUEST', is_ext_shared_channel: false,
  event: {
    type: 'message', subtype: 'bot_message', channel: 'C0FAKECH', bot_id: 'B0FAKEPEER', app_id: 'A0FAKEPEER', user: 'U0FAKEPEER',
    ts: '1793925600.000001', text: TEXT,
    metadata: { event_type: 'phantom_agent_message', event_payload: {
      version: 1, kind: 'request', message_id: 'fake-message-1', origin_bridge: 'fake-remote-bridge',
      hop_count: 1, visited_bridges: ['fake-remote-bridge'],
    } },
  },
});
function signed(body: unknown = payload(), timestamp = String(NOW / 1000)): SlackEventRequest {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const signature = `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  return { rawBody, timestamp, signature };
}

let root: string;
beforeEach(() => {
  // mkdtemp creates the directory 0700; chmod pins it regardless of umask.
  root = mkdtempSync(join(tmpdir(), 'slack-claim-replay-'));
  chmodSync(root, 0o700);
  // The claim module reads Date.now() directly; pin it to the fake clock.
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

function receive(now = NOW) {
  return createSlackBusIngress({ root, readPolicy: policy, readSigningSecret: () => SECRET, now: () => now });
}
function inbox() {
  const page = listBusInboxAfter(0, 100, { root, now: () => NOW });
  expect(page.status).toBe('ok');
  return page.status === 'ok' ? page.messages : [];
}

describe('Slack replay and durable claim: no duplicate work', () => {
  it('traces one request through ingress, claim and completion, and merges the iMessage copy', () => {
    // 1-2. First delivery persists exactly one envelope.
    expect(receive()(signed())).toEqual({ status: 'accepted', reason: 'persisted-locally', posted: 1, duplicates: 0, sendAuthorized: false });
    const [first] = inbox();
    expect(inbox()).toHaveLength(1);
    const id = first!.envelope.id;
    expect(id).toMatch(/^slack:[0-9a-f]{64}$/);

    // 3. Byte-identical redelivery is a duplicate.
    expect(receive()(signed())).toMatchObject({ status: 'accepted', posted: 0, duplicates: 1 });
    expect(inbox()).toHaveLength(1);

    // 4. Same event_id, freshly signed delivery timestamp inside the window.
    const later = NOW + 30_000;
    expect(receive(later)(signed(payload(), String(later / 1000)))).toMatchObject({ status: 'accepted', posted: 0, duplicates: 1 });
    expect(inbox()).toHaveLength(1);
    expect(inbox()[0]!.receivedAt).toBe(NOW);

    // 5. One owner wins; the other conflicts; completion is final.
    const a = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-a', leaseMs: 60_000, root });
    expect(a.status).toBe('acquired');
    expect(a.token).toMatch(/^[a-f0-9]{64}$/);
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-b', leaseMs: 60_000, root }).status).toBe('conflict');
    expect(mutateBusWorkClaim({ action: 'complete', id, token: a.token, root }).status).toBe('completed');
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-b', leaseMs: 60_000, root }).status).toBe('completed');
    expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-a', leaseMs: 60_000, root }).status).toBe('completed');

    const inspected = inspectBusWorkClaims(root);
    expect(inspected.source).toBe('available');
    expect(inspected.claims).toHaveLength(1);
    expect(inspected.claims[0]).toMatchObject({ id, owner: 'fake-owner-a', completedAt: NOW });
    expect(inspected.claims[0]).not.toHaveProperty('token');
    expect(JSON.stringify(inspected)).not.toContain(a.token!);

    // A replay after completion still adds no envelope and so no new work item.
    expect(receive(later)(signed(payload(), String(later / 1000)))).toMatchObject({ posted: 0, duplicates: 1 });
    expect(inbox()).toHaveLength(1);

    // 6. The same text over iMessage inside the window merges; past it, it is new.
    const slackEntry: RecentInboxEntry = { id, senderId: 'fake-sender', text: TEXT, receivedAt: NOW, channels: ['slack'] };
    const imessage = (receivedAt: number) => ({ text: `  ${TEXT.toUpperCase()}\n`, channel: 'imessage', senderId: 'fake-sender', receivedAt });
    expect(decideCrossChannelMerge(imessage(NOW + 60_000), [slackEntry])).toEqual({ action: 'merge', entryId: id, addSource: 'imessage' });
    expect(decideCrossChannelMerge(imessage(NOW + CROSS_CHANNEL_WINDOW_MS + 1), [slackEntry])).toEqual({ action: 'append' });
  }, 60_000);
});
