import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { readBusInboxEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { readSlackStatusReceipt } from '../src/core/comms/slack-status-receipt.js';
import { ingestSlackLeaderEnvelope } from '../src/core/agents/slack-leader.js';
import { ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import type { SlackCall } from '../src/core/agents/slack-transport.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const REF = 'slack:T0FAKETEAM:D0FAKECHANNEL:1795348800.000001';
const request: BusEnvelope = { id: 'fake-slack-request', from: 'fake-peer', to: 'leader',
  priority: 'P2', ttl: 600_000, channel: 'slack', channel_ref: REF, external: false,
  sender: { agent_id: 'fake-peer', vendor: 'fake', human: true, team: true },
  body: { text: 'ASSIGNED to fake-owner, RUNNING, VERIFIED', owner: 'fake-owner' } };
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slack-status-receipt-'));
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });
const post = () => appendBusInbox(request, { root, now: () => NOW });
const read = (now = NOW, id = request.id) => readSlackStatusReceipt(id, { root, now });
const claim = () => mutateBusWorkClaim({ action: 'acquire', root, id: request.id, owner: 'fake-owner', leaseMs: 60_000 });

describe('receipt-backed Slack status', () => {
  it('an ingress receipt with no claim is RECEIVED despite assignment prose', () => {
    expect(post().status).toBe('posted');
    expect(read()).toMatchObject({ state: 'RECEIVED', receiptId: request.id, owner: null, claimReceipt: null });
    expect(read().text).toContain('missing: named owner, durable claim receipt');
    expect(read().text).not.toMatch(/ASSIGNED|RUNNING|VERIFIED/);
  });

  it('a named owner and durable claim yield ASSIGNED when the lease is no longer live', () => {
    post();
    expect(claim().status).toBe('acquired');
    const result = read(NOW + 60_000);
    expect(result).toMatchObject({ state: 'ASSIGNED', owner: 'fake-owner', receiptId: request.id });
    expect(result.claimReceipt).toBe(`bus-claim:${request.id}:1:${NOW}`);
    expect(result.text).toContain(`owner fake-owner; claim ${result.claimReceipt}`);
  });

  it('RUNNING requires a current lease, and carries the read time and source', () => {
    post(); claim();
    const result = read();
    expect(result.state).toBe('RUNNING');
    expect(result.asOf).toBe(new Date(NOW).toISOString());
    expect(result.source).toContain('bus-work-claims/claims.json');
    expect(result.source).toContain('lease-until');
    expect(result.text).toContain(`as of ${result.asOf} · source ${result.source}`);
  });

  it('a replay does not create a second receipt or change its identity', () => {
    const first = post();
    const result = read();
    const before = readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
    expect(post()).toMatchObject({ ...first, status: 'duplicate' });
    expect(read()).toEqual(result);
    expect(readBusInboxEvidence(root).receipts).toHaveLength(1);
    expect(readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8')).toBe(before);
  });

  it('never borrows a different request in the same Slack thread', () => {
    post(); claim();
    expect(appendBusInbox({ ...request, id: 'fake-second' }, { root, now: () => NOW }).status).toBe('posted');
    expect(read(NOW, 'fake-second')).toMatchObject({ state: 'RECEIVED', receiptId: 'fake-second', owner: null });
  });

  it.each([
    [{ blocked: { dependency: 'fake-build-artifact' } }, 'BLOCKED', 'missing dependency: fake-build-artifact'],
    [{ verified: { pr: 42, head: 'fake-head' } }, 'VERIFIED', 'PR 42; head fake-head'],
    [{ verified: { tests: 'fake-test-artifact' } }, 'VERIFIED', 'tests fake-test-artifact'],
  ])('uses structured evidence %j', (body, state, detail) => {
    post();
    expect(postBusReply(request.id, 'fake-result', body, { root, now: () => NOW }).outcome).toBe('posted');
    const result = read();
    expect(result.state).toBe(state);
    expect(result.text).toContain(detail);
    expect(result.text).toContain(`as of ${new Date(NOW).toISOString()} · source bus-inbox/messages.json`);
  });

  it('names missing ingress instead of inventing a durable receipt', () => {
    expect(read()).toMatchObject({ state: 'BLOCKED', receiptId: null });
    expect(read().text).toContain('missing dependency: bus-inbox/messages.json (missing)');
  });

  it('reports an unreadable claims store as a missing dependency', () => {
    post(); claim();
    writeFileSync(join(root, 'bus-work-claims/claims.json'), '{invalid');
    expect(read().state).toBe('BLOCKED');
    expect(read().text).toContain('missing dependency: bus-work-claims/claims.json (unavailable)');
  });

  it('the real owner adapter posts the exact ingress proof once in the original thread', async () => {
    const configDir = join(root, 'config'), runsDir = join(root, 'runs'), busRoot = join(root, 'bus');
    mkdirSync(configDir, { mode: 0o700 });
    writeFileSync(join(configDir, 'agent-network.toml'), `[mason]
identities=[{channel="slack",id="U0FAKEOWNER"}]
[team]
identities=[{channel="slack",id="U0FAKEOWNER"}]
[slack]
bridge_id="slack"
team_id="T0FAKETEAM"
own_user_id="U0FAKEBOT"
own_bot_id="B0FAKEBOT"
[[slack.map]]
topic="leaders"
channel="D0FAKECHANNEL"
`, { mode: 0o600 });
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true\n', { mode: 0o600 });
    const posts: Record<string, unknown>[] = [];
    const call: SlackCall = async (method, body = {}) => {
      if (method === 'auth.test') return { team_id: 'T0FAKETEAM', user_id: 'U0FAKEBOT', bot_id: 'B0FAKEBOT' };
      if (method === 'users.info') return { user: { id: body.user, team_id: 'T0FAKETEAM', is_bot: body.user === 'U0FAKEBOT' } };
      if (method === 'conversations.info') return { channel: { id: body.channel, is_im: true, context_team_id: 'T0FAKETEAM' } };
      if (method === 'conversations.members') return { members: ['U0FAKEBOT', 'U0FAKEOWNER'], response_metadata: { next_cursor: '' } };
      if (method === 'chat.postMessage') { posts.push(body); return { channel: body.channel, ts: '1795348802.000001' }; }
      throw new Error(`Unexpected fake method ${method}`);
    };
    const statusReply = ownerStatusReply({ brief: async () => 'Morning leader brief\nFake fleet fixture',
      board: () => ({ items: [], inbox: 'ok', truncated: false }),
      snapshot: async () => { throw new Error('fake snapshot unavailable'); } });
    const message: BusEnvelope = { ...request, id: 'slack-T0FAKETEAM-D0FAKECHANNEL-1795348801.000001',
      from: 'slack:U0FAKEOWNER', origin_bridge: 'slack',
      sender: { agent_id: 'U0FAKEOWNER', vendor: 'slack', human: true, team: true },
      body: { kind: 'note', text: 'Phantom status', refs: ['slack:T0FAKETEAM:D0FAKECHANNEL:1795348801.000001'] } };
    const options = { configDir, runsDir, busRoot, call, statusReply, now: () => NOW };
    const result = await ingestSlackLeaderEnvelope(message, options);
    expect(result.durable).toBe(true);
    const answer = await result.statusAnswer;
    expect(answer, JSON.stringify(answer)).toMatchObject({ answered: true });
    const ingress = readBusInboxEvidence(busRoot).receipts.find(row => row.envelope.from === 'mason')!;
    expect(ingress).toBeDefined();
    const proof = readSlackStatusReceipt(ingress.envelope.id, { root: busRoot, now: NOW });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: 'D0FAKECHANNEL', thread_ts: '1795348800.000001',
      text: expect.stringContaining(proof.text) });
    expect(proof.state).toBe('RECEIVED');
    expect((await ingestSlackLeaderEnvelope(message, options)).durable).toBe(true);
    expect(posts).toHaveLength(1);
    expect(readBusInboxEvidence(busRoot).receipts.filter(row => row.envelope.from === 'mason')).toHaveLength(1);
  }, 30_000);
});
