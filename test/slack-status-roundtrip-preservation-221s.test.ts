/**
 * RQ-PHX-SLACKSTATUSPRESERVE221S: recovers the still-missing round-trip from
 * original PR #4667 (RQ-PHX-SLACKSTATUSROUNDTRIP10, head fcf9d6cae0dde5a1d4bb2177c5a6a6fccc86c1fd).
 * A verified operator's Slack "Phantom status" is answered in the same thread
 * by the existing status builder and does not become a "PRIORITY P0" order in
 * MASON-INBOX.md, unless the answer cannot be delivered, in which case the
 * sole writer's P0 block is written so nothing is lost.
 *
 * Exercises the production sole-writer path hermetically: HOME is relocated
 * per test and a stub `bin/mason-inbox-append` honoring the real helper's
 * argv/stdin/receipt contract records what it would append. The inbox
 * deferral is reserved for that installed writer; injected seams and the
 * local leader journal keep their durable write at ingest (unchanged tests:
 * slack-leader-roundtrip.test.ts, slack-leader-status-reply.test.ts).
 *
 * Drives the real socket mapper -> Leader adapter -> Leader network path with
 * a fake Slack transport and temp runs/config dirs. All ids are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy, type SlackStatusAnswer } from '../src/core/agents/slack-leader.js';
import { readLeaderInbox, tickLeaderNetwork } from '../src/core/agents/leader-network-runtime.js';
import { isOwnerStatusRequest, OWNER_STATUS_FALLBACK, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { AshlrConfig } from '../src/core/types.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;
const OPERATOR = 'U000FAKEOPERATOR', PEER = 'U000FAKEPEER', CHANNEL = 'C000FAKECHANNEL', TEAM = 'T000FAKETEAM';
const THREAD_TS = '1793920000.000001';
const configText = `[mason]\nidentities=[{channel="slack",id="${OPERATOR}"}]\n` +
  `[team]\nidentities=[{channel="slack",id="${OPERATOR}"},{channel="slack",id="${PEER}"}]\n` +
  `[slack]\nbridge_id="slack"\nteam_id="${TEAM}"\nown_user_id="U000FAKEBOT"\nown_bot_id="B000FAKEBOT"\n` +
  `bot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${CHANNEL}"\n`;
const BRIEF = 'Morning leader brief\nShipped (last 12h): none\nBlocked: none';

let root: string;
let savedHome: string | undefined;
let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
const runsDir = () => options.runsDir;
const inboxPath = () => join(runsDir(), 'leader', 'MASON-INBOX.md');

/** Node stub for the installed sole writer: the real helper's argv/stdin/
 * receipt contract, writing only inside the relocated HOME. */
function stubWriterSource(inbox: string): string {
  return `#!${process.execPath}
'use strict';
const { createHash } = require('node:crypto');
const { appendFileSync, existsSync, mkdirSync, readFileSync } = require('node:fs');
const { dirname } = require('node:path');
const INBOX = ${JSON.stringify(inbox)};
const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const id = args['--id'];
  const digest = createHash('sha256').update(JSON.stringify([id, Number(args['--received-at']), input])).digest('hex');
  const marker = '[leader-network:' + id + ']';
  const previous = existsSync(INBOX) ? readFileSync(INBOX, 'utf8') : '';
  let status = 'appended';
  if (previous.includes(marker)) status = 'duplicate';
  else {
    mkdirSync(dirname(INBOX), { recursive: true, mode: 0o700 });
    appendFileSync(INBOX, '\\n## 2026-11-05 21:00 ET (Operator, slack) PRIORITY P0 [request-sha256:' + digest + '] ' + marker + '\\n' + input + '\\n');
  }
  process.stdout.write(JSON.stringify({ schema: 'mason-inbox-receipt.v1', requestId: id, requestSha256: digest, status }));
});
`;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-status-preserve-'));
  savedHome = process.env.HOME;
  // The installed host's sole writer only exists for the real runs root, so
  // relocating HOME selects the production deferral path hermetically.
  process.env.HOME = root;
  options = { configDir: join(root, '.ashlr'), runsDir: join(root, '.ashlr-runs'), busRoot: join(root, 'bus'),
    now: () => Date.parse('2026-11-06T02:00:00Z') };
  mkdirSync(join(runsDir(), 'bin'), { recursive: true, mode: 0o700 });
  writeFileSync(join(runsDir(), 'bin', 'mason-inbox-append'), stubWriterSource(inboxPath()), { mode: 0o700 });
  mkdirSync(options.configDir, { mode: 0o700 });
  writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
  writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
});
afterEach(() => { process.env.HOME = savedHome; rmSync(root, { recursive: true, force: true }); });

function fakeTransport(input: { post?: () => Promise<Record<string, unknown>> } = {}): SlackCall {
  return vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: TEAM, user_id: 'U000FAKEBOT', bot_id: 'B000FAKEBOT' };
    if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_private: true, context_team_id: TEAM } };
    if (method === 'conversations.members') return { members: ['U000FAKEBOT', OPERATOR], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: TEAM, is_bot: body.user === 'U000FAKEBOT' } };
    if (method === 'chat.postMessage') return input.post ? input.post() : { channel: body.channel, ts: '1793920002.000001' };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    throw new Error('unexpected-synthetic-method');
  });
}
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
const inbox = () => existsSync(inboxPath()) ? readFileSync(inboxPath(), 'utf8') : '';
const p0Blocks = () => inbox().split('\n').filter(line => /^## .* PRIORITY P0\b/.test(line));

function slackEvent(text: string, user: string, eventId: string, ts: string) {
  return { type: 'events_api', envelope_id: `${eventId}-delivery`, payload: { team_id: TEAM, event_id: eventId, event: {
    type: 'message', user, channel: CHANNEL, ts, thread_ts: THREAD_TS, text } } };
}

/** One inbound event through the real socket handler; settles the detached status answer too. */
async function receive(call: SlackCall, text: string, user = OPERATOR, eventId = 'Ev-status', ts = '1793920001.000001') {
  const brief = vi.fn(async () => BRIEF);
  const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({ brief }) });
  const policy = readSlackDeliveryPolicy(options)!;
  let routed: { owned: boolean; durable: boolean; statusAnswer?: Promise<SlackStatusAnswer> } | undefined;
  let settled = false;
  const handlers: Record<string, (event: { data?: unknown }) => void> = {};
  const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
  await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: runsDir(), busRoot: options.busRoot },
    leaderAdapter: { ...adapter, route: async envelope => { try { return routed = await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
  handlers.message!({ data: JSON.stringify(slackEvent(text, user, eventId, ts)) });
  await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
  const answer = await routed?.statusAnswer;
  return { routed, answer, brief, socket };
}

describe('Slack "Phantom status" round trip (PR #4667 preservation)', () => {
  it('answers the verified operator once in the same thread from the status builder, with no P0 inbox block', async () => {
    const call = fakeTransport();
    const { routed, answer, brief, socket } = await receive(call, 'Phantom status');
    expect(routed).toMatchObject({ owned: true, durable: true });
    expect(answer).toEqual({ answered: true, reason: 'answered in-thread' });
    expect(brief).toHaveBeenCalledOnce();
    expect(posts(call)).toHaveLength(1);
    const posted = posts(call)[0]![1] as Record<string, unknown>;
    expect(posted).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS });
    // The existing builder rewrites the brief's title into the status heading.
    expect(posted.text).toMatch(/^Leader: Phantom status, \d\d:\d\d ET\nShipped \(last 12h\): none/);
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-status-delivery' }));
    // Neither the installed sole writer nor the local journal manufactures a P0 order.
    expect(existsSync(inboxPath())).toBe(false);
    expect(p0Blocks()).toEqual([]);
    expect((await readLeaderInbox(options)).inbox.entries).toEqual([]);
    // The answer is logged through the existing Leader reply record and bus.
    expect(readFileSync(join(runsDir(), 'leader', 'MASON-OUTBOX.md'), 'utf8')).toContain('Leader: Phantom status,');
    const page = listBusInboxAfter(0, 50, { root: options.busRoot });
    expect(page.status === 'ok' && page.messages.some(row => row.envelope.from === 'leader' &&
      (row.envelope.body as { kind?: string }).kind === 'leader-reply')).toBe(true);

    // A redelivered event neither re-answers nor writes the inbox.
    const again = await receive(call, 'Phantom status');
    expect(again.routed).toMatchObject({ owned: true, durable: true });
    expect(again.routed?.statusAnswer).toBeUndefined();
    expect(again.brief).not.toHaveBeenCalled();
    expect(posts(call)).toHaveLength(1);
    expect(p0Blocks()).toEqual([]);

    // The answered ask is also closed for the Leader's queued reply pass.
    const generate = vi.fn(async () => 'Synthetic second answer');
    expect(await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: generate })).toMatchObject({ replies: 0 });
    expect(generate).not.toHaveBeenCalled();
    expect(posts(call)).toHaveLength(1);
  });

  it.each(['status?', "What's the status", 'STATUS!'])('treats %j the same way', async text => {
    const call = fakeTransport();
    const { answer } = await receive(call, text);
    expect(answer?.answered).toBe(true);
    expect(posts(call)).toHaveLength(1);
    expect(p0Blocks()).toEqual([]);
  });

  it('keeps a request that merely mentions status as a P0 order with no auto answer', async () => {
    const call = fakeTransport();
    const { routed, brief } = await receive(call, 'status of release, then cut 3.30.32');
    expect(routed).toEqual({ owned: true, durable: true });
    expect(brief).not.toHaveBeenCalled();
    expect(posts(call)).toHaveLength(0);
    expect(p0Blocks()).toHaveLength(1);
    expect(inbox()).toContain('status of release, then cut 3.30.32');
  });

  it('leaves a non-operator sender unchanged: not owned, no answer, no inbox write', async () => {
    const call = fakeTransport();
    const { routed, brief } = await receive(call, 'Phantom status', PEER, 'Ev-peer');
    expect(routed).toEqual({ owned: false, durable: false });
    expect(brief).not.toHaveBeenCalled();
    expect(posts(call)).toHaveLength(0);
    expect(p0Blocks()).toEqual([]);
  });

  it('writes the P0 block when the Slack send throws, and says why', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const call = fakeTransport({ post: async () => { throw new Error('synthetic post failure'); } });
      const { routed, answer } = await receive(call, 'Phantom status');
      expect(routed).toMatchObject({ owned: true, durable: true });
      expect(answer?.answered).toBe(false);
      expect(posts(call).length).toBeGreaterThan(0);
      expect(p0Blocks()).toHaveLength(1);
      expect(inbox()).toContain('\nPhantom status\n');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/status ask not answered in-thread \(reply \w+.*\); recorded it in MASON-INBOX as P0/));
      // The same event again is a duplicate: no second answer attempt or block.
      const again = await receive(call, 'Phantom status');
      expect(again.routed).toMatchObject({ owned: true, durable: true });
      expect(again.routed?.statusAnswer).toBeUndefined();
      expect(p0Blocks()).toHaveLength(1);
      expect(posts(call).length).toBeGreaterThan(0);
    } finally { warn.mockRestore(); }
  });

  it('writes the P0 block when the transport is no longer configured at send time', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const base = fakeTransport();
      // Policy is present for the inbound proof, then gone when the reply is delivered.
      const call: SlackCall = vi.fn(async (method, body = {}, credential) => {
        if (method === 'users.info') writeFileSync(join(options.configDir, 'agent-network.toml'), configText.replace(/\[slack\][\s\S]*$/, ''), { mode: 0o600 });
        return base(method, body, credential);
      });
      const { answer } = await receive(call, 'Phantom status');
      expect(answer?.answered).toBe(false);
      expect(posts(call)).toHaveLength(0);
      expect(p0Blocks()).toHaveLength(1);
      expect(warn).toHaveBeenCalledOnce();
    } finally { warn.mockRestore(); }
  });

  it('acks the socket envelope without waiting on slow status composition', async () => {
    let release: (text: string) => void = () => {};
    const gate = new Promise<string>(resolve => { release = resolve; });
    const call = fakeTransport();
    const adapter = createSlackLeaderAdapter({ ...options, call,
      statusReply: { ask: isOwnerStatusRequest, compose: () => gate, fallback: OWNER_STATUS_FALLBACK } });
    const policy = readSlackDeliveryPolicy(options)!;
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, cb: (event: { data?: unknown }) => void) => { handlers[type] = cb; }, send: vi.fn(), close: vi.fn() };
    await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: runsDir(), busRoot: options.busRoot },
      leaderAdapter: adapter, connect: () => socket });
    handlers.message!({ data: JSON.stringify(slackEvent('Phantom status', OPERATOR, 'Ev-slow', '1793920005.000001')) });
    // The durable ingest is acknowledged while the brief read is still pending.
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: 'Ev-slow-delivery' })), { timeout: WAIT_MS });
    expect(posts(call)).toHaveLength(0);
    release(BRIEF);
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    expect(p0Blocks()).toEqual([]);
  });

  it('keeps ordinary steering on the queued Leader reply path', async () => {
    const call = fakeTransport();
    const { routed } = await receive(call, 'please ship the synthetic release', OPERATOR, 'Ev-steer', '1793920007.000001');
    expect(routed).toMatchObject({ owned: true, durable: true });
    // The installed sole writer still records ordinary asks at ingest.
    expect(p0Blocks()).toHaveLength(1);
    const generate = vi.fn(async () => 'Synthetic steered reply.');
    expect(await tickLeaderNetwork({} as AshlrConfig, { ...options, slackCall: call }, { reply: generate })).toMatchObject({ replies: 1 });
    expect(generate).toHaveBeenCalledOnce();
    expect(posts(call)).toHaveLength(1);
    expect(posts(call)[0]![1]).toMatchObject({ channel: CHANNEL, thread_ts: THREAD_TS, text: 'Leader: Synthetic steered reply.' });
  });
});

describe('isOwnerStatusRequest (the existing classifier the fast path uses)', () => {
  it.each(['Phantom status', 'phantom status', 'status', 'status?', 'Status.', "What's the status", 'what’s the status?', '  fleet status!  '])('accepts %j', text => {
    expect(isOwnerStatusRequest(text)).toBe(true);
  });
  it.each(['status of release, then cut 3.30.32', 'phantom status and fix CI', 'what is blocked', '', 'statuses', 'status report for the team please now'])('rejects %j', text => {
    expect(isOwnerStatusRequest(text)).toBe(false);
  });
});
