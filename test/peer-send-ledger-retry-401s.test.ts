import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPeerMessage, readPeerInbox, PEER_PAIR_LIMIT, PEER_WINDOW_MS } from '../src/core/agentnet/peer-bus.js';
import { readPeerLedger, type PeerLedgerReport } from '../src/core/agentnet/peer-ledger.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import { localWriteGate } from '../src/core/agents/send-gate.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));

const T0 = 1_800_000_000_000;
let root: string, bindings: string, peers: PeerBinding[], now: number;
const session = (n = 0) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const policy = (n = 0): SlackDeliveryPolicy => ({ config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[n]!.userId,
  ownBotId: peers[n]!.botId, botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: true, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) });
const api = (n = 0): SlackCall => vi.fn(async (method, args = {}) => {
  if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
  if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
  if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
  if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
  if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
  throw new Error('unexpected-api-method');
});
/** A fresh caller: new options object and Slack seam on every reconnect, no retained report state. */
const connect = (n: number) => {
  const call = api(n);
  return { call, options: { bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy(n) } };
};

const coordinationFile = () => join(root, 'agentnet', 'coordination.json');
const coordinationRows = () => JSON.parse(readFileSync(coordinationFile(), 'utf8')) as unknown[];
const busReceipts = () => {
  const page = listBusInboxAfter(0, 100, { root });
  if (page.status !== 'ok') throw new Error('bus inbox unreadable');
  return page.messages;
};
const ledger = (at = now) => readPeerLedger({ busRoot: root, now: () => at });
const pair = (report: PeerLedgerReport, fromAgent: string, target: string) =>
  report.pairs.find(p => p.fromAgent === fromAgent && p.target === target);
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-send-retry-')); bindings = join(root, 'bindings.json'); now = T0;
  peers = Array.from({ length: 4 }, (_, n) => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: now + 3_600_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  vi.mocked(localWriteGate).mockReturnValue(null);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe('peer send at the ledger-advertised retryAt', () => {
  it('reconnects through the real broker exactly when the ledger says the pair unblocks', async () => {
    const request = { toAgent: 'agent1', kind: 'task', text: 'Review the parser', refs: ['pr:12'] };
    const firstAt = now;
    for (let i = 0; i < PEER_PAIR_LIMIT; i++) {
      if (i > 0) now += 10_000;
      const { options } = connect(0);
      expect(await sendPeerMessage(request, session(0), options)).toMatchObject({ status: 'posted', slack: 'sent' });
    }
    // Sends landed at T0..T0+50s; this read at T0+55s still sees all six in-window.
    const limited = pair(ledger(T0 + 55_000), 'agent0', 'agent1');
    const retryAtMs = Date.parse(limited!.retryAt!);
    expect(limited).toMatchObject({ inWindow: PEER_PAIR_LIMIT, remaining: 0,
      retryAt: new Date(firstAt + PEER_WINDOW_MS).toISOString() });
    expect(retryAtMs).toBe(firstAt + PEER_WINDOW_MS);

    // One millisecond before retryAt a fresh caller is refused with no side effects.
    now = retryAtMs - 1;
    const before = { rows: coordinationRows().length, receipts: busReceipts().length };
    const early = connect(0);
    expect(await sendPeerMessage(request, session(0), early.options)).toMatchObject({ status: 'refused', reason: 'pair-rate-limit' });
    expect(posts(early.call)).toHaveLength(0);
    expect(coordinationRows()).toHaveLength(before.rows);
    expect(busReceipts()).toHaveLength(before.receipts);

    // An unrelated directed pair stays admissible while the first is blocked.
    const other = connect(2);
    expect(await sendPeerMessage({ toAgent: 'agent3', kind: 'query', text: 'Ping' }, session(2), other.options))
      .toMatchObject({ status: 'posted', slack: 'sent' });
    expect(pair(ledger(now), 'agent2', 'agent3')).toMatchObject({ inWindow: 1, remaining: PEER_PAIR_LIMIT - 1, retryAt: null });

    // At exactly retryAt the real send succeeds, posts once and lands one durable receipt.
    now = retryAtMs;
    const retry = connect(0);
    const sent = await sendPeerMessage(request, session(0), retry.options);
    expect(sent).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    expect(sent.id).toMatch(/^peer-[a-f0-9-]{36}$/);
    expect(posts(retry.call)).toHaveLength(1);
    expect(coordinationRows()).toHaveLength(before.rows + 2);
    expect(busReceipts()).toHaveLength(before.receipts + 2);

    // The receiver sees the retried message exactly once. Note the real inbox
    // semantics exercised here: listBusInboxAfter returns ttl-adjusted envelopes
    // while row.digest covers the original ttl, so only same-clock receipts pass
    // the digest filter; earlier receipts stay durable on the bus (counted above)
    // but are not re-listed at this injected read clock.
    const inbox = readPeerInbox(session(1), 0, connect(1).options);
    if (inbox.status !== 'ok') throw new Error('peer inbox unreadable');
    expect(inbox.messages.filter(m => m.envelope.id === sent.id)).toHaveLength(1);

    // The admitted send consumed the released slot: the pair is full again and the
    // next advertised retry is the following row's expiry, proving real debit.
    const agentnetDir = join(root, 'agentnet');
    const snapshot = { listing: readdirSync(agentnetDir).sort(), bytes: readFileSync(coordinationFile()) };
    const after = ledger(now);
    expect(readdirSync(agentnetDir).sort()).toEqual(snapshot.listing);
    expect(readFileSync(coordinationFile())).toEqual(snapshot.bytes);
    expect(pair(after, 'agent0', 'agent1')).toMatchObject({ inWindow: PEER_PAIR_LIMIT, remaining: 0,
      retryAt: new Date(firstAt + 10_000 + PEER_WINDOW_MS).toISOString() });

    // Ledger output carries no bindings or session material.
    const text = JSON.stringify(after);
    for (const secret of [session(0).token, session(1).token, peers[0]!.sessionHash, peers[0]!.userId,
      peers[0]!.botId, peers[0]!.teamId, peers[0]!.lane, peers[0]!.sessionId, 'phm_SLACK_AGENTNET_BOT_TOKEN'])
      expect(text).not.toContain(secret);
    expect(after.authority).toBe('none');
  }, 20_000);
});
