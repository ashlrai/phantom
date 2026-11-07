import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { LeaderInboxAppender } from '../src/core/agents/leader-inbox-writer.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deliverSlackLeaderMessage, flushSlackLeaderReplies, ingestSlackLeaderEnvelope, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { readLeaderInbox, tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { createSlackApi, openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { AshlrConfig } from '../src/core/types.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

// This module now contains a real host-helper fixture; serialization must not
// enlarge the pre-existing unit-lane per-case deadline.
vi.setConfig({ testTimeout: 5000 });
let root: string;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number; appendInbox?: LeaderInboxAppender };
const configText = `[mason]\nidentities=[{channel="slack",id="U0OWNER"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"},{channel="slack",id="B0PEER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0TEAM"\nown_user_id="U0BOT"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0LEADER"\n`;
const event = { type: 'events_api', envelope_id: 'Ev-delivery', payload: { team_id: 'T0TEAM', event_id: 'Ev-request', event: {
  type: 'message', user: 'U0OWNER', channel: 'D0LEADER', ts: '1793920001.000001', thread_ts: '1793920000.000001', text: 'Please report the synthetic release blocker.' } } };
const reply: BusEnvelope = { id: 'leader-reply-synthetic', from: 'leader', to: 'mason', priority: 'P0', ttl: 60000,
  channel: 'slack', channel_ref: 'slack:T0TEAM:D0LEADER:1793920000.000001', origin_bridge: 'leader-network', external: false,
  sender: { agent_id: 'leader', vendor: 'phantom', human: false, team: true }, body: { kind: 'leader-reply', text: 'Leader: The synthetic candidate needs qualification.' } };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-leader-'));
  options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-06T02:00:00Z') };
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function fakeCall(input: { post?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>; members?: () => void; history?: () => Record<string, unknown>; wrongTeam?: boolean } = {}): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: input.wrongTeam ? 'T0OTHER' : 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0TEAM' } };
    if (method === 'conversations.members') { input.members?.(); return { members: ['U0BOT', 'U0OWNER'], response_metadata: { next_cursor: '' } }; }
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0TEAM', is_bot: body.user === 'U0BOT' || body.user === 'U0PEER' } };
    if (method === 'chat.postMessage') return input.post ? input.post(body) : { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return input.history?.() ?? { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}

async function receive(call: SlackCall, payload: unknown = event, acknowledged = true) {
  let ownerSettled = false;
  const policy = readSlackDeliveryPolicy(options)!;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
    owner: async envelope => { try { return await ingestSlackLeaderEnvelope(envelope, { ...options, call }); } finally { ownerSettled = true; } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(payload) });
  if (acknowledged) await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce());
  else { await vi.waitFor(() => expect(ownerSettled).toBe(true)); expect(socket.send).not.toHaveBeenCalled(); }
  return socket;
}

describe('authenticated Slack Leader integration', () => {
  it('receives a verified human owner, uses the existing Leader worker and replies once in the same thread', async () => {
    const call = fakeCall();
    await receive(call);
    const inbox = await readLeaderInbox(options);
    expect(inbox.inbox.entries[0]?.text).toContain('synthetic release blocker');
    const page = listBusInboxAfter(0, 100, { root: options.busRoot, now: options.now });
    expect(page).toMatchObject({ status: 'ok', messages: [{ envelope: { from: 'mason', to: 'leader', sender: { human: true } } }] });
    const generate = vi.fn(async () => 'The synthetic candidate needs qualification.');
    expect(await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: generate })).toMatchObject({ replies: 1 });
    const posts = vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[1]).toMatchObject({ channel: 'D0LEADER', thread_ts: '1793920000.000001', text: 'Leader: The synthetic candidate needs qualification.' });
    await receive(call); await flushSlackLeaderReplies({ ...options, call });
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
    expect(generate).toHaveBeenCalledOnce();
  });
  it('does not promote bot peers to Mason even if a mistaken owner entry lists their bot ID', async () => {
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText.replace('id="U0OWNER"}]\n[team]', 'id="B0PEER"}]\n[team]'));
    const bot = { ...event, payload: { ...event.payload, event: { ...event.payload.event, subtype: 'bot_message', user: 'U0PEER', bot_id: 'B0PEER' } } };
    await receive(fakeCall(), bot);
    expect((await readLeaderInbox(options)).inbox.sourceState).toBe('missing');
    expect(listBusInboxAfter(0, 100, { root: options.busRoot, now: options.now })).toMatchObject({ messages: [{ envelope: { from: 'slack:B0PEER', sender: { human: false } } }] });
  });
  it('refuses foreign workspace input and mismatched reply routes', async () => {
    await receive(fakeCall(), { ...event, payload: { ...event.payload, team_id: 'T0OTHER' } });
    expect((await readLeaderInbox(options)).inbox.sourceState).toBe('missing');
    const call = fakeCall();
    expect(await deliverSlackLeaderMessage({ channel: 'slack', id: 'U0OWNER' }, { ...reply, channel_ref: 'slack:T0OTHER:D0LEADER:1793920000.000001' }, { ...options, call })).toMatchObject({ status: 'refused' });
    expect(call).not.toHaveBeenCalled();
    expect(await deliverSlackLeaderMessage({ channel: 'slack', id: 'U0OWNER' }, reply, { ...options, call: fakeCall({ wrongTeam: true }) })).toMatchObject({ status: 'drafted' });
  });
  it('refuses a U-prefixed bot account configured as owner even if its event omits bot_id', async () => {
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText
      .replace('id="U0OWNER"}]\n[team]', 'id="U0PEER"}]\n[team]')
      .replace('[team]\nidentities=[', '[team]\nidentities=[{channel="slack",id="U0PEER"},'));
    const forgedHuman: BusEnvelope = { ...reply, id: 'synthetic-bot-user', from: 'slack:U0PEER', to: 'leaders', origin_bridge: 'slack',
      sender: { agent_id: 'U0PEER', vendor: 'slack', human: true, team: true }, body: { kind: 'note', text: 'Synthetic bot user event' } };
    expect(await ingestSlackLeaderEnvelope(forgedHuman, { ...options, call: fakeCall() })).toEqual({ owned: true, durable: false });
    expect((await readLeaderInbox(options)).inbox.sourceState).toBe('missing');
  });
  it('rechecks human approval after fresh membership observation and sends no revoked draft', async () => {
    const call = fakeCall({ members: () => writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=false\n') });
    expect(await deliverSlackLeaderMessage({ channel: 'slack', id: 'U0OWNER' }, reply, { ...options, call })).toMatchObject({ status: 'drafted' });
    expect(vi.mocked(call).mock.calls.some(row => row[0] === 'chat.postMessage')).toBe(false);
  });
  it('recovers an uncertain post by client ID through the Leader draft without posting twice', async () => {
    let clientId = '';
    const call = fakeCall({ post: async body => { clientId = String(body.client_msg_id); throw new Error('synthetic disconnect'); },
      history: () => ({ messages: [{ client_msg_id: clientId, user: 'U0BOT', thread_ts: '1793920000.000001', ts: '1793920002.000001' }] }) });
    await receive(call);
    expect(await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: async () => 'The synthetic candidate needs qualification.' })).toMatchObject({ replies: 0 });
    expect(await flushSlackLeaderReplies({ ...options, call })).toMatchObject({ sent: 1 });
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(options.runsDir, 'slack-transport/messages.json'), 'utf8')).messages).toBeDefined();
  });
  it('propagates the session abort to the HTTP request and never starts a post after expiry', async () => {
    const controller = new AbortController();
    const request = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('synthetic abort')), { once: true });
    }));
    const policy = readSlackDeliveryPolicy(options)!;
    const call = createSlackApi({ config: policy.config, resolveCredential: () => 'FAKE_EXAMPLE_CREDENTIAL', fetch: request as typeof fetch, signal: controller.signal });
    const pending = call('conversations.members');
    controller.abort();
    await expect(pending).rejects.toThrow('slack-network-uncertain');
    await expect(call('chat.postMessage', { channel: 'D0LEADER', text: 'must never leave' })).rejects.toThrow('slack-session-expired');
    expect(request).toHaveBeenCalledOnce();
  });
  it('encodes Slack read methods as form fields and the post method as JSON', async () => {
    const request = vi.fn(async (_url: string, _input?: RequestInit) => new Response('{"ok":true}'));
    const policy = readSlackDeliveryPolicy(options)!;
    const call = createSlackApi({ config: policy.config, resolveCredential: () => 'FAKE_EXAMPLE_CREDENTIAL', fetch: request as typeof fetch });
    await call('users.info', { user: 'U0OWNER' });
    await call('conversations.members', { channel: 'D0LEADER', limit: 100 });
    await call('chat.postMessage', { channel: 'D0LEADER', text: 'Synthetic result' });
    const read = request.mock.calls[0]![1]!;
    expect((read.headers as Record<string, string>)['Content-Type']).toContain('application/x-www-form-urlencoded');
    expect(new URLSearchParams(String(read.body)).get('user')).toBe('U0OWNER');
    expect(new URLSearchParams(String(request.mock.calls[1]![1]!.body)).get('limit')).toBe('100');
    const post = request.mock.calls[2]![1]!;
    expect((post.headers as Record<string, string>)['Content-Type']).toContain('application/json');
    expect(JSON.parse(String(post.body))).toEqual({ channel: 'D0LEADER', text: 'Synthetic result' });
  });
});


describe('approved sole writer integration in a private HOME fixture', () => {
  it.runIf(process.platform === 'darwin')('recovers a lost writer result through the same retained request and sends one reply', async () => {
    const copy = join(root, 'private-mason-inbox-append');
    copyFileSync(fileURLToPath(new URL('../contrib/mac/mason-inbox-append', import.meta.url)), copy);
    const scrub = join(root, 'approved-scrubber.pl');
    copyFileSync(fileURLToPath(new URL('./fixtures/leader-inbox/approved-scrubber.pl', import.meta.url)), scrub);
    const leader = join(options.runsDir, 'leader'); mkdirSync(leader, { recursive: true, mode: 0o700 });
    const inbox = join(leader, 'MASON-INBOX.md'); writeFileSync(inbox, '', { mode: 0o444 });
    let loseReceipt = true;
    const statuses: string[] = [];
    options.appendInbox = async request => {
      const stdout = execFileSync('/usr/bin/python3', [copy, '--src', 'slack', '--id', request.requestId, '--received-at', String(request.receivedAt)],
        { input: request.text, encoding: 'utf8', timeout: 25000, maxBuffer: 1024,
          env: { PATH: '/usr/bin:/bin', MASON_INBOX_TEST: '1', MASON_INBOX_PATH: inbox, MASON_INBOX_SCRUB: scrub } });
      const receipt = JSON.parse(stdout); statuses.push(receipt.status);
      if (loseReceipt) { loseReceipt = false; throw new Error('Synthetic lost helper acknowledgement'); }
      return receipt;
    };
    const call = fakeCall();
    await receive(call, event, false);
    const saved = () => JSON.parse(readFileSync(join(leader, 'network-state.json'), 'utf8'));
    expect(Object.values(saved().routes)).toMatchObject([{ inbox: false, bus: false }]);
    await receive(call);
    expect(Object.values(saved().routes)).toMatchObject([{ inbox: true, bus: true }]);
    expect(statuses).toEqual(['appended', 'duplicate']);
    expect(readFileSync(inbox, 'utf8').split('\n').filter(line => line.startsWith('## '))).toHaveLength(1);
    const generate = vi.fn(async () => 'Synthetic evidence-grounded reply');
    expect(await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: generate })).toMatchObject({ replies: 1 });
    await receive(call);
    expect(vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(1);
    expect(generate).toHaveBeenCalledOnce();
    chmodSync(inbox, 0o600); // fixture cleanup only; installed inbox is never touched.
  });
});


describe('current owner before trusted inbox append', () => {
  it('refuses a revocation during the authenticated user lookup before any writer or bus append', async () => {
    const appendInbox = vi.fn();
    options.appendInbox = appendInbox;
    const original = fakeCall();
    const call: SlackCall = async (method, body, credential) => {
      const value = await original(method, body, credential);
      if (method === 'users.info' && body?.user === 'U0OWNER') {
        writeFileSync(join(options.configDir, 'agent-network.toml'), configText.replace('identities=[{channel="slack",id="U0OWNER"}]', 'identities=[]'));
      }
      return value;
    };
    await receive(call, event, false);
    expect(appendInbox).not.toHaveBeenCalled();
    expect(vi.mocked(original).mock.calls.filter(row => row[0] === 'chat.postMessage')).toHaveLength(0);
    const state = JSON.parse(readFileSync(join(options.runsDir, 'leader/network-state.json'), 'utf8'));
    expect(Object.values(state.routes)).toMatchObject([{ inbox: false, bus: false }]);
  });
});
