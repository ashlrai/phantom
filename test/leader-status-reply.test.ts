import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeStatusReply, isStatusRequest, readStatusFacts, type StatusFacts } from '../src/core/agents/leader-status-reply.js';
import { flushSlackLeaderReplies, readSlackDeliveryPolicy, createSlackLeaderAdapter } from '../src/core/agents/slack-leader.js';
import { tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import type { AshlrConfig } from '../src/core/types.js';

vi.setConfig({ testTimeout: 30_000 });
const NOW = Date.parse('2026-11-06T02:00:00Z');
const unknownFacts: StatusFacts = { installedVersion: null, latestVersion: null, lanes: null, mergesLastHour: null, needsYouCount: null, observedAt: null };

describe('isStatusRequest', () => {
  it.each(['status', 'Phantom status', ' fleet status ', 'status?', "What's the status?", 'whats the status.', 'PHANTOM STATUS'])('accepts %j', text => {
    expect(isStatusRequest(text)).toBe(true);
  });
  it.each(['status of PR 4245', 'phantom status and release plan', '', 'x'.repeat(500), 'status??', 'please review PR 4245'])('rejects %j', text => {
    expect(isStatusRequest(text)).toBe(false);
  });
});

describe('composeStatusReply', () => {
  it('prints every known fact in at most 8 plain lines', () => {
    const text = composeStatusReply({ installedVersion: '1.2.3', latestVersion: '1.2.3', observedAt: '2026-11-06T02:00:00.000Z', mergesLastHour: 0, needsYouCount: 2,
      lanes: [{ lane: 'claude', running: 14, target: 17, held: false }, { lane: 'grok', running: 0, target: 0, held: true }] });
    expect(text.split('\n').length).toBeLessThanOrEqual(8);
    expect(text).toContain('Lane claude: 14 running of 17');
    expect(text).toContain('Lane grok: 0 running of 0 (held)');
    expect(text).toContain('Merges in the last hour: 0');
    expect(text).toContain('Needs you: 2');
    expect(text).not.toContain('update pending');
    expect(text).not.toContain('|');
  });
  it('prints unknown for every null fact and never 0', () => {
    const text = composeStatusReply(unknownFacts);
    expect(text).not.toMatch(/\b0\b/);
    expect(text).toContain('installed unknown, latest unknown');
    for (const label of ['Lanes:', 'Merges in the last hour:', 'Needs you:']) expect(text).toContain(`${label} unknown`);
    expect(text).not.toContain('update pending');
  });
  it('says update pending only when both versions are known and differ', () => {
    expect(composeStatusReply({ ...unknownFacts, installedVersion: '1.2.3', latestVersion: '1.3.0' })).toContain('update pending');
    expect(composeStatusReply({ ...unknownFacts, installedVersion: '1.2.3' })).not.toContain('update pending');
  });
  it('caps lanes so the reply stays within 8 lines', () => {
    const lanes = Array.from({ length: 12 }, (_, i) => ({ lane: `l${i}`, running: 1, target: 2, held: false }));
    expect(composeStatusReply({ ...unknownFacts, lanes }).split('\n').length).toBeLessThanOrEqual(8);
  });
});

describe('readStatusFacts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'status-facts-')); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  it('returns null fields for an empty runs dir without throwing', async () => {
    const facts = await readStatusFacts({ runsDir: root, now: () => new Date(NOW), readInstalled: () => null, readLatest: () => null });
    expect(facts).toEqual({ ...unknownFacts, observedAt: new Date(NOW).toISOString() });
  });
  it('nulls a field whose reader throws and reads lanes and merges from the runs dir', async () => {
    mkdirSync(join(root, 'queue')); mkdirSync(join(root, 'metrics'));
    writeFileSync(join(root, 'queue', 'status.json'), JSON.stringify({ admission: { cap: 10, running: 2, load1: 1 }, lanes: { claude: { running: 2, target: 3, queued: 0, held: false } } }));
    writeFileSync(join(root, 'metrics', 'jobs.jsonl'), `${JSON.stringify({ job: 'job-aaa', lane: 'claude', event: 'merged', ts: new Date(NOW - 60_000).toISOString(), url: 'https://github.com/ashlrai/phantom/pull/1' })}\n`);
    const facts = await readStatusFacts({ runsDir: root, now: () => new Date(NOW), readInstalled: () => { throw new Error('boom'); }, readLatest: () => '9.9.9' });
    expect(facts).toMatchObject({ installedVersion: null, latestVersion: '9.9.9', mergesLastHour: 1, lanes: [{ lane: 'claude', running: 2, target: 3, held: false }] });
  });
});

describe('flushSlackLeaderReplies status replies', () => {
  let root: string;
  let options: { configDir: string; runsDir: string; busRoot: string; now: () => number; statusReaders: { readInstalled: () => null; readLatest: () => null } };
  const configText = `[mason]\nidentities=[{channel="slack",id="U0000FAKE01"}]\n[team]\nidentities=[{channel="slack",id="U0000FAKE01"}]\n[slack]\nbridge_id="slack"\nteam_id="T0000FAKE01"\nown_user_id="U0000FAKE02"\nown_bot_id="B0000FAKE01"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0000FAKE01"\n`;
  const eventFor = (text: string, ts = '1793920001.000001') => ({ type: 'events_api', envelope_id: `Ev-delivery-${ts}`, payload: { team_id: 'T0000FAKE01', event_id: `Ev-${ts}`, event: {
    type: 'message', user: 'U0000FAKE01', channel: 'D0000FAKE01', ts, thread_ts: '1793920000.000001', text } } });
  const fakeCall = (post?: (body: Record<string, unknown>) => Promise<Record<string, unknown>>, history?: () => Record<string, unknown>): SlackCall => vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0000FAKE01', user_id: 'U0000FAKE02', bot_id: 'B0000FAKE01' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0000FAKE01' } };
    if (method === 'conversations.members') return { members: ['U0000FAKE02', 'U0000FAKE01'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0000FAKE01', is_bot: false } };
    if (method === 'chat.postMessage') return post ? post(body) : { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return history?.() ?? { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
  async function receive(call: SlackCall, text: string): Promise<void> {
    const policy = readSlackDeliveryPolicy(options)!;
    const adapter = createSlackLeaderAdapter({ ...options, call });
    let settled = false;
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
    await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
      leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
    handlers.message!({ data: JSON.stringify(eventFor(text)) });
    await vi.waitFor(() => expect(settled).toBe(true));
  }
  const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage').map(row => row[1] as Record<string, unknown>);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'leader-status-'));
    options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => NOW, statusReaders: { readInstalled: () => null, readLatest: () => null } };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('answers a pending "Phantom status" in the same thread exactly once, without a model', async () => {
    const call = fakeCall();
    await receive(call, 'Phantom status');
    expect(await flushSlackLeaderReplies({ ...options, call })).toMatchObject({ state: 'completed', sent: 1 });
    expect(posts(call)).toHaveLength(1);
    expect(posts(call)[0]).toMatchObject({ channel: 'D0000FAKE01', thread_ts: '1793920000.000001' });
    expect(String(posts(call)[0]!.text)).toContain('Phantom status');
    expect(String(posts(call)[0]!.text)).toContain('Lanes: unknown');
    expect(await flushSlackLeaderReplies({ ...options, call })).toMatchObject({ sent: 0 });
    expect(posts(call)).toHaveLength(1);
  });
  it('leaves any other request waiting for the model', async () => {
    const call = fakeCall();
    await receive(call, 'please review PR 4245');
    expect(await flushSlackLeaderReplies({ ...options, call })).toMatchObject({ state: 'completed', sent: 0 });
    expect(posts(call)).toHaveLength(0);
  });
  it('keeps the model reply text when a status-shaped row already has one', async () => {
    let clientId = '';
    const call = fakeCall(async body => { clientId = String(body.client_msg_id); throw new Error('synthetic disconnect'); },
      () => ({ messages: [{ client_msg_id: clientId, user: 'U0000FAKE02', thread_ts: '1793920000.000001', ts: '1793920002.000001' }] }));
    await receive(call, 'Phantom status');
    await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: async () => 'Model wrote this.' });
    await flushSlackLeaderReplies({ ...options, call });
    const sentTexts = posts(call).map(post => String(post.text));
    expect(sentTexts.length).toBeGreaterThan(0);
    expect(sentTexts.every(text => text.includes('Model wrote this.'))).toBe(true);
  });
});
