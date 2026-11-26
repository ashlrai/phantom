import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdAgentnet } from '../src/cli/agentnet.js';
import { sendPeerMessage } from '../src/core/agentnet/peer-bus.js';
import { peerInboxMessageMatches, parsePeerInboxFilters,
  type PeerInboxMessage } from '../src/core/agentnet/peer-inbox.js';
import type { PeerBinding } from '../src/core/agentnet/slack-identities.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));

const peerBody = (kind: string, text: string, threadId?: string) => ({
  kind: 'peer.message',
  peer: { fromAgent: 'agent0', toAgent: 'agent1', kind, text, refs: [],
    ...(threadId === undefined ? {} : { threadId }), origin: 'peer-origin', hopCount: 1 },
});
const envelope = (body: unknown, id: string): BusEnvelope => ({
  id, from: 'agent0', to: 'agent1', priority: 'P2', ttl: 86_400_000, body: body as BusEnvelope['body'],
});
const message = (body: unknown, options: { receivedAt?: number; id?: string } = {}): PeerInboxMessage => ({
  cursor: 7, receivedAt: options.receivedAt ?? 1_000,
  envelope: envelope(body, options.id ?? 'peer-00000000-0000-0000-0000-000000000001'),
});
const filters = (input: Parameters<typeof parsePeerInboxFilters>[0]) => {
  const query = parsePeerInboxFilters(input, 10_000);
  if (!query.ok) throw new Error('fixture filters must parse');
  return query.filters;
};

describe('parsePeerInboxFilters', () => {
  it('resolves every filter and anchors relative times once', () => {
    const query = parsePeerInboxFilters({ from: 'agent0', excludeFrom: 'agent2', to: 'mesh',
      since: '15m', before: '2h', contains: '  Deploy   THE fix ', id: 'peer-x', kind: 'peer.message',
      peerKind: 'task', thread: 'sprint-7', job: 'RQ-1', result: 'complete' }, 10_000_000);
    expect(query).toEqual({ ok: true, filters: {
      from: 'agent0', excludeFrom: 'agent2', to: 'mesh', since: 9_100_000, before: 2_800_000,
      contains: 'deploy the fix', id: 'peer-x', kind: 'peer.message', peerKind: 'task',
      thread: 'sprint-7', job: 'RQ-1', result: 'complete' } });
    expect(parsePeerInboxFilters({}, 0)).toEqual({ ok: true, filters: {} });
  });
  it.each([
    [{ from: 'has space' }], [{ to: 'tab\there' }], [{ id: '' }], [{ kind: 'a'.repeat(129) }],
    [{ thread: 'two words' }], [{ job: 'x'.repeat(129) }], [{ peerKind: 'dm' }], [{ result: 'merged' }],
    [{ since: 'soon' }], [{ before: '1x' }], [{ contains: '' }], [{ contains: 'x'.repeat(513) }],
  ])('refuses malformed input %j', input => {
    expect(parsePeerInboxFilters(input)).toEqual({ ok: false });
  });
});

describe('peerInboxMessageMatches', () => {
  const task = message(peerBody('task', 'Review the parser', 'sprint-7'));
  const review = message(peerBody('review', 'Looks fine'), { receivedAt: 2_000, id: 'peer-00000000-0000-0000-0000-000000000002' });
  const workPost = message({ kind: 'work.post', jobId: 'RQ-PEER-1', title: 'Fix docs', repo: 'fake/repo', claimKeys: [] });
  const workResult = message({ kind: 'work.result', jobId: 'RQ-PEER-1', claimKey: 'queue:peer-work-abc',
    queueId: 'peer-work-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', receiptId: 'pw-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    outcome: 'complete' });
  const note = message({ kind: 'note', text: 'hello', thread: 'job:RQ-9' });
  it('matches every filter against the admitted row fields', () => {
    expect(peerInboxMessageMatches(task, {})).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ from: 'agent0' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ from: 'agent2' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ excludeFrom: 'agent0' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ excludeFrom: 'agent2' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ to: 'agent1' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ to: 'mesh' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ id: task.envelope.id }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ id: 'peer-other' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ since: '500', before: '2000' }))).toBe(true);
    expect(peerInboxMessageMatches(review, filters({ since: '500', before: '2000' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ since: '2000' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ before: String(task.receivedAt) }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ before: String(task.receivedAt + 1) }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ contains: 'PARSER' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ contains: 'absent' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ kind: 'peer.message' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ kind: 'work.post' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ peerKind: 'task' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ peerKind: 'review' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ thread: 'sprint-7' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ thread: 'other' }))).toBe(false);
    expect(peerInboxMessageMatches(workPost, filters({ job: 'RQ-PEER-1' }))).toBe(true);
    expect(peerInboxMessageMatches(task, filters({ job: 'RQ-PEER-1' }))).toBe(false);
    expect(peerInboxMessageMatches(workResult, filters({ result: 'complete' }))).toBe(true);
    expect(peerInboxMessageMatches(workResult, filters({ result: 'failed' }))).toBe(false);
    expect(peerInboxMessageMatches(task, filters({ result: 'complete' }))).toBe(false);
    expect(peerInboxMessageMatches(note, filters({ thread: 'job:RQ-9' }))).toBe(true);
    expect(peerInboxMessageMatches(note, filters({ kind: 'note' }))).toBe(true);
  });
  it('lets --peer-kind and --result never match foreign body kinds', () => {
    expect(peerInboxMessageMatches(workPost, filters({ peerKind: 'task' }))).toBe(false);
    expect(peerInboxMessageMatches(workPost, filters({ result: 'complete' }))).toBe(false);
    expect(peerInboxMessageMatches(review, filters({ peerKind: 'review' }))).toBe(true);
    expect(peerInboxMessageMatches(review, filters({ peerKind: 'task' }))).toBe(false);
  });
});

describe('phm agentnet peers read filters', () => {
  let root: string, bindings: string, now: number;
  const session = (n: number) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-${'a'.repeat(32)}` });
  let peers: PeerBinding[];
  const policy = (n: number): SlackDeliveryPolicy => ({ config: { bridgeId: 'slack', teamId: 'TTEAM',
    ownUserId: peers[n]!.userId, ownBotId: peers[n]!.botId, botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN',
    map: [{ topic: 'mesh', channel: 'CMESH' }] }, confirmedByMason: true,
    teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) });
  const api = (n: number): SlackCall => vi.fn(async (method, args = {}) => {
    if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
    if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false,
      is_ext_shared: false, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
    if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
    if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
    if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
    throw new Error('unexpected-api-method');
  });
  const options = (n: number) => ({ bindings, busRoot: root, runsDir: root, now: () => now, call: api(n), readPolicy: () => policy(n) });
  const read = async (n: number, flags: string[] = []) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdAgentnet(['peers', 'read', ...flags, '--json'], options(n), session(n));
    expect(code).toBe(0);
    return JSON.parse(log.mock.calls.at(-1)![0] as string) as {
      status: string; nextCursor: number; workResults: string;
      messages: Array<{ cursor: number; receivedAt: number; envelope: { id: string; from: string; to: string; body: { kind?: string } } }>;
    };
  };
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'peer-inbox-filters-')); bindings = join(root, 'bindings.json'); now = 1_794_000_000_000;
    peers = Array.from({ length: 3 }, (_, n) => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
      sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
      expiresAt: now + 86_400_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
    writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

  it('narrows the admitted page without changing admission or cursor shape', async () => {
    const task = await sendPeerMessage({ toAgent: 'agent1', kind: 'task', text: 'Review the parser', threadId: 'sprint-7' }, session(0), options(0));
    expect(task).toMatchObject({ status: 'posted' });
    const query = await sendPeerMessage({ toAgent: 'agent1', kind: 'query', text: 'Status?' }, session(2), options(2));
    expect(query).toMatchObject({ status: 'posted' });
    const foreign = await sendPeerMessage({ toAgent: 'agent2', kind: 'task', text: 'Not for agent1' }, session(0), options(0));
    expect(foreign).toMatchObject({ status: 'posted' });
    const channel = await sendPeerMessage({ channel: 'CMESH', kind: 'social', text: 'Hello all' }, session(0), options(0));
    expect(channel).toMatchObject({ status: 'posted' });
    const work = await sendPeerMessage({ toAgent: 'agent1', kind: 'task', text: 'Work feed proposal',
      work: { kind: 'work.post', jobId: 'RQ-PEER-1', title: 'Fix docs', repo: 'fake/repo', claimKeys: [], provider: 'codex-cmp' } },
      session(0), options(0));
    expect(work).toMatchObject({ status: 'posted' });
    // agent1's review reply inherits the task's thread and lands in agent0's inbox.
    const review = await sendPeerMessage({ toAgent: 'agent0', kind: 'review', text: 'Looks fine', replyTo: task.id }, session(1), options(1));
    expect(review).toMatchObject({ status: 'posted' });

    const all = await read(1);
    expect(all.status).toBe('ok');
    expect(all.workResults).toBe('missing');
    // agent2's DM is never admitted; the rest are agent1's page.
    expect(all.messages.map(m => m.envelope.id).sort()).toEqual(
      [task.id, query.id, channel.id, work.id].sort());
    expect(all.nextCursor).toBeGreaterThan(0);

    expect((await read(1, ['--peer-kind', 'task'])).messages.map(m => m.envelope.id)).toEqual([task.id]);
    expect((await read(1, ['--peer-kind', 'query'])).messages.map(m => m.envelope.id)).toEqual([query.id]);
    expect((await read(1, ['--peer-kind', 'social'])).messages.map(m => m.envelope.id)).toEqual([channel.id]);
    expect((await read(1, ['--peer-kind', 'review'])).messages).toEqual([]);
    expect((await read(1, ['--kind', 'work.post'])).messages.map(m => m.envelope.id)).toEqual([work.id]);
    expect((await read(1, ['--kind', 'peer.message'])).messages).toHaveLength(3);
    expect((await read(1, ['--thread', 'sprint-7'])).messages.map(m => m.envelope.id)).toEqual([task.id]);
    expect((await read(0, ['--thread', 'sprint-7'])).messages.map(m => m.envelope.id)).toEqual([review.id]);
    expect((await read(1, ['--from', 'agent0'])).messages).toHaveLength(3);
    expect((await read(1, ['--from', 'agent2'])).messages.map(m => m.envelope.id)).toEqual([query.id]);
    expect((await read(1, ['--exclude-from', 'agent0'])).messages.map(m => m.envelope.id)).toEqual([query.id]);
    expect((await read(1, ['--to', 'mesh'])).messages.map(m => m.envelope.id)).toEqual([channel.id]);
    expect((await read(1, ['--to', 'agent1'])).messages).toHaveLength(3);
    expect((await read(1, ['--contains', 'parser'])).messages.map(m => m.envelope.id)).toEqual([task.id]);
    expect((await read(1, ['--contains', 'fix docs'])).messages.map(m => m.envelope.id)).toEqual([work.id]);
    expect((await read(1, ['--job', 'RQ-PEER-1'])).messages.map(m => m.envelope.id)).toEqual([work.id]);
    expect((await read(1, ['--result', 'complete'])).messages).toEqual([]);
    expect((await read(1, ['--id', task.id])).messages.map(m => m.envelope.id)).toEqual([task.id]);
    expect((await read(1, ['--since', '1d'])).messages).toHaveLength(4);
    expect((await read(1, ['--before', '1s'])).messages).toEqual([]);
    // Filters compose and never widen admission: agent2's DM stays invisible.
    expect((await read(1, ['--peer-kind', 'task', '--from', 'agent2'])).messages).toEqual([]);
    expect((await read(1, ['--after', String(all.nextCursor)]))).toMatchObject({ status: 'ok' });
  }, 120_000);

  it('refuses read filters on every other verb and malformed filter values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdAgentnet(['peers', 'send', 'agent1', 'query', 'Status?', '--from', 'forged'], options(0), session(0))).toBe(2);
    expect(await cmdAgentnet(['peers', 'list', '--kind', 'task'], options(0), session(0))).toBe(2);
    expect(await cmdAgentnet(['peers', 'dispatch', '--peer-kind', 'task'], options(0), session(0))).toBe(2);
    expect(await cmdAgentnet(['peers', 'read', '--peer-kind', 'dm'], options(1), session(1))).toBe(2);
    expect(await cmdAgentnet(['peers', 'read', '--result', 'merged'], options(1), session(1))).toBe(2);
    expect(await cmdAgentnet(['peers', 'read', '--since', 'soon'], options(1), session(1))).toBe(2);
    expect(await cmdAgentnet(['peers', 'read', '--from'], options(1), session(1))).toBe(2);
    expect(log).not.toHaveBeenCalled();
  });
});
