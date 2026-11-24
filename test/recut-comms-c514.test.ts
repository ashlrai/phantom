import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlackApi, deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import type { SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const config: SlackBridgeConfig = {
  bridgeId: 'slack', teamId: 'T0FAKE', ownUserId: 'U0BOT', ownBotId: 'B0BOT',
  botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', appTokenRef: 'phm_SLACK_AGENTNET_APP_TOKEN',
  map: [{ topic: 'leaders', channel: 'D0LEADER' }],
};
const thread = '1793920000.000001';
const fallback = 'Status unavailable; please try again.';
const envelope: BusEnvelope = {
  id: 'recut-c514-fallback', from: 'leader', to: 'leaders', ttl: 60_000, priority: 'P1',
  body: { kind: 'note', text: `Leader: ${fallback}`, thread: `slack:T0FAKE:D0LEADER:${thread}` },
};

describe('C514 composer fallback delivery', () => {
  it.each([{}, { unfurl_links: true, unfurl_media: true }])('disables previews at the HTTP boundary for %j', async extra => {
    let posted: unknown;
    const request: typeof fetch = async (_url, init) => {
      posted = JSON.parse(String(init?.body));
      return Response.json({ ok: true, channel: 'D0LEADER', ts: '1793920002.000001' });
    };
    const call = createSlackApi({ config, resolveCredential: () => 'fake-slack-token', fetch: request });
    await call('chat.postMessage', { channel: 'D0LEADER', text: fallback, ...extra });
    expect(posted).toEqual({ channel: 'D0LEADER', text: fallback, unfurl_links: false, unfurl_media: false });
  });

  it('reconciles a minimal fallback after restart without reposting or changing its durable identity', async () => {
    const stateRoot = mkdtempSync(join(tmpdir(), 'recut-comms-c514-'));
    roots.push(stateRoot);
    let clientId = '';
    const call: SlackCall = vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: 'T0FAKE', user_id: 'U0BOT', bot_id: 'B0BOT' };
      if (method === 'conversations.info') return { channel: { id: 'D0LEADER', is_im: true, context_team_id: 'T0FAKE' } };
      if (method === 'conversations.members') return { members: ['U0BOT', 'U0OWNER'] };
      if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKE', is_bot: body.user === 'U0BOT' } };
      if (method === 'chat.postMessage') {
        clientId = String(body.client_msg_id);
        expect(body).toEqual({ channel: 'D0LEADER', thread_ts: thread, text: fallback, client_msg_id: clientId });
        throw new Error('synthetic lost response');
      }
      if (method === 'conversations.replies') return {
        messages: [{ client_msg_id: clientId, user: 'U0BOT', thread_ts: thread, ts: '1793920002.000001' }],
      };
      throw new Error('unexpected synthetic method');
    });
    const input = { config, stateRoot, call, teamIdentities: [{ channel: 'slack' as const, id: 'U0OWNER' }], confirmedByMason: true };
    expect(await deliverSlackEnvelope(envelope, { ...input, plainReply: true })).toMatchObject({ status: 'uncertain' });
    const attempted = readFileSync(join(stateRoot, 'messages.json'), 'utf8');
    expect(attempted).not.toContain(fallback);
    // A restarted drainer has no composer injection; the unchanged envelope
    // digest still binds reconciliation to the original physical send.
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'sent', reason: 'delivery-reconciled' });
    expect(await deliverSlackEnvelope(envelope, input)).toMatchObject({ status: 'duplicate' });
    expect(vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage')).toHaveLength(1);
    const sent = JSON.parse(readFileSync(join(stateRoot, 'messages.json'), 'utf8')).messages;
    expect(Object.values(sent)).toEqual([expect.objectContaining({ clientId, state: 'sent', ts: '1793920002.000001' })]);
  });
});
