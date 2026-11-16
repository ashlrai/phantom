import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { readSlackSendReceipts } from '../src/core/agents/slack-send-receipts.js';
import { formatBridgeCheckReply } from '../src/core/fleet/bridge-check-reply.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { claimFleetWork } from '../src/core/fleet/coordination.js';
import { readFleetBridgeCheck } from '../src/mcp/fleet-bridge-check.js';

const START = Date.parse('2026-11-15T06:00:00Z');
const owner = 'U0OWNER', bot = 'U0BOT', channel = 'D0LEADER', team = 'T0FAKE';
const footer = 'Reachability only; this is not an assignment or claim.';
let root = '';
let previousLedger: string | undefined;
afterEach(() => {
  if (previousLedger === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = previousLedger;
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe('Slack bridge ledger recovery through durable transport', { timeout: 30000 }, () => {
  it('answers each new thread from current ledger evidence and deduplicates replay', async () => {
    root = mkdtempSync(join(tmpdir(), 'bridge-transport-483s-'));
    const ledger = join(root, 'coordination.jsonl');
    previousLedger = process.env['PHANTOM_FLEET_LEDGER_PATH'];
    process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
    let now = START;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'), now: () => now };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'), `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\nidentities=[{channel="slack",id="${owner}"}]\n[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const call: SlackCall = vi.fn(async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0BOT' };
      if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
      if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: team } };
      if (method === 'conversations.members') return { members: [bot, owner], response_metadata: { next_cursor: '' } };
      if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
      if (method === 'chat.postMessage') return { channel: body.channel, ts: '1793920009.000001' };
      throw new Error('unexpected synthetic method');
    });
    const statusReply = ownerStatusReply({ bridge: async instant => formatBridgeCheckReply(await readFleetBridgeCheck({
      runtime: async () => ({ lastFleetStateRead: { ageSeconds: 12 } }), peers: () => ({ status: 'ok' }), now: () => instant.getTime(),
    }), instant) });
    const posts = () => vi.mocked(call).mock.calls.filter(row => row[0] === 'chat.postMessage');
    const receipts = () => readSlackSendReceipts({ stateRoot: join(options.runsDir, 'slack-transport') });
    const claim = (task: string) => claimFleetWork({ repo: 'example/repo', task, agent: 'dot', ttlMs: 60_000 }, { now });
    const receive = async (id: string, thread: string) => {
      const policy = readSlackDeliveryPolicy(options)!;
      const adapter = createSlackLeaderAdapter({ ...options, call, statusReply });
      let routed: Awaited<ReturnType<typeof adapter.route>> | undefined;
      const handlers: Record<string, (event: { data?: unknown }) => void> = {};
      const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; }, send: vi.fn(), close: vi.fn() };
      await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config, teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot }, leaderAdapter: { ...adapter, route: async envelope => routed = await adapter.route(envelope) }, connect: () => socket });
      handlers.message!({ data: JSON.stringify({ type: 'events_api', envelope_id: `${id}-delivery`, payload: { team_id: team, event_id: id, event: { type: 'message', user: owner, channel, ts: `${thread.slice(0, 10)}.000002`, thread_ts: thread, text: 'bridge?' } } }) });
      await vi.waitFor(() => expect(routed).toBeDefined(), { timeout: 15000 });
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ envelope_id: `${id}-delivery` })), { timeout: 15000 });
      return { routed: routed!, answer: await routed!.statusAnswer };
    };
    const ask = async (id: string, thread: string) => {
      const before = readFileSync(ledger);
      const result = await receive(id, thread);
      expect(result.routed).toMatchObject({ owned: true, durable: true });
      expect(result.answer).toMatchObject({ answered: true, reason: 'answered in-thread' });
      expect(readFileSync(ledger)).toEqual(before);
      const post = posts().at(-1)![1]!;
      expect(post).toMatchObject({ channel, thread_ts: thread });
      const text = String(post.text);
      expect(text.length).toBeLessThanOrEqual(600);
      expect(text.split('\n').length).toBeLessThanOrEqual(6);
      expect(text.endsWith(footer)).toBe(true);
      expect(receipts()).toMatchObject({ state: 'ok', receipts: expect.arrayContaining([expect.objectContaining({ state: 'sent', channel, thread })]) });
      return text;
    };

    expect(claim('initial')).toMatchObject({ ok: true });
    now = START + 10_000;
    const first = await ask('Ev-bridge-first', '1793920000.000001');
    expect(first).toContain(`Bridge: READY as of ${new Date(now).toISOString()}`);
    expect(first).toContain('Claims: 1 live, newest 10s');
    const corrupt = 'private-corrupt-fixture-483s';
    writeFileSync(ledger, `${corrupt}\n`, { mode: 0o600 });
    now = START + 20_000;
    const blocked = await ask('Ev-bridge-blocked', '1793920010.000001');
    expect(blocked).toContain(`Bridge: BLOCKED as of ${new Date(now).toISOString()} · missing claims`);
    expect(blocked).toContain('Claims: unknown');
    expect(blocked).not.toContain(corrupt);
    writeFileSync(ledger, '', { mode: 0o600 });
    now = START + 30_000;
    expect(claim('recovered')).toMatchObject({ ok: true });
    now = START + 40_000;
    const recovered = await ask('Ev-bridge-recovered', '1793920020.000001');
    expect(recovered).toContain(`Bridge: READY as of ${new Date(now).toISOString()}`);
    expect(recovered).toContain('Claims: 1 live, newest 10s');
    const beforeReplay = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    const ledgerBeforeReplay = readFileSync(ledger);
    const replay = await receive('Ev-bridge-recovered', '1793920020.000001');
    expect(replay.routed).toMatchObject({ owned: true, durable: true });
    expect(replay.answer).toBeUndefined();
    expect(posts()).toHaveLength(3);
    expect(listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now })).toEqual(beforeReplay);
    expect(readFileSync(ledger)).toEqual(ledgerBeforeReplay);
    clock.mockRestore();
  });
});
