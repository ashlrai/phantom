/** Mixed actors share a thread, never a Leader reply identity or work claim. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createSlackLeaderAdapter, readSlackDeliveryPolicy } from '../src/core/agents/slack-leader.js';
import { openSlackSocket, type SlackCall } from '../src/core/agents/slack-transport.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import { readSlackRequestTrace } from '../src/core/agents/slack-request-trace.js';
import { leaderReplySendKey } from '../src/core/agents/slack-reply-identity.js';
import { readSlackWorkStatus } from '../src/core/agents/slack-status.js';

it.each(['peer-first', 'owner-first'])('isolates durable same-thread replies across restart: %s', async order => {
  const root = mkdtempSync(join(tmpdir(), 'slack-peer-owner-497s-'));
  try {
    const owner = 'U0FAKEOWNER', peer = 'U0FAKEPEER', bot = 'U0FAKEBOT', team = 'T0FAKETEAM';
    const channel = 'D0FAKELEADER', thread = '1793920000.000001';
    const options = { configDir: join(root, 'config'), runsDir: join(root, 'runs'), busRoot: join(root, 'bus'),
      now: () => Date.parse('2026-11-06T02:00:00Z') };
    mkdirSync(options.configDir, { mode: 0o700 });
    writeFileSync(join(options.configDir, 'agent-network.toml'),
      `[mason]\nidentities=[{channel="slack",id="${owner}"}]\n[team]\n` +
      `identities=[{channel="slack",id="${owner}"},{channel="slack",id="${peer}"}]\n` +
      `[slack]\nbridge_id="slack"\nteam_id="${team}"\nown_user_id="${bot}"\nown_bot_id="B0FAKEBOT"\n` +
      `bot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n` +
      `[[slack.map]]\ntopic="leaders"\nchannel="${channel}"\n`, { mode: 0o600 });
    writeFileSync(join(options.configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const posts: Record<string, unknown>[] = [];
    const event = (user: string, n: number) => ({ type: 'events_api', envelope_id: `Ev-fake-${n}-delivery`,
      payload: { team_id: team, event_id: `Ev-fake-${n}`, event: { type: 'message', user, channel,
        ts: `179392000${n}.000001`, thread_ts: thread, text: "how's the fleet?" } } });
    // Every delivery gets new authenticated transport, policy, Leader and status adapters.
    const receive = async (payload: ReturnType<typeof event>) => {
      const call: SlackCall = async (method, body = {}) => {
        if (method === 'auth.test') return { team_id: team, user_id: bot, bot_id: 'B0FAKEBOT' };
        if (method === 'apps.connections.open') return { url: 'wss://wss-primary.slack.com/FAKE-EXAMPLE' };
        if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: team } };
        if (method === 'conversations.members') return { members: [bot, owner, peer], response_metadata: { next_cursor: '' } };
        if (method === 'users.info') return { user: { id: body.user, team_id: team, is_bot: body.user === bot } };
        if (method === 'chat.postMessage') { posts.push(body); return { channel, ts: `179392001${posts.length}.000001` }; }
        if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
        throw new Error('unexpected synthetic Slack method');
      };
      const policy = readSlackDeliveryPolicy({ ...options })!;
      const adapter = createSlackLeaderAdapter({ ...options, call, statusReply: ownerStatusReply({
        brief: async () => 'Morning leader brief\nShipped (last 12h): none',
      }) });
      let routed: Awaited<ReturnType<typeof adapter.route>> | undefined;
      const handlers: Record<string, (event: { data?: unknown }) => void> = {};
      const ack = Promise.withResolvers<string>();
      const socket = { readyState: 1, addEventListener: (type: string, fn: (event: { data?: unknown }) => void) => { handlers[type] = fn; },
        send: (data: string) => ack.resolve(data), close: vi.fn() };
      await openSlackSocket({ call, config: policy.config, ingest: { config: policy.config,
        teamIdentities: policy.teamIdentities, runsDir: options.runsDir, busRoot: options.busRoot },
      leaderAdapter: { ...adapter, route: async envelope => routed = await adapter.route(envelope) }, connect: () => socket });
      handlers.message!({ data: JSON.stringify(payload) });
      expect(await ack.promise).toBe(JSON.stringify({ envelope_id: payload.envelope_id }));
      const answer = await routed?.statusAnswer;
      socket.close();
      return { routed, answer };
    };
    const store = () => JSON.parse(readFileSync(join(options.runsDir, 'slack-transport/messages.json'), 'utf8')) as {
      messages: Record<string, { state: string; channel: string; thread: string; ts: string }> };
    const trace = () => readSlackRequestTrace({ runsDir: options.runsDir,
      stateRoot: join(options.runsDir, 'slack-transport'), now: () => new Date(options.now()) });
    const assertEvidence = (owners: number) => {
      const journal = readSlackJournal({ runsDir: options.runsDir });
      expect(journal.state).toBe('ok');
      const ownerRows = journal.entries.filter(row => row.messageTs !== '1793920001.000001');
      expect(ownerRows).toHaveLength(owners);
      const keys = ownerRows.map(row => { expect(row.requestId).toMatch(/^[a-f0-9]{64}$/); return leaderReplySendKey(row.requestId!); });
      expect(new Set(keys).size).toBe(owners);
      expect(Object.keys(store().messages).sort()).toEqual(keys.sort());
      for (const receipt of Object.values(store().messages)) expect(receipt).toMatchObject({ state: 'sent', channel, thread });
      const peerRows = journal.entries.filter(row => row.messageTs === '1793920001.000001');
      expect(peerRows.length).toBeGreaterThan(0);
      for (const row of peerRows) expect(row.requestId).toBeUndefined();
      const result = trace();
      expect(result.sources).toEqual({ journal: 'ok', sends: 'ok' });
      expect(result.counts.answered).toBe(owners);
      expect(result.rows).toHaveLength(journal.entries.length);
      for (const row of result.rows) {
        expect(row).toMatchObject({ channelId: channel, threadTs: thread });
        if (row.messageTs === '1793920001.000001') {
          expect(row).toMatchObject({ outcome: 'uncertain', evidence: 'unverified' });
          expect(row.replyTs).toBeUndefined();
        } else expect(row).toMatchObject({ outcome: 'answered', replyTs: row.messageTs === '1793920002.000001' ? '1793920011.000001' : '1793920012.000001' });
      }
      const work = readSlackWorkStatus({ ...options, now: () => new Date(options.now()) });
      expect(work.inbox).toBe('ok');
      for (const item of work.items) expect(item).toMatchObject({ owner: null, claimReceipt: null, state: 'RECEIVED' });
    };
    const peerMessage = event(peer, 1), ownerMessage = event(owner, 2);
    for (const message of order === 'peer-first' ? [peerMessage, ownerMessage] : [ownerMessage, peerMessage]) {
      const result = await receive(message);
      if (message === ownerMessage) expect(result.answer).toEqual({ answered: true, reason: 'answered in-thread' });
      else expect(result.routed).toEqual({ owned: false, durable: false });
    }
    expect(posts).toHaveLength(1); assertEvidence(1);
    const retained = store();
    await receive(peerMessage);
    expect(posts).toHaveLength(1); expect(store()).toEqual(retained); assertEvidence(1);
    expect((await receive(event(owner, 3))).answer).toEqual({ answered: true, reason: 'answered in-thread' });
    expect(posts).toHaveLength(2); assertEvidence(2);
    for (const post of posts) expect(post).toMatchObject({ channel, thread_ts: thread,
      attachments: [expect.objectContaining({ text: expect.stringMatching(/owner unknown; claim unknown/) })] });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
