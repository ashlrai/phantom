import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
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

describe('Slack status evidence clock', () => {
  it.each([
    [{ blocked: { dependency: 'fake-dependency' } }, 'BLOCKED'],
    [{ verified: { tests: 'fake-tests' } }, 'VERIFIED'],
  ])('retains the selected reply time for %s', (body, state) => {
    post();
    const evidenceTime = NOW + 1_000;
    expect(postBusReply(request.id, 'fake-result', body, { root, now: () => evidenceTime }).outcome).toBe('posted');
    const path = join(root, 'bus-inbox/messages.json');
    const bytes = readFileSync(path, 'utf8');
    const first = read(NOW + 3_600_000);
    const second = read(NOW + 7_200_000);
    expect(first).toMatchObject({ state, asOf: new Date(NOW + 3_600_000).toISOString(), evidenceAsOf: new Date(evidenceTime).toISOString() });
    expect(second.asOf).toBe(new Date(NOW + 7_200_000).toISOString());
    expect(second.evidenceAsOf).toBe(first.evidenceAsOf);
    expect(first.text).toContain(`evidence as of ${first.evidenceAsOf}`);
    expect(second.text).toContain(`evidence as of ${first.evidenceAsOf}`);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });

  it('uses the receive time for RECEIVED and reports dependency observation without an onset', () => {
    post();
    expect(read(NOW + 3_600_000)).toMatchObject({ state: 'RECEIVED', evidenceAsOf: new Date(NOW).toISOString() });
    mkdirSync(join(root, 'bus-work-claims'), { recursive: true });
    writeFileSync(join(root, 'bus-work-claims/claims.json'), '{invalid');
    const result = read(NOW + 3_600_000);
    expect(result).toMatchObject({ state: 'BLOCKED', asOf: new Date(NOW + 3_600_000).toISOString(), evidenceAsOf: 'unknown' });
    expect(result.text).toContain('evidence as of unknown');
    expect(result.text).toContain('dependency observed at read time; onset unknown');
    expect(result.text).toContain('bus-work-claims/claims.json (unavailable)');
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
    expect(posts[0].text).toContain(`evidence as of ${new Date(NOW).toISOString()}`);
    expect((await ingestSlackLeaderEnvelope(message, options)).durable).toBe(true);
    expect(posts).toHaveLength(1);
    expect(readBusInboxEvidence(busRoot).receipts.filter(row => row.envelope.from === 'mason')).toHaveLength(1);
  }, 30_000);
});
