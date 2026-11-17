import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readPeerInbox, sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import type { PeerSession } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';

it('recovers a delivered handoff after replacing the recipient session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'peer-renewal-407s-'));
  try {
    const now = 1_800_000_000_000, bindings = join(root, 'bindings.json');
    const session = (id: string): PeerSession => ({ lane: `lane-${id}`, sessionId: `session-${id}`, token: `synthetic-${id}-${'a'.repeat(32)}` });
    const sender = session('sender'), old = session('recipient'), renewed = { ...session('renewed'), lane: old.lane };
    const hash = (s: PeerSession) => createHash('sha256').update(JSON.stringify([s.lane, s.sessionId, s.token])).digest('hex');
    const binding = (s: PeerSession, n: number) => ({ callsign: `agent${n}`, lane: s.lane, sessionId: s.sessionId,
      sessionHash: hash(s), expiresAt: now + 86_400_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' });
    const peers = [binding(sender, 0), binding(old, 1)];
    const replace = () => { const temp = `${bindings}.new`; writeFileSync(temp, JSON.stringify({ version: 1, peers }), { mode: 0o600 }); renameSync(temp, bindings); };
    replace();
    const policy: SlackDeliveryPolicy = { config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: 'UAGENT0', ownBotId: 'BAGENT0',
      botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] }, confirmedByMason: true,
    teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) };
    let posts = 0;
    const call: SlackCall = async (method, args = {}) => {
      if (method === 'auth.test') return { team_id: 'TTEAM', user_id: 'UAGENT0', bot_id: 'BAGENT0' };
      if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
        is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
      if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
      if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
      if (method === 'chat.postMessage') { posts++; return { channel: args.channel, ts: '1794000000.000001' }; }
      throw new Error('unexpected-api-method');
    };
    const options = () => ({ bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy });
    const sent = await sendPeerMessage({ toAgent: 'agent1', kind: 'task', text: 'Coordinate the shared context' }, sender, options());
    expect(sent).toMatchObject({ status: 'posted', slack: 'sent' });
    expect(posts).toBe(1);
    const bus = join(root, 'bus-inbox', 'messages.json'), ledger = join(root, 'agentnet', 'coordination.json');
    const durable = [readFileSync(bus), readFileSync(ledger)];
    peers[1] = { ...peers[1]!, sessionId: renewed.sessionId, sessionHash: hash(renewed), expiresAt: now + 100_000 };
    replace();
    const page = readPeerInbox(renewed, 0, options());
    expect(page.status).toBe('ok');
    if (page.status !== 'ok') throw new Error('peer inbox unavailable');
    expect(page.messages.map(m => m.envelope.id)).toEqual([sent.id]);
    const cursor = page.messages[0]!.cursor;
    const resumed = readPeerInbox(renewed, cursor, options());
    expect(resumed.status).toBe('ok');
    if (resumed.status !== 'ok') throw new Error('peer inbox unavailable');
    expect(resumed.messages).toEqual([]);
    expect(() => readPeerInbox(old, 0, options())).toThrow('peer-session-refused');
    chmodSync(bindings, 0o644);
    expect(() => readPeerInbox(renewed, 0, options())).toThrow();
    chmodSync(bindings, 0o600);
    peers[1] = { ...peers[1]!, expiresAt: now };
    replace();
    expect(() => readPeerInbox(renewed, 0, options())).toThrow('peer-session-refused');
    expect([readFileSync(bus), readFileSync(ledger)]).toEqual(durable);
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
