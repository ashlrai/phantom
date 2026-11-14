/**
 * RQ-PHX-RECHECKCHANNELASK326: a short owner "recheck" ask in Slack, iMessage
 * or the desktop Leader box is answered in the same thread with the read-only
 * fleet recheck verdict; every other gated ask keeps the status digest.
 *
 * Hermetic: the recheck and brief seams are injected (the live readers never
 * load), Slack and iMessage transports are fakes, dirs are temp, ids fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockSends: { text: string; to: string }[] = [];

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (_file: string, _args: string[], _opts: unknown, cb: (e: Error | null, out: string, err: string) => void) => {
      cb(null, '', '');
      return {} as ReturnType<typeof actual.execFile>;
    },
  };
});

vi.mock('../src/core/comms/imessage-outbox.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/comms/imessage-outbox.js')>();
  return {
    ...actual,
    sendIMessageOutbox: async (text: string, _cfg: unknown, to: string) => {
      mockSends.push({ text, to });
      return { ok: true };
    },
  };
});

import { isRecheckAsk } from '../src/core/fleet/recheck-ask.js';
import { OWNER_RECHECK_FALLBACK, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { writeCursor, type IntakeMsg } from '../src/core/integrations/imessage.js';
import type { AshlrConfig } from '../src/core/types.js';

vi.setConfig({ testTimeout: 30_000 });
const WAIT_MS = 15_000;

const RECHECK_TEXT = 'Phantom recheck, 2026-11-13T18:13:00.000Z\nRUNTIME VERIFIED host=fake-host\nCLAIMS VERIFIED active=0\nBRIDGE VERIFIED slack=ok\nTASK UNKNOWN id=none\nVerdict: UNKNOWN';
const DIGEST = 'Morning leader brief\nShipped (last 12h): none';

describe('isRecheckAsk', () => {
  it.each([
    'recheck', '/recheck', 'phantom recheck', 'fleet recheck', 'recheck runtime', 'recheck live state', 'can you reach live state',
    'Recheck?', 'RECHECK!', '  Phantom Recheck.  ', 'Can you reach live state?', 'recheck live state?!',
  ])('accepts %j', ask => { expect(isRecheckAsk(ask)).toBe(true); });

  it('folds a curly apostrophe the same way status-ask does', () => {
    // No accepted ask contains an apostrophe, so folding must not open a new one.
    expect(isRecheckAsk('recheck’s')).toBe(false);
    expect(isRecheckAsk('recheck’')).toBe(false);
  });

  it.each([
    'recheck PR #5315 please', 'status', '', '   ', 'recheck the release', 'please recheck',
    `recheck${' '.repeat(33)}x`, // 41 chars
  ])('rejects %j', ask => { expect(isRecheckAsk(ask)).toBe(false); });

  it('rejects a 41-char string even when it otherwise reads as a recheck ask', () => {
    const long = `${'recheck'.padEnd(40, '?')}?`;
    expect(long).toHaveLength(41);
    expect(isRecheckAsk(long)).toBe(false);
  });

  it('rejects non-string input', () => { expect(isRecheckAsk(undefined as unknown as string)).toBe(false); });
});

describe('ownerStatusReply recheck branch', () => {
  const runsDir = '/nonexistent/fake-runs';
  const now = new Date('2026-11-13T18:13:00Z');

  it('gates recheck asks and status asks, nothing else', () => {
    const reply = ownerStatusReply();
    expect(reply.ask('recheck')).toBe(true);
    expect(reply.ask('status')).toBe(true);
    expect(reply.ask('recheck PR #5315 please')).toBe(false);
  });

  it('answers a recheck ask with the recheck seam and a status ask with the digest', async () => {
    const recheck = vi.fn(async () => RECHECK_TEXT);
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ recheck, brief, board: () => { throw new Error('no board'); } });
    expect(await reply.compose(runsDir, now, 'recheck')).toBe(RECHECK_TEXT);
    expect(recheck).toHaveBeenCalledWith(now);
    expect(brief).not.toHaveBeenCalled();
    const status = await reply.compose(runsDir, now, 'status');
    expect(status).toMatch(/^Phantom status, \d\d:\d\d ET\nShipped \(last 12h\): none/);
    expect(brief).toHaveBeenCalledOnce();
    expect(recheck).toHaveBeenCalledOnce();
    // No text (older callers) keeps the digest path.
    expect(await reply.compose(runsDir, now)).toMatch(/^Phantom status/);
  });

  it('returns the recheck fallback, never the digest, when the recheck read throws', async () => {
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ recheck: async () => { throw new Error('synthetic recheck failure'); }, brief });
    expect(await reply.compose(runsDir, now, 'Recheck?')).toBe(OWNER_RECHECK_FALLBACK);
    expect(OWNER_RECHECK_FALLBACK).toBe("Phantom recheck: the recheck read failed; your message is in the Leader's inbox.");
    expect(brief).not.toHaveBeenCalled();
  });
});

describe('recheck ask over Slack', () => {
  let root: string;
  let options: { configDir: string; runsDir: string; busRoot: string; now: () => number };
  const configText = `[mason]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[team]\nidentities=[{channel="slack",id="U0FAKEOWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0FAKETEAM"\nown_user_id="U0FAKEBOT"\nown_bot_id="B0FAKEBOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0FAKELEADER"\n`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'slack-recheck-ask-'));
    options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => Date.parse('2026-11-13T18:13:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), configText, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const slackEvent = (text: string) => ({ type: 'events_api', envelope_id: 'Ev-recheck-delivery', payload: { team_id: 'T0FAKETEAM', event_id: 'Ev-recheck', event: {
    type: 'message', user: 'U0FAKEOWNER', channel: 'D0FAKELEADER', ts: '1793920001.000001', thread_ts: '1793920000.000001', text } } });

  function fakeCall(): SlackCall {
    return vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
      if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
      if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920002.000001' };
      if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
      throw new Error('unexpected-synthetic-method');
    });
  }
  const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');

  async function receive(call: SlackCall, statusReply: ReturnType<typeof ownerStatusReply>, payload: unknown): Promise<void> {
    let settled = false;
    const policy = readSlackDeliveryPolicy(options)!;
    const adapter = createSlackLeaderAdapter({ ...options, call, statusReply });
    const handlers: Record<string, (event: { data?: unknown }) => void> = {};
    const socket = { readyState: 1, addEventListener: (type: string, callback: (event: { data?: unknown }) => void) => { handlers[type] = callback; }, send: vi.fn(), close: vi.fn() };
    await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
      leaderAdapter: { ...adapter, route: async envelope => { try { return await adapter.route(envelope); } finally { settled = true; } } }, connect: () => socket });
    handlers.message!({ data: JSON.stringify(payload) });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: WAIT_MS });
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledOnce(), { timeout: WAIT_MS });
  }

  it('posts the recheck verdict in the same thread once; a replay posts nothing new', async () => {
    const call = fakeCall();
    const recheck = vi.fn(async () => RECHECK_TEXT);
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ recheck, brief });
    await receive(call, reply, slackEvent('recheck'));
    await vi.waitFor(() => expect(posts(call)).toHaveLength(1), { timeout: WAIT_MS });
    expect(posts(call)[0]?.[1]).toMatchObject({ channel: 'D0FAKELEADER', thread_ts: '1793920000.000001', text: `Leader: ${RECHECK_TEXT}` });
    expect(recheck).toHaveBeenCalledWith(new Date(options.now()));
    expect(brief).not.toHaveBeenCalled();

    await receive(call, reply, slackEvent('recheck'));
    expect(recheck).toHaveBeenCalledOnce();
    expect(posts(call)).toHaveLength(1);
  });
});

describe('recheck ask over iMessage', () => {
  const MASON = '+15550000001';
  const now = () => new Date('2026-11-13T18:13:00Z');
  let home = '';
  let runsDir = '';
  let previousHome: string | undefined;

  beforeEach(() => {
    mockSends.length = 0;
    previousHome = process.env['HOME'];
    home = mkdtempSync(join(tmpdir(), 'imsg-recheck-home-'));
    runsDir = mkdtempSync(join(tmpdir(), 'imsg-recheck-runs-'));
    process.env['HOME'] = home;
    mkdirSync(join(home, 'Library', 'Messages'), { recursive: true });
    writeFileSync(join(home, 'Library', 'Messages', 'chat.db'), '');
    writeCursor(10, runsDir, now);
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(runsDir, { recursive: true, force: true });
  });

  const ingest = (messages: IntakeMsg[], statusReply: ReturnType<typeof ownerStatusReply>) =>
    ingestIMessages({ comms: { enabled: true, imessageHandle: MASON, imessageAllow: [MASON] } } as AshlrConfig, {
      runsDir, now, platform: 'darwin', busRoot: join(runsDir, 'bus'),
      poll: async () => ({ ok: true, messages }),
      maxRowId: async () => ({ ok: true, rowid: 10 }),
      statusReply,
    });

  it('acks a verified Mason "recheck" with the recheck verdict', async () => {
    const brief = vi.fn(async () => DIGEST);
    const result = await ingest([{ rowid: 11, handle: MASON, text: 'Recheck?', ts: 1 }], ownerStatusReply({ recheck: async () => RECHECK_TEXT, brief }));
    expect(result).toMatchObject({ ok: true, accepted: 1, cursor: 11 });
    expect(mockSends).toEqual([{ text: RECHECK_TEXT, to: MASON }]);
    expect(brief).not.toHaveBeenCalled();
  });

  it('sends the recheck fallback when the recheck read throws', async () => {
    await ingest([{ rowid: 11, handle: MASON, text: 'recheck', ts: 1 }], ownerStatusReply({ recheck: async () => { throw new Error('synthetic'); } }));
    expect(mockSends).toEqual([{ text: OWNER_RECHECK_FALLBACK, to: MASON }]);
  });
});
