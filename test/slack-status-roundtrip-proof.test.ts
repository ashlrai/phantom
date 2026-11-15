import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';

let root: string;
const ts = '1793920001.000001';
const clock = () => Date.parse('2026-11-06T02:00:00Z');

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'slack-proof-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

async function receive(user: string) {
  const configDir = join(root, 'config'), runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
  mkdirSync(configDir, { mode: 0o700 });
  writeFileSync(join(configDir, 'agent-network.toml'), `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"},{channel="slack",id="U0FAKEPEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const call: SlackCall = vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
    if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
    if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
    throw new Error('unexpected synthetic method');
  });
  const options = { configDir, runsDir, busRoot, now: clock };
  const policy = readSlackDeliveryPolicy(options)!;
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply() });
  let settled = false;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, handler: (event: { data?: unknown }) => void) => { handlers[type] = handler; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir, busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: 'fake-delivery', payload: { team_id: 'T0FAKETEAM', event_id: 'fake-event', event: { type: 'message', user, channel: 'D0FAKELEADER', ts, text: 'Phantom status' } } }) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: 15000 });
  return { call, runsDir };
}

it('answers the verified owner once in the inbound thread and records delivery', async () => {
  const { call, runsDir } = await receive('U0FAKEOWNER');
  const posts = () => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage');
  await vi.waitFor(() => expect(posts()).toHaveLength(1), { timeout: 15000 });
  expect(posts()[0]?.[1]).toMatchObject({ channel: 'D0FAKELEADER', thread_ts: ts });
  expect(posts()[0]?.[1]?.text).toMatch(/Shipped \(last 12h\):|Quota:/);
  await vi.waitFor(() => {
    const state = JSON.parse(readFileSync(join(runsDir, 'leader', 'network-state.json'), 'utf8')) as { routes: Record<string, { reply?: { delivered: boolean } }> };
    expect(Object.values(state.routes)).toHaveLength(1);
    expect(Object.values(state.routes)[0]?.reply?.delivered).toBe(true);
  }, { timeout: 15000 });
  expect(readFileSync(join(runsDir, 'leader', 'MASON-INBOX.md'), 'utf8')).toContain('Phantom status');
  expect(posts()).toHaveLength(1);
}, 30000);

it('does not answer a team member who is not the verified owner', async () => {
  const { call } = await receive('U0FAKEPEER');
  expect(vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage')).toHaveLength(0);
}, 30000);
