import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, flushSlackLeaderReplies, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const owner = 'U0OWNER', bot = 'U0BOT', channel = 'D0LEADER', team = 'T0FAKE', thread = '1793920000.000001';
const replyTs = '1793920002.000001';
const bodyText = 'Synthetic private status body';
const config = `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`;
let root = '';
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('status reconciliation binds the original reply identity', { timeout: 30000 }, () => {
  it.each(['wrong bot', 'wrong thread', 'ambiguous timestamps'] as const)('refuses %s and recovers the original reply', async mismatch => {
    root = mkdtempSync(join(tmpdir(), 'status-identity-498s-'));
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), config, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    let clientId = '';
    let history: Array<Record<string, string>> = [];
    const call: SlackCall = vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0BOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
      if (method === 'chat.postMessage') { clientId = String(body.client_msg_id); throw new Error('synthetic lost response'); }
      if (method === 'conversations.replies') return { messages: history };
      throw new Error('unexpected synthetic method');
    });
    const policy = readSlackDeliveryPolicy(options)!;
    const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: { ask: text => text === 'Phantom status', compose: async () => bodyText, fallback: 'unavailable' } });
    let routed: Awaited<ReturnType<typeof adapter.route>> | undefined;
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; }, send: vi.fn(), close: vi.fn() };
    await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot }, leaderAdapter: { ...adapter, route: async envelope => routed = await adapter.route(envelope) }, connect: () => socket });
    handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: 'synthetic-delivery', payload: { team_id: team, event_id: 'Ev-synthetic-498', event: { type: 'message', user: owner, channel, ts: '1793920001.000001', thread_ts: thread, text: 'Phantom status' } } }) });
    await vi.waitFor(() => expect(routed).toBeDefined(), { timeout: 15000 });
    expect(routed).toMatchObject({ owned: true, durable: true });
    expect(await routed!.statusAnswer).toMatchObject({ answered: false });
    expect(clientId).not.toBe('');
    const requestId = readSlackJournal({ runsDir: options.runsDir }).entries.find(entry => entry.requestId)?.requestId;
    expect(requestId).toBeDefined();
    const before = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    const matching = { client_msg_id: clientId, user: bot, thread_ts: thread, ts: replyTs };
    history = mismatch === 'wrong bot' ? [{ ...matching, user: 'U0OTHERBOT' }] : mismatch === 'wrong thread' ? [{ ...matching, thread_ts: '1793920009.000001' }] : [matching, { ...matching, ts: '1793920003.000001' }];
    // Reconstruct the adapter against the same durable roots before flushing.
    createSlackLeaderAdapter({ ...options, call });
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 0 });
    const receipts = () => readSlackSendReceipts({ stateRoot: join(options.runsDir, 'slack-transport') });
    const trace = () => readSlackRequestTrace({ runsDir: options.runsDir, stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date('2026-11-06T02:01:00Z') });
    expect(receipts()).toMatchObject({ state: 'ok', receipts: [{ state: 'attempted', channel, thread }] });
    const uncertain = trace();
    expect(uncertain.rows).toHaveLength(1);
    expect(uncertain.rows[0]).toMatchObject({ outcome: 'uncertain', threadTs: thread, ingress: 'posted' });
    expect(uncertain.rows[0]).not.toHaveProperty('replyTs');
    expect(listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now })).toEqual(before);
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
    history = [matching];
    expect(await flushSlackLeaderReplies({ ...options, call })).toEqual({ state: 'completed', sent: 1 });
    expect(receipts()).toMatchObject({ state: 'ok', receipts: [{ state: 'sent', channel, thread, ts: replyTs }] });
    const answered = trace();
    expect(answered.rows).toHaveLength(1);
    expect(answered.rows[0]).toMatchObject({ outcome: 'answered', ingress: 'posted', threadTs: thread, replyTs });
    for (const result of [uncertain, answered]) {
      const output = JSON.stringify(result);
      expect(output).not.toContain(bodyText);
      expect(output).not.toContain(owner);
      expect(output).not.toContain(requestId!);
    }
    expect(listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now })).toEqual(before);
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
  });
});
