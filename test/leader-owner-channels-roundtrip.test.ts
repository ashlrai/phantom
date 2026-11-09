/** Every owner channel through its real intake: Mason message -> owner thread once (right source),
 * redelivery -> still once, reply -> addressed to the channel it came from. Only the outside
 * transports are fakes; all state lives in a mkdtemp root passed through options. */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { composeLeaderInbox, receiptLeaderChannel, type LeaderRuntimeOptions } from '../src/core/agents/leader-network-runtime.js';
import { createSlackLeaderAdapter } from '../src/core/agents/slack-leader.js';
import type { SlackCall } from '../src/core/agents/slack-transport.js';
import { OWNER_CHANNELS, type OwnerChannel } from '../src/core/comms/leader-mailbox.js';
import { loadOwnerThreadSettings, type OwnerChannelTransport, type OwnerDelivery } from '../src/core/comms/owner-channel.js';
import { readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { ChannelEnvelope } from '../src/core/fleet/channel-envelope.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const NOW = Date.parse('2026-11-06T02:00:00Z');
const IMESSAGE = '+15550100';
const TELEGRAM = 'telegram:1000001';
const EMAIL = 'email:owner@example.test';
const SLACK = 'U000TEST';
const SLACK_REF = 'slack:T000TEAM:D000LEAD:1793920000.000001';
const TEXT = 'Synthetic owner hello';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'owner-channels-'));
  roots.push(root);
  const configDir = join(root, 'config');
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  const ids = `{ channel = "bus", id = "local-owner" }, { channel = "imessage", id = "${IMESSAGE}" }, { channel = "telegram", id = "${TELEGRAM}" }, { channel = "email", id = "${EMAIL}" }, { channel = "slack", id = "${SLACK}" }`;
  writeFileSync(join(configDir, 'agent-network.toml'), [
    `[mason]\nidentities = [${ids}]`,
    `[team]\nidentities = [{ channel = "bus", id = "leader" }, ${ids}]`,
    '[slack]\nbridge_id = "slack"\nteam_id = "T000TEAM"\nown_user_id = "U000BOT"\nown_bot_id = "B000BOT"',
    'bot_token_ref = "phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref = "phm_SLACK_AGENTNET_APP_TOKEN"',
    '[[slack.map]]\ntopic = "leaders"\nchannel = "D000LEAD"\n',
  ].join('\n'), { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'), [
    '[telegram]\nsecretHandle = "phm_TELEGRAM_BOT_TOKEN"', '[email]\nsecretHandle = "phm_EMAIL_CREDENTIAL"',
    '[slack]\nsecretHandle = "phm_SLACK_BOT_TOKEN"', '[imessage]\nbridge = "loopback"\n',
  ].join('\n'), { mode: 0o600 });
  const runsDir = join(root, 'runs');
  const busRoot = join(root, 'bus');
  // Fake Slack Web API: only the human check the real intake makes before granting authority.
  const slackCall: SlackCall = async (method, body = {}) => {
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T000TEAM', is_bot: false } };
    throw new Error('unexpected-synthetic-method');
  };
  const runtime: LeaderRuntimeOptions & { slackCall: SlackCall } = { runsDir, busRoot, configDir, now: () => NOW, slackCall };
  const thread: OwnerThreadOptions = { runsDir, busRoot, now: () => NOW, settings: loadOwnerThreadSettings(configDir), halted: false, paused: false };
  return { runtime, thread };
}

function channelEnvelope(channel: 'imessage' | 'telegram' | 'email', sender: string, dedupeKey: string): ChannelEnvelope {
  return { channel, verifiedSenderId: sender, body: TEXT, receivedAt: new Date(NOW).toISOString(), dedupeKey };
}

type Intake = (ctx: ReturnType<typeof setup>, sender?: string) => Promise<unknown>;

/** Each channel's real intake function, with the verified-Mason sender id overridable. */
const INTAKE: Partial<Record<OwnerChannel, { sender: string; ingest: Intake }>> = {
  desktop: { sender: 'local-owner', ingest: ctx => composeLeaderInbox(TEXT, ctx.runtime) },
  imessage: { sender: IMESSAGE, ingest: (ctx, s = IMESSAGE) => receiptLeaderChannel(channelEnvelope('imessage', s, 'imessage-dedupe-0001'), ctx.runtime) },
  telegram: { sender: TELEGRAM, ingest: (ctx, s = TELEGRAM) => receiptLeaderChannel(channelEnvelope('telegram', s, 'telegram-dedupe-0001'), ctx.runtime) },
  email: { sender: EMAIL, ingest: (ctx, s = EMAIL) => receiptLeaderChannel(channelEnvelope('email', s, 'email-dedupe-00001'), ctx.runtime) },
  slack: {
    sender: SLACK,
    async ingest(ctx, s = SLACK) {
      const adapter = createSlackLeaderAdapter({ ...ctx.runtime, call: ctx.runtime.slackCall });
      const config = { bridgeId: 'slack', teamId: 'T000TEAM', ownUserId: 'U000BOT', ownBotId: 'B000BOT', map: [{ topic: 'leaders', channel: 'D000LEAD' }] };
      const decided = adapter.normalize({ type: 'message', team: 'T000TEAM', user: s, channel: 'D000LEAD', ts: '1793920000.000001', text: TEXT },
        { config: config as never, teamIdentities: loadOwnerThreadSettings(join(ctx.runtime.configDir!)).team });
      if (decided.status !== 'ingest') throw new Error(`slack normalize ignored: ${decided.reason}`);
      return adapter.route(decided.envelope);
    },
  },
};

function spyTransports() {
  const calls: Array<{ channel: string; input: OwnerDelivery }> = [];
  const transports: Partial<Record<OwnerChannel, OwnerChannelTransport>> = {};
  for (const channel of OWNER_CHANNELS) {
    transports[channel] = { async pull() { return []; }, async deliver(input) { calls.push({ channel, input }); return { status: 'sent', reason: 'ok' }; } };
  }
  return { calls, transports };
}

describe('owner channels round trip', () => {
  it('covers every channel in the owner envelope type', () => {
    expect(Object.keys(INTAKE).sort()).toEqual([...OWNER_CHANNELS].sort());
  });

  for (const channel of OWNER_CHANNELS) {
    const entry = INTAKE[channel]!;
    it(`${channel}: lands once with source attribution, dedupes a redelivery, acks on ${channel}`, async () => {
      const ctx = setup();
      await entry.ingest(ctx);
      const inbound = () => readOwnerThread(ctx.thread).messages.filter(line => line.direction === 'inbound');
      expect(inbound()).toHaveLength(1);
      expect(inbound()[0]).toMatchObject({ channel, senderId: entry.sender, text: TEXT, direction: 'inbound' });
      // composeLeaderInbox mints a fresh id per compose and takes no client key, so a desktop resend is a new message (see the todo below).
      if (channel !== 'desktop') {
        await entry.ingest(ctx);
        expect(inbound()).toHaveLength(1);
      }

      const spy = spyTransports();
      const result = await sendOwnerReply({ text: 'Synthetic ack' }, { ...ctx.thread, transports: spy.transports });
      expect(result.status).toBe('sent');
      const external = spy.calls.filter(call => call.channel !== 'desktop');
      // Reply goes to the origin channel (and the desktop thread), never to another owner channel.
      expect(spy.calls.map(call => call.channel).sort()).toEqual([...new Set([channel, 'desktop'])].sort());
      expect(spy.calls.every(call => call.input.text === 'Synthetic ack' && call.input.ownerId === ctx.thread.settings.owners[call.channel as OwnerChannel])).toBe(true);
      if (channel === 'slack') expect(external[0]?.input.channelRef).toBe(SLACK_REF);
      const outbound = readOwnerThread(ctx.thread).messages.filter(line => line.direction === 'outbound');
      expect(outbound).toHaveLength(1);
      expect(outbound[0]).toMatchObject({ channel, replyTo: inbound()[0]!.idempotencyKey });
    });
  }

  it.todo('desktop: a resent compose with the same id is deduped (composeLeaderInbox takes no idempotency key, every compose is a new message)');

  it('imessage: an unverified sender never enters the thread as Mason', async () => {
    const ctx = setup();
    await INTAKE.imessage!.ingest(ctx, '+15550199');
    expect(readOwnerThread(ctx.thread).messages).toEqual([]);
    const spy = spyTransports();
    expect((await sendOwnerReply({ text: 'Synthetic ack' }, { ...ctx.thread, transports: spy.transports })).status).toBe('refused');
    expect(spy.calls).toEqual([]);
  });
});
