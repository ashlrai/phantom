import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { createSlackLeaderAdapter, flushSlackLeaderReplies, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const owner = 'U0OWNER', bot = 'U0BOT', channel = 'D0LEADER', team = 'T0FAKE', thread = '1793920000.000001';
const messageTs = ['1793920001.000001', '1793920001.000002'];
const replyTs = ['1793920002.000001', '1793920002.000002'];
const config = `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`;
let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('two pending Slack status replies across restarts', { timeout: 60000 }, () => {
  it('reconciles only each request with its own exact receipt', async () => {
    root = mkdtempSync(join(tmpdir(), 'slack-pair-498s-'));
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), config, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const clientIds: string[] = [];
    let visible: number[] = [];
    const call: SlackCall = vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0BOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
      if (method === 'chat.postMessage') { clientIds.push(String(body.client_msg_id)); throw new Error('synthetic lost response'); }
      if (method === 'conversations.replies') return { messages: visible.map(i => ({ client_msg_id: clientIds[i], user: bot, thread_ts: thread, ts: replyTs[i] })) };
      throw new Error('unexpected synthetic method');
    });
    const events = messageTs.map((ts, i) => ({ type: 'events_api', envelope_id: `delivery-${i}`, payload: { team_id: team, event_id: `Ev-pair-${i}`, event: { type: 'message', user: owner, channel, ts, thread_ts: thread, text: 'Phantom status' } } }));
    const receive = async (event: typeof events[number]) => {
      const policy = readSlackDeliveryPolicy(options)!;
      const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: { ask: text => text === 'Phantom status', compose: async () => 'Synthetic status', fallback: 'unavailable' } });
      let routed: Awaited<ReturnType<typeof adapter.route>> | undefined;
      const handlers: Record<string, (event: { data?: unknown }) => void> = {};
      const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; }, send: vi.fn(), close: vi.fn() };
      await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot }, leaderAdapter: { ...adapter, route: async envelope => routed = await adapter.route(envelope) }, connect: () => socket });
      handlers.message!({ data: JSON.stringify(event) });
      await vi.waitFor(() => expect(routed).toBeDefined(), { timeout: 15000 });
      expect(routed).toMatchObject({ owned: true, durable: true });
      return await routed!.statusAnswer;
    };
    for (const event of events) expect(await receive(event)).toMatchObject({ answered: false });
    expect(clientIds).toHaveLength(2);
    expect(new Set(clientIds).size).toBe(2);
    const journal = readSlackJournal({ runsDir: options.runsDir });
    expect(journal.state).toBe('ok');
    const requests = messageTs.map(ts => journal.entries.find(row => row.messageTs === ts && row.decision === 'ingested')?.requestId);
    expect(requests.every(id => typeof id === 'string' && /^[a-f0-9]{64}$/.test(id))).toBe(true);
    expect(new Set(requests).size).toBe(2);
    const receipts = () => readSlackSendReceipts({ stateRoot: join(options.runsDir, 'slack-transport') });
    const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date('2026-11-06T02:01:00Z') });
    const inbox = () => listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    const before = inbox();
    expect(before.status).toBe('ok');
    if (before.status !== 'ok') throw new Error('inbox unavailable');
    const ingress = before.messages.filter(row => row.envelope.from === 'mason');
    expect(ingress).toHaveLength(2);
    expect(new Set(ingress.map(row => row.envelope.id)).size).toBe(2);
    expect(receipts()).toMatchObject({ state: 'ok', receipts: expect.arrayContaining(requests.map(id => ({ key: leaderReplySendKey(id!), state: 'attempted', channel, thread }))) });
    expect(trace().counts).toMatchObject({ total: 2, uncertain: 2, answered: 0 });

    visible = [1];
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 1 });
    const partial = trace();
    expect(partial.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(partial.counts).toMatchObject({ total: 2, uncertain: 1, answered: 1 });
    expect(partial.rows.find(row => row.messageTs === messageTs[0])).toMatchObject({ ingress: 'posted', outcome: 'uncertain' });
    expect(partial.rows.find(row => row.messageTs === messageTs[0])?.replyTs).toBeUndefined();
    expect(partial.rows.find(row => row.messageTs === messageTs[1])).toMatchObject({ ingress: 'posted', outcome: 'answered', replyTs: replyTs[1] });
    expect(receipts().receipts).toEqual(expect.arrayContaining([{ key: leaderReplySendKey(requests[0]!), state: 'attempted', channel, thread }]));
    expect(inbox()).toEqual(before);

    visible = [0, 1];
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 1 });
    const recovered = trace();
    expect(recovered.counts).toMatchObject({ total: 2, uncertain: 0, answered: 2 });
    for (let i = 0; i < 2; i++) expect(recovered.rows.find(row => row.messageTs === messageTs[i])).toMatchObject({ ingress: 'posted', outcome: 'answered', replyTs: replyTs[i] });
    expect(inbox()).toEqual(before);
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
    for (const event of events) expect(await receive(event)).toBeUndefined();
    expect(inbox()).toEqual(before);
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(2);
    expect(trace().counts).toMatchObject({ total: 2, answered: 2, uncertain: 0 });
  });
});
