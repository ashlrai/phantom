import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLeaderNetwork } from '../src/core/agents/leader-network.js';
import { flushSlackLeaderReplies } from '../src/core/agents/slack-leader.js';
import type { SlackCall } from '../src/core/agents/slack-transport.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('resumes persisted rotation past blocked drafts and skips requests awaiting a reply', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-fair-')); roots.push(root);
  const configDir = join(root, 'config'), runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
  mkdirSync(configDir, { mode: 0o700 });
  const configSource = `[mason]\nidentities=[{channel="slack",id="U0OWNER"}]\n[team]\nidentities=[{channel="slack",id="U0OWNER"}]\n[slack]\nbridge_id="slack"\nteam_id="T0TEAM"\nown_user_id="U0BOT"\nown_bot_id="B0BOT"\nbot_token_ref="phm_SLACK_AGENTNET_BOT_TOKEN"\napp_token_ref="phm_SLACK_AGENTNET_APP_TOKEN"\n[[slack.map]]\ntopic="leaders"\nchannel="D0LEADER"\n`;
  writeFileSync(join(configDir, 'agent-network.toml'), configSource, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
  const now = () => Date.parse('2026-11-06T02:00:00Z');
  const network = createLeaderNetwork({ configSource, commsSource: 'confirmedByMason=true', runsDir, busRoot, now,
    deliver: async () => ({ status: 'drafted' }) });
  for (let i = 0; i < 11; i++) {
    const message: BusEnvelope = { id: `fake-request-${i}`, from: 'mason', to: 'leader', priority: 'P0', ttl: 60000,
      channel: 'slack', channel_ref: `slack:T0TEAM:D0LEADER:1793920000.${String(i + 1).padStart(6, '0')}`,
      origin_bridge: 'slack', external: false, sender: { agent_id: 'mason', vendor: 'phantom', human: true, team: true },
      body: { kind: 'note', text: `Fake request ${i}` } };
    const result = await network.ingest({ message, verifiedSender: { channel: 'slack', id: 'U0OWNER' } });
    expect(result.status).toBe('accepted');
    if (i >= 5) expect((await network.reply(result.requestId!, `Fake reply ${i}`)).status).toBe('drafted');
  }
  const posts: string[] = [];
  const call: SlackCall = vi.fn(async (method, body = {}) => {
    if (method === 'auth.test') return { team_id: 'T0TEAM', user_id: 'U0BOT', bot_id: 'B0BOT' };
    if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0TEAM' } };
    if (method === 'conversations.members') return { members: ['U0BOT', 'U0OWNER'], response_metadata: { next_cursor: '' } };
    if (method === 'users.info') return { user: { id: body.user, team_id: 'T0TEAM', is_bot: false } };
    if (method === 'conversations.replies' || method === 'conversations.history') return { messages: [] };
    if (method === 'chat.postMessage') {
      posts.push(String(body.text));
      expect(readFileSync(join(runsDir, 'leader', 'slack-reply-cursor.json'), 'utf8')).toMatch(/^[0-9]+$/);
      if (body.text !== 'Leader: Fake reply 10') throw new Error('fake rate limit');
      return { channel: body.channel, ts: '1793920010.000001' };
    }
    throw new Error('unexpected fake call');
  });
  expect(await flushSlackLeaderReplies({ configDir, runsDir, busRoot, now, call })).toMatchObject({ sent: 0 });
  expect(posts).toHaveLength(5);
  expect(readFileSync(join(runsDir, 'leader', 'slack-reply-cursor.json'), 'utf8')).toBe('5');
  // A fresh invocation reconstructs the network from private files.
  expect(await flushSlackLeaderReplies({ configDir, runsDir, busRoot, now, call })).toMatchObject({ sent: 1 });
  expect(posts[5]).toBe('Leader: Fake reply 10');
  expect((await createLeaderNetwork({ configSource, commsSource: 'confirmedByMason=true', runsDir, busRoot, now }).pending()).some(row => row.replyText === 'Fake reply 10')).toBe(false);
}, 120000);
