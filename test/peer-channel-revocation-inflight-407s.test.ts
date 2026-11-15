import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendPeerMessage, type PeerLedgerRow } from '../src/core/agentnet/peer-bus.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';

const T0 = 1_800_000_000_000;
const PEER_TTL = 86_400_000;
const AGENT2_TTL = 3_600_000;
let root: string, bindings: string, now: number;

const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const peer = (n: number, expiresAt = T0 + 2 * PEER_TTL): PeerBinding => ({
  callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
  sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
  expiresAt, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' });
// agent0 sends; agent1 and agent2 are the eligible enrolled recipients of the channel handoff.
const peers: PeerBinding[] = [peer(0), peer(1), peer(2, T0 + AGENT2_TTL)];
const writePeers = (list: PeerBinding[]) => writeFileSync(bindings, JSON.stringify({ version: 1, peers: list }), { mode: 0o600 });
const policy = (): SlackDeliveryPolicy => ({
  config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[0]!.userId, ownBotId: peers[0]!.botId,
    botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true,
  teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })),
});
// The second conversations.info runs inside deliverSlackEnvelope's audience re-observation, after the
// durable reservation; holding it there opens a deterministic revocation window before readPolicy.
const api = () => {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
  let infos = 0, hit!: () => void, open!: () => void;
  const held = new Promise<void>(resolve => { hit = resolve; });
  const gate = new Promise<void>(resolve => { open = resolve; });
  const call: SlackCall = async (method, args = {}) => {
    calls.push({ method, args });
    if (method === 'conversations.info' && (infos += 1) === 2) { hit(); await gate; }
    if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[0]!.userId, bot_id: peers[0]!.botId };
    if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
      is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
    if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
    if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
    if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
    throw new Error('unexpected-api-method');
  };
  return { call, held, release: () => open(), posts: () => calls.filter(({ method }) => method === 'chat.postMessage') };
};
const options = () => {
  const fake = api();
  return { ...fake, opts: { bindings, busRoot: root, runsDir: root, now: () => now, call: fake.call, readPolicy: () => policy() } };
};
const coordinationRows = (): PeerLedgerRow[] => {
  const file = join(root, 'agentnet', 'coordination.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as PeerLedgerRow[] : [];
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-revoked-handoff-407s-')); bindings = join(root, 'bindings.json'); now = T0;
  writePeers(peers);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const handoff = (conn: ReturnType<typeof options>) =>
  sendPeerMessage({ channel: 'CMESH', kind: 'handoff', text: 'Coordinate the shared context', refs: ['order:nov13'] },
    session(0), conn.opts);
// Start the handoff, wait for the delivery-time audience barrier, mutate, then release.
const inFlight = async (mutate: () => void) => {
  const conn = options();
  const pending = handoff(conn);
  const held = await Promise.race([conn.held.then(() => true), pending.then(() => false)]);
  if (!held) conn.release();
  expect(held, 'handoff settled before the delivery-time barrier').toBe(true);
  mutate();
  conn.release();
  return { sent: await pending, conn };
};
const expectNoExternalPost = async (mutate: () => void) => {
  const { sent, conn } = await inFlight(mutate);
  // The bus receipt and debit rows are durable reservations; slack: refused proves nothing external posted.
  expect(sent).toMatchObject({ status: 'posted', slack: 'refused' });
  expect(conn.posts()).toHaveLength(0);
  expect(coordinationRows().filter(r => r.id === sent.id).map(r => r.target).sort()).toEqual(['CMESH', 'agent1', 'agent2']);
};

describe('peer channel handoff revalidates the debited binding set at delivery', () => {
  it('posts exactly once when the eligible binding set is unchanged through delivery', async () => {
    const { sent, conn } = await inFlight(() => {});
    expect(sent).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    expect(conn.posts()).toHaveLength(1);
    expect(conn.posts()[0]!.args.channel).toBe('CMESH');
  });
  it('refuses the external post when a debited recipient binding is revoked mid-flight', async () => {
    await expectNoExternalPost(() => writePeers(peers.filter(p => p.callsign !== 'agent2')));
  });
  it('refuses the external post when a debited recipient binding is replaced mid-flight', async () => {
    await expectNoExternalPost(() => writePeers(peers.map(p => p.callsign === 'agent2'
      ? { ...p, sessionId: 'session-2b', expiresAt: T0 + 3 * PEER_TTL,
          sessionHash: createHash('sha256').update(JSON.stringify([p.lane, 'session-2b', session(2).token])).digest('hex') }
      : p)));
  });
  it('refuses the external post when a debited recipient binding expires while awaiting', async () => {
    await expectNoExternalPost(() => { now = T0 + AGENT2_TTL; });
  });
  it('refuses the external post when the sender binding is revoked mid-flight', async () => {
    await expectNoExternalPost(() => writePeers(peers.filter(p => p.callsign !== 'agent0')));
  });
  it('fails closed when the bindings file is unreadable at delivery', async () => {
    await expectNoExternalPost(() => writeFileSync(bindings, 'not-json', { mode: 0o600 }));
  });
});
