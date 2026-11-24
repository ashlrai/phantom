import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fakeRequestId } from './helpers/slack-causal.js';
import { leaderReplyEnvelopeId } from '../src/core/agents/slack-reply-identity.js';
import { recordSlackObservation, slackJournalPath } from '../src/core/agents/slack-journal.js';
import { slackThreadRef, type SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import { readFleetSlackEvidence } from '../src/mcp/fleet-slack-evidence.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('documents the persisted same-thread allocation and isolates selected channel and message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-sibling-472s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  const channel = 'D0FAKE472'; const other = 'D0OTHER472';
  const thread = '1731000000.000100'; const first = '1731000010.000100';
  const second = '1731000020.000100'; const reply = '1731000030.000100';
  for (const [channelId, messageTs] of [[channel, first], [channel, second], [other, first], [other, second]]) {
    expect(recordSlackObservation({ at: '2024-11-07T17:20:00.000Z', decision: 'ingested', bus: 'posted',
      channelId, messageTs, threadTs: thread, authorId: 'U0FAKE472',
      requestId: fakeRequestId(`${channelId}:${messageTs}`) }, { runsDir })).toBe('recorded');
  }
  const config: SlackBridgeConfig = { bridgeId: 'slack', teamId: 'T0FAKE472', ownUserId: 'U0BOT472',
    ownBotId: 'B0BOT472', map: [{ topic: 'leader', channel }] };
  const calls: string[] = [];
  const call: SlackCall = async (method, input = {}) => {
    calls.push(method);
    if (method === 'auth.test') return { team_id: config.teamId, user_id: config.ownUserId, bot_id: config.ownBotId };
    if (method === 'conversations.info') return { channel: { id: channel, is_im: true, context_team_id: config.teamId } };
    if (method === 'conversations.members') return { members: ['U0BOT472', 'U0FAKE472'] };
    if (method === 'users.info') return { user: { id: input.user, team_id: config.teamId, ...(input.user === config.ownUserId ? { is_bot: true } : {}) } };
    if (method === 'chat.postMessage') return { channel, ts: reply };
    throw new Error('FAKE-PRIVATE-DIAGNOSTIC-472');
  };
  const delivery = await deliverSlackEnvelope({ id: leaderReplyEnvelopeId(fakeRequestId(`${channel}:${first}`)), from: 'phantom:leader', to: 'leader',
    ttl: 60000, priority: 'P1', body: { kind: 'note', text: 'FAKE-PRIVATE-BODY-472',
      thread: slackThreadRef(config.teamId, channel, thread) } },
  { config, teamIdentities: [{ channel: 'slack', id: 'U0FAKE472' }], confirmedByMason: true, call, stateRoot });
  expect(delivery.status).toBe('sent');
  const paths = [slackJournalPath(runsDir), join(stateRoot, 'messages.json')];
  const before = paths.map(path => readFileSync(path)); const callsBefore = [...calls];
  const select = (channelId: string, messageTs: string) => readFleetSlackEvidence(
    { thread, channelId, messageTs }, { runsDir, stateRoot, now: () => new Date('2024-11-07T18:00:00.000Z') });
  const results = await Promise.all([select(channel, first), select(channel, second), select(other, first), select(other, second)]);
  for (const [index, result] of results.entries()) {
    const expectedChannel = index < 2 ? channel : other;
    const expectedMessage = index % 2 === 0 ? first : second;
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ channelId: expectedChannel, messageTs: expectedMessage });
    expect(result.sources).toEqual({ journal: 'ok', sends: 'ok' });
    expect(result.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
    for (const marker of ['FAKE-PRIVATE-BODY-472', 'FAKE-PRIVATE-DIAGNOSTIC-472', 'U0FAKE472', root]) {
      expect(JSON.stringify(result)).not.toContain(marker);
    }
  }
  // The send is bound by the request's causal reply key: only the request whose
  // id derives the stored key is answered; same-thread siblings and the other
  // channel's identical timestamps are not.
  expect(results[0]!.rows[0]).toMatchObject({ outcome: 'answered', replyTs: reply });
  expect(results[0]!.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  for (const result of results.slice(1)) {
    expect(result.rows[0]).toMatchObject({ outcome: 'unanswered' });
    expect(result.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
  }
  expect(paths.map(path => readFileSync(path))).toEqual(before);
  expect(calls).toEqual(callsBefore);
});
