import { createHmac } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createSlackBusIngress, type SlackBusIngressPolicy } from '../src/core/comms/slack-bus-ingress.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims, mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';

const start = 1_793_925_600_000;
const secret = 'synthetic-slack-signing-material';
const policy: SlackBusIngressPolicy = {
  enabled: true, workspaceId: 'T0FAKEWS', receiverAppId: 'A0FAKEAPP', selfBotId: 'B0FAKESELF', selfUserId: 'U0FAKESELF',
  bridgeId: 'fake-local-bridge',
  peers: [{ botId: 'B0FAKEPEER', appId: 'A0FAKEPEER', userId: 'U0FAKEPEER', agentId: 'fake-peer-agent', vendor: 'fake', bridgeId: 'fake-remote-bridge' }],
  routes: [{ channelId: 'C0FAKECH', audience: 'fleet-coordination', mode: 'peer', peerBotIds: ['B0FAKEPEER'], recipients: ['fake-recipient'] }],
};
const rawBody = JSON.stringify({
  type: 'event_callback', team_id: 'T0FAKEWS', api_app_id: 'A0FAKEAPP', event_id: 'Ev0FAKEREQUEST', is_ext_shared_channel: false,
  event: {
    type: 'message', subtype: 'bot_message', channel: 'C0FAKECH', bot_id: 'B0FAKEPEER', app_id: 'A0FAKEPEER', user: 'U0FAKEPEER',
    ts: '1793925600.000001', text: 'Fake request: summarize offline evidence.',
    metadata: { event_type: 'phantom_agent_message', event_payload: {
      version: 1, kind: 'request', message_id: 'fake-message-1', origin_bridge: 'fake-remote-bridge',
      hop_count: 1, visited_bridges: ['fake-remote-bridge'],
    } },
  },
});

let root = '';
afterEach(() => { vi.restoreAllMocks(); if (root) rmSync(root, { recursive: true, force: true }); });

it('retains a single Slack receipt across restart, expiry, fenced takeover and completion', () => {
  root = mkdtempSync(join(tmpdir(), 'slack-owner-restart-'));
  chmodSync(root, 0o700);
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const reader = () => ({
    receive: createSlackBusIngress({ root, readPolicy: () => policy, readSigningSecret: () => secret, now: () => now }),
    inbox: () => listBusInboxAfter(0, 100, { root, now: () => now }),
  });
  const signed = () => {
    const timestamp = String(Math.floor(now / 1000));
    return { rawBody, timestamp, signature: `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}` };
  };
  let instance = reader();
  expect(instance.receive(signed())).toMatchObject({ status: 'accepted', posted: 1, duplicates: 0 });
  const firstPage = instance.inbox();
  expect(firstPage.status).toBe('ok');
  if (firstPage.status !== 'ok') throw new Error('Inbox unavailable');
  expect(firstPage.messages).toHaveLength(1);
  const receipt = firstPage.messages[0]!;
  const id = receipt.envelope.id;
  const a = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-a', leaseMs: 60_000, root });
  expect(a.status).toBe('acquired');
  expect(a.token).toMatch(/^[a-f0-9]{64}$/);

  instance = reader();
  expect(instance.receive(signed())).toMatchObject({ status: 'accepted', posted: 0, duplicates: 1 });
  expect(instance.inbox()).toMatchObject({ status: 'ok', messages: [receipt] });
  expect(inspectBusWorkClaims(root)).toMatchObject({ source: 'available', claims: [{ id, owner: 'fake-owner-a', completedAt: null }] });
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-b', leaseMs: 60_000, root }).status).toBe('conflict');

  now = a.leaseUntil! + 1;
  expect(now - receipt.receivedAt).toBeLessThan(receipt.envelope.ttl);
  const b = mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-b', leaseMs: 60_000, root });
  expect(b.status).toBe('acquired');
  expect(b.token).toMatch(/^[a-f0-9]{64}$/);
  expect(b.token).not.toBe(a.token);
  const current = inspectBusWorkClaims(root);
  expect(current).toMatchObject({ source: 'available', claims: [{ id, owner: 'fake-owner-b', completedAt: null }] });
  expect(current.claims).toHaveLength(1);
  for (const action of ['renew', 'release', 'complete'] as const) {
    expect(mutateBusWorkClaim({ action, id, token: a.token, root }).status).toBe('mismatched-token');
    expect(inspectBusWorkClaims(root)).toEqual(current);
  }
  expect(mutateBusWorkClaim({ action: 'complete', id, token: b.token, root }).status).toBe('completed');
  expect(mutateBusWorkClaim({ action: 'complete', id, token: b.token, root }).status).toBe('completed');
  const completed = inspectBusWorkClaims(root);
  expect(completed).toMatchObject({ source: 'available', claims: [{ id, owner: 'fake-owner-b', completedAt: now }] });
  expect(completed.claims).toHaveLength(1);
  expect(completed.claims[0]).not.toHaveProperty('token');
  expect(JSON.stringify(completed)).not.toContain(a.token!);
  expect(JSON.stringify(completed)).not.toContain(b.token!);

  now += 1000;
  instance = reader();
  expect(instance.receive(signed())).toMatchObject({ status: 'accepted', posted: 0, duplicates: 1 });
  expect(instance.inbox()).toMatchObject({ status: 'ok', messages: [{
    cursor: receipt.cursor, receivedAt: receipt.receivedAt,
    envelope: { id, ttl: receipt.envelope.ttl - (now - receipt.receivedAt) },
  }] });
  expect(inspectBusWorkClaims(root)).toEqual(completed);
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner-a', leaseMs: 60_000, root }).status).toBe('completed');
}, 60_000);
