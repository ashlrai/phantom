/**
 * RQ-PHX-SLACKINGRESSUNIQUE450S: executable preservation evidence for the
 * original Slack peer bus-ingress module, created by PR #3697
 * (RQ-AGENTNET-SLACK-1, branch codex-bridge/RQ-AGENTNET-SLACK-1) and already on
 * master byte-for-byte (src/core/comms/slack-bus-ingress.ts blob 2d1fbf47736,
 * plus test and doc). Compared source: PRs #4275, #4280, #4519, #4885, #5312 —
 * none of them modified this module; their unique deltas lived in the
 * socket-mode leader path and are merged or preserved under other jobs
 * (258s/4275, 259s+312s/4280, 234s/4885, master regex+statusBrief/4519+5312).
 *
 * What is proven here through the real exported API and the real durable bus
 * store (never a mocked append mistaken for persistence):
 *  - a signed, policy-matching event posts one row per route recipient and the
 *    on-disk messages.json rows carry the untrusted coordination contract
 *    (kind slack-coordination, channel_ref workspace/channel/thread, the
 *    receiving bridge appended to visitedBridges, context retrieval denied);
 *  - an authenticated replay inside the admission window deduplicates to
 *    exactly-once across recreated ingress instances;
 *  - a signed event for a channel/audience outside the installed routes is
 *    refused before any durable write;
 *  - a failed append returns partial, never accepted, and the durable store
 *    matches the reported counts rather than claiming success;
 *  - every result carries sendAuthorized: false.
 *
 * Synthetic signing secret, ids, clocks and a temporary private bus root.
 * No network, credentials, real Slack messages or real home writes.
 */
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSlackBusIngress, type SlackBusIngressPolicy, type SlackBusIngressResult, type SlackEventRequest } from '../src/core/comms/slack-bus-ingress.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const NOW = 1_794_744_000_000;
const SECRET = 'synthetic-signing-key-for-offline-preservation-proof';
const policy = (): SlackBusIngressPolicy => ({
  enabled: true, workspaceId: 'T0FAKEWS', receiverAppId: 'A0FAKERCV', selfBotId: 'B0FAKESELF', selfUserId: 'U0FAKESELF', bridgeId: 'bridge-local',
  peers: [{ botId: 'B0FAKEPEER', appId: 'A0FAKEPEER', userId: 'U0FAKEPEER', agentId: 'review-agent', vendor: 'synthetic', bridgeId: 'bridge-remote' }],
  routes: [{ channelId: 'C0FAKEFLEET', audience: 'fleet-coordination', mode: 'group', peerBotIds: ['B0FAKEPEER'], recipients: ['agent-a', 'leader'] }],
});
const payload = () => ({
  type: 'event_callback', team_id: 'T0FAKEWS', api_app_id: 'A0FAKERCV', event_id: 'Ev0FAKE450S', is_ext_shared_channel: false,
  event: {
    type: 'message', subtype: 'bot_message', channel: 'C0FAKEFLEET', bot_id: 'B0FAKEPEER', app_id: 'A0FAKEPEER', user: 'U0FAKEPEER',
    ts: '1794744000.000001', thread_ts: '1794743900.000002', text: 'Synthetic peer decision: review the durable evidence.',
    metadata: { event_type: 'phantom_agent_message', event_payload: {
      version: 1, kind: 'decision', message_id: 'fake-message-450s', origin_bridge: 'bridge-remote',
      hop_count: 1, visited_bridges: ['bridge-remote'],
    } },
  },
});
function signed(body: unknown = payload(), timestamp = String(NOW / 1000)): SlackEventRequest {
  const rawBody = JSON.stringify(body);
  return { rawBody, timestamp, signature: `v0=${createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}` };
}
let home: string;
let root: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'slack-ingress-450s-')); root = join(home, 'private-bus'); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
const ingress = (p: SlackBusIngressPolicy | undefined = policy(), now = () => NOW, append?: typeof appendBusInbox) =>
  createSlackBusIngress({ root, readPolicy: () => p, readSigningSecret: () => SECRET, now, append });

/** Durable receipts read straight from the on-disk store, not the live API. */
function durableRows(): { cursor: number; receivedAt: number; envelope: BusEnvelope }[] {
  const file = join(root, 'bus-inbox', 'messages.json');
  if (!existsSync(file)) return [];
  const snapshot: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (typeof snapshot !== 'object' || snapshot === null || !Array.isArray((snapshot as { rows?: unknown }).rows)) throw new Error('unexpected store shape');
  return (snapshot as { rows: { cursor: number; receivedAt: number; envelope: BusEnvelope }[] }).rows;
}

describe('original peer ingress contract preserved on master', () => {
  it('persists one durable untrusted coordination row per route recipient', () => {
    const result = ingress()(signed());
    expect(result).toEqual({ status: 'accepted', reason: 'persisted-locally', posted: 2, duplicates: 0, sendAuthorized: false });
    const rows = durableRows();
    expect(rows.map(row => row.cursor)).toEqual([1, 2]);
    expect(rows.map(row => row.receivedAt)).toEqual([NOW, NOW]);
    expect(rows.map(row => row.envelope.to)).toEqual(['agent-a', 'leader']);
    for (const row of rows) {
      expect(row.envelope.id).toMatch(/^slack:[0-9a-f]{64}$/);
      expect(row.envelope).toMatchObject({
        from: 'review-agent', priority: 'P2', channel: 'slack', channel_ref: 'T0FAKEWS/C0FAKEFLEET/1794743900.000002',
        external: false, origin_bridge: 'bridge-remote', sender: { agent_id: 'review-agent', vendor: 'synthetic', human: false, team: true },
      });
      expect(row.envelope.body).toMatchObject({
        kind: 'slack-coordination', trust: 'untrusted', messageType: 'decision', routeMode: 'group',
        visitedBridges: ['bridge-remote', 'bridge-local'],
        context: { references: [], trust: 'unverified-reference-claims', retrievalAuthorized: false },
      });
    }
  });
  it('deduplicates an authenticated replay to exactly-once across instances', () => {
    expect(ingress()(signed()).posted).toBe(2);
    const replayed = ingress(policy(), () => NOW + 1000)(signed(payload(), String((NOW + 1000) / 1000)));
    expect(replayed).toMatchObject({ status: 'accepted', posted: 0, duplicates: 2, sendAuthorized: false });
    const rows = durableRows();
    expect(rows).toHaveLength(2);
    expect(rows.map(row => row.receivedAt)).toEqual([NOW, NOW]);
  });
  it('refuses a signed event outside the installed audience before any durable write', () => {
    for (const mutate of [
      (p: ReturnType<typeof payload>) => { p.event.channel = 'C0FAKEOTHER'; },
      (p: ReturnType<typeof payload>) => { p.event.bot_id = 'B0FAKEOTHER'; },
    ]) {
      const event = payload(); mutate(event);
      const result = ingress()(signed(event));
      expect(result).toMatchObject({ status: 'refused', reason: 'actor-or-channel-not-allowed', posted: 0, sendAuthorized: false });
      expect(existsSync(root)).toBe(false);
      expect(durableRows()).toEqual([]);
    }
  });
  it('reports an append failure as partial and durable receipts match the count', () => {
    let calls = 0;
    const append: typeof appendBusInbox = (envelope, options) => {
      if (++calls === 2) throw new Error('synthetic append failure');
      return appendBusInbox(envelope, options);
    };
    expect(ingress(policy(), () => NOW, append)(signed())).toMatchObject({ status: 'partial', reason: 'storage-unconfirmed', posted: 1 });
    expect(durableRows().map(row => row.envelope.to)).toEqual(['agent-a']);
    expect(ingress()(signed())).toMatchObject({ status: 'accepted', posted: 1, duplicates: 1 });
    expect(durableRows()).toHaveLength(2);
  });
  it('never reports success without a durable row and never authorizes a send', () => {
    const failing: typeof appendBusInbox = () => { throw new Error('synthetic append failure'); };
    const result: SlackBusIngressResult = ingress(policy(), () => NOW, failing)(signed());
    expect(result).toMatchObject({ status: 'partial', reason: 'storage-unconfirmed', posted: 0, sendAuthorized: false });
    expect(durableRows()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });
});
