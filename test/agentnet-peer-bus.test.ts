import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendPeerMessage, readPeerInbox, PEER_PAIR_LIMIT } from '../src/core/agentnet/peer-bus.js';
import { listPeers, proposeSlackAction, readPeerBindings, type PeerBinding } from '../src/core/agentnet/slack-identities.js';
import { cosPeerPlanSchema, emitCosPeerPlan } from '../src/core/cos/peer-plan.js';
import { cmdAgentnet } from '../src/cli/agentnet.js';
import { localWriteGate } from '../src/core/agents/send-gate.js';
import type { SlackCall, SlackDeliveryPolicy } from '../src/core/agents/slack-transport.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { busWorkFeedPendingToMatcher } from '../src/core/agents/bus-work-feed-read.js';
import { readPeerFleet, type PeerWorkFeedQuery } from '../src/core/agentnet/mesh-read.js';
vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: vi.fn(() => null) }));
let root: string, bindings: string, peers: PeerBinding[], now: number, shared: boolean, approved: boolean;
const session = (n = 0) => ({ lane: `lane-${n}`, sessionId: `session-${n}`, token: `synthetic-session-${n}-` + 'a'.repeat(32) });
const policy = (n = 0): SlackDeliveryPolicy => ({ config: { bridgeId: 'slack', teamId: 'TTEAM', ownUserId: peers[n]!.userId,
  ownBotId: peers[n]!.botId, botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'mesh', channel: 'CMESH' }] },
  confirmedByMason: approved, teamIdentities: peers.map(p => ({ channel: 'slack', id: p.userId })) });
const api = (n = 0): SlackCall => vi.fn(async (method, args = {}) => {
  if (method === 'auth.test') return { team_id: 'TTEAM', user_id: peers[n]!.userId, bot_id: peers[n]!.botId };
  if (method === 'conversations.info') return { channel: { id: 'CMESH', is_channel: true, is_shared: false, is_ext_shared: shared, is_pending_ext_shared: false, context_team_id: 'TTEAM' } };
  if (method === 'conversations.members') return { members: peers.map(p => p.userId) };
  if (method === 'users.info') return { user: { id: args.user, team_id: 'TTEAM', is_bot: true } };
  if (method === 'chat.postMessage') return { channel: args.channel, ts: '1794000000.000001' };
  throw new Error('unexpected-api-method');
});
const options = (n = 0, call = api(n)) => ({ bindings, busRoot: root, runsDir: root, now: () => now, call, readPolicy: () => policy(n) });
const request = { toAgent: 'agent1', kind: 'task', text: 'Review the parser', refs: ['pr:12', 'phm_TEST_REFERENCE'] };
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'peer-bus-')); bindings = join(root, 'bindings.json'); now = Date.now(); shared = false; approved = true;
  peers = Array.from({ length: 10 }, (_, n) => ({ callsign: `agent${n}`, lane: session(n).lane, sessionId: session(n).sessionId,
    sessionHash: createHash('sha256').update(JSON.stringify([session(n).lane, session(n).sessionId, session(n).token])).digest('hex'),
    expiresAt: now + 3600_000, teamId: 'TTEAM', userId: `UAGENT${n}`, botId: `BAGENT${n}`, topic: 'mesh' }));
  writeFileSync(bindings, JSON.stringify({ version: 1, peers }), { mode: 0o600 });
  vi.mocked(localWriteGate).mockReturnValue(null);
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });
const posts = (call: SlackCall) => vi.mocked(call).mock.calls.filter(([method]) => method === 'chat.postMessage');

describe('team peer mesh', () => {
  it('shares mesh and work metadata with every authenticated lane without a send grant or lease', () => {
    approved = false;
    vi.mocked(localWriteGate).mockReturnValue({ status: 'refused', reason: 'Communications are paused.' });
    appendBusInbox({ id: 'shared-work', from: 'agent0', to: 'leaders', priority: 'P2', ttl: 60000,
      body: { kind: 'work.post', jobId: 'RQ-SHARED', title: 'Review', repo: 'fake/repo', provider: 'claude', claimKeys: [] } },
    { root, now: () => now });
    const before = readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8');
    for (let n = 0; n < peers.length; n++) {
      expect(readPeerFleet('mesh', session(n), options(n)).status).toBe('ok');
      expect(readPeerFleet('work-feed', session(n), options(n))).toMatchObject({ status: 'ok', jobs: [{ id: 'RQ-SHARED' }] });
    }
    expect(readFileSync(join(root, 'bus-inbox', 'messages.json'), 'utf8')).toBe(before);
    expect(() => readPeerFleet('mesh', { ...session(), token: 'wrong' }, options())).toThrow();
    now += 3600_000;
    expect(() => readPeerFleet('work-feed', session(), options())).toThrow();
  });
  it('serves the shared work-feed query to authenticated peers and refuses feed flags elsewhere', async () => {
    const announce = (id: string, jobId: string, body: Record<string, unknown>, at = now, to = 'leaders') =>
      appendBusInbox({ id, from: 'agent0', to, priority: 'P2', ttl: 60000,
        body: { kind: 'work.post', jobId, title: `Title for ${jobId}`, repo: 'fake/repo',
          provider: 'claude', claimKeys: ['repo:fake/repo'], ...body } }, { root, now: () => at });
    announce('feed-post-a', 'RQ-FEED-A', {});
    announce('feed-post-b', 'RQ-FEED-B', { repo: 'other/repo', provider: 'devin', claimKeys: ['repo:other/repo'],
      dispatch: { tier: 'fast', scope: 'the scope', acceptance: 'the check' } }, now + 1);
    announce('feed-post-c', 'RQ-FEED-C', {}, now + 2, 'group:release:deploy');
    const feed = (query?: PeerWorkFeedQuery) => {
      const view = readPeerFleet('work-feed', session(), options(), query);
      if (!('jobs' in view)) throw new Error(`feed refused: ${JSON.stringify(view)}`);
      return view;
    };
    const ids = (view: { jobs: { id: string }[] }) => view.jobs.map(job => job.id);
    // Unfiltered parity: every announced job, newest first — the order the other feed surfaces serve.
    expect(ids(feed())).toEqual(['RQ-FEED-C', 'RQ-FEED-B', 'RQ-FEED-A']);
    // The shared filter set narrows the same view phm fleet work-feed, phm agents bus work feed,
    // the work-feed HTTP route and fleet_work_feed serve — one parseBusWorkFeedQuery contract.
    for (const [filters, expected] of [
      [{ jobId: 'RQ-FEED-A' }, ['RQ-FEED-A']],
      [{ repo: 'other/repo' }, ['RQ-FEED-B']],
      [{ provider: 'devin' }, ['RQ-FEED-B']],
      [{ tier: 'fast' }, ['RQ-FEED-B']],
      [{ status: 'queued' }, ['RQ-FEED-C', 'RQ-FEED-B', 'RQ-FEED-A']],
      [{ status: 'done' }, []],
      [{ owner: 'agent0' }, ['RQ-FEED-C', 'RQ-FEED-B', 'RQ-FEED-A']],
      // The --to filter is the pending-to predicate the parser builds — the
      // group-addressed job is not addressed to 'leaders' and stays out.
      [{ toMatch: busWorkFeedPendingToMatcher('leaders', { root }) }, ['RQ-FEED-B', 'RQ-FEED-A']],
      [{ contains: 'title for rq-feed-b' }, ['RQ-FEED-B']],
      [{ id: 'feed-post-a' }, ['RQ-FEED-A']],
      // topic keeps jobs announced to a well-formed group:<room>:<topic>
      // address carrying that exact component — RQ-FEED-C's
      // group:release:deploy matches 'deploy'; the leaders-addressed jobs
      // carry no topic and never match.
      [{ topic: 'deploy' }, ['RQ-FEED-C']],
      [{ topic: 'general' }, []],
      [{ channel: 'release', topic: 'deploy' }, ['RQ-FEED-C']],
    ] as const) {
      expect(ids(feed({ claims: false, filters }))).toEqual(expected);
    }
    // --claims joins hold coverage (an absent table reads missing, never zeroed);
    // --limit pages the filtered view with honest matched/omitted counts.
    expect(feed({ claims: true, filters: {} })).toMatchObject({ status: 'ok', claims: { source: 'missing', holds: [] } });
    expect(feed({ claims: false, filters: {}, limit: 1 })).toMatchObject({ matched: 3, omitted: 2 });
    expect(ids(feed({ claims: false, filters: {}, limit: 1 }))).toEqual(['RQ-FEED-C']);
    // The mesh view takes no query — passing one is a contract violation, never a silent no-op.
    expect(() => readPeerFleet('mesh', session(), options(), { claims: false, filters: {} })).toThrow('work-feed');
    // The CLI parses the same flags into the same query and refuses them on every other verb.
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdAgentnet(['peers', 'work-feed', '--job', 'RQ-FEED-A', '--json'], options(), session())).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: 'ok', jobs: [{ id: 'RQ-FEED-A' }] });
    expect(await cmdAgentnet(['peers', 'work-feed', '--repo', 'other/repo', '--limit', '1', '--json'], options(), session())).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ matched: 1, omitted: 0, jobs: [{ id: 'RQ-FEED-B' }] });
    expect(await cmdAgentnet(['peers', 'work-feed', '--claims', '--open', '--json'], options(), session())).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).claims.source).toBe('missing');
    expect(await cmdAgentnet(['peers', 'work-feed', '--status', 'bogus', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'work-feed', '--from', 'agent0', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'work-feed', '--peer-kind', 'task', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'work-feed', '--thread', 't1', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'work-feed', '--after', '0', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'mesh', '--status', 'queued', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'read', '--status', 'queued', '--json'], options(1), session(1))).toBe(2);
    expect(await cmdAgentnet(['peers', 'list', '--claims', '--json'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'send', 'agent1', 'query', 'hi', '--open', '--json'], options(), session())).toBe(2);
  });
  it('binds callsigns across arbitrary lanes and sends through the existing authenticated broker', async () => {
    const call = api(), result = await sendPeerMessage(request, session(), options(0, call));
    expect(result).toMatchObject({ status: 'posted', slack: 'sent', hopCount: 1 });
    expect(posts(call)).toHaveLength(1);
    expect(JSON.parse(posts(call)[0]![1]!.text as string)).toMatchObject({ fromAgent: 'agent0', toAgent: 'agent1', kind: 'task' });
    const page = listBusInboxAfter(0, 100, { root });
    expect(page.status === 'ok' && page.messages[0]?.envelope.body).toMatchObject({ kind: 'peer.message' });
    expect(JSON.stringify(listPeers(bindings))).not.toContain('session');
  });
  it('authenticates the receiver and excludes forged peer bodies appended through the raw bus', async () => {
    await sendPeerMessage(request, session(), options());
    const page = listBusInboxAfter(0, 100, { root });
    if (page.status !== 'ok') throw new Error('missing fixture');
    expect(appendBusInbox({ ...page.messages[0]!.envelope, id: 'forged-peer' }, { root }).status).toBe('posted');
    const inbox = readPeerInbox(session(1), 0, options(1));
    expect(inbox.status === 'ok' && inbox.messages).toHaveLength(1);
    expect(() => readPeerInbox({ ...session(1), token: session(2).token }, 0, options(1))).toThrow();
  });
  it.each(['fromAgent', 'origin', 'hopCount', 'sessionToken'])('refuses forged %s metadata', async field => {
    expect(await sendPeerMessage({ ...request, [field]: 'agent2' }, session(), options())).toMatchObject({ reason: 'invalid-peer-message' });
  });
  it.each(['lane', 'sessionId', 'token'])('refuses mismatched session %s', async field => {
    const call = api();
    expect((await sendPeerMessage(request, { ...session(), [field]: 'forged-value' }, options(0, call))).status).toBe('refused');
    expect(call).not.toHaveBeenCalled();
  });
  it('refuses expired sessions, duplicate bot identities and caller-selected sender bots', async () => {
    now += 3600_000;
    expect((await sendPeerMessage(request, session(), options())).status).toBe('refused');
    now -= 3600_000;
    expect(await sendPeerMessage(request, session(), options(1))).toMatchObject({ reason: 'bot-binding-mismatch' });
    peers[1]!.botId = peers[0]!.botId;
    writeFileSync(bindings, JSON.stringify({ version: 1, peers }));
    expect(() => readPeerBindings(bindings)).toThrow();
  });
  it('refuses shared channels before publishing any peer content', async () => {
    shared = true; const call = api();
    expect(await sendPeerMessage(request, session(), options(0, call))).toMatchObject({ status: 'refused' });
    expect(posts(call)).toHaveLength(0);
    expect(listBusInboxAfter(0, 100, { root })).toMatchObject({ status: 'ok', messages: [] });
  });
  it('rechecks shared-channel evidence and session revocation after the initial observation', async () => {
    const original = api(); let observations = 0;
    const call: SlackCall = async (method, args, credential) => {
      if (method === 'conversations.info' && ++observations === 2) shared = true;
      return original(method, args, credential);
    };
    expect(await sendPeerMessage(request, session(), options(0, call))).toMatchObject({ slack: 'uncertain' });
    expect(posts(original)).toHaveLength(0);
    shared = false;
    const readPolicy = vi.fn().mockImplementationOnce(() => policy()).mockImplementation(() => {
      peers[0]!.expiresAt = now - 1; writeFileSync(bindings, JSON.stringify({ version: 1, peers })); return policy();
    });
    expect((await sendPeerMessage(request, session(), { ...options(), readPolicy })).slack).not.toBe('sent');
  });
  it('drafts locally without comms approval and rechecks approval just before the post', async () => {
    approved = false; const call = api();
    expect(await sendPeerMessage(request, session(), options(0, call))).toMatchObject({ status: 'drafted' });
    expect(posts(call)).toHaveLength(0);
    approved = true;
    const readPolicy = vi.fn().mockImplementationOnce(() => policy()).mockImplementation(() => ({ ...policy(), confirmedByMason: false }));
    expect(await sendPeerMessage(request, session(), { ...options(0, call), readPolicy })).toMatchObject({ slack: 'refused' });
    expect(posts(call)).toHaveLength(0);
  });
  it('scrubs provider keys, assignments, headers and key material before disk or Slack', async () => {
    const secrets = ['sk-' + 'a'.repeat(24), 'xoxb-' + '1'.repeat(24), 'ghp_' + 'a'.repeat(24), 'b'.repeat(64), 'privatevalue123', 'headerValue123'];
    const call = api(), text = `${secrets.slice(0, 4).join(' ')} password=${secrets[4]} Bearer ${secrets[5]}`;
    expect(await sendPeerMessage({ ...request, text }, session(), options(0, call))).toMatchObject({ slack: 'sent' });
    const saved = readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8') + JSON.stringify(posts(call));
    for (const secret of secrets) expect(saved).not.toContain(secret);
    expect(saved).toContain('[REDACTED]'); expect(saved).toContain('phm_TEST_REFERENCE');
    expect(await sendPeerMessage({ ...request, refs: [secrets[0]] }, session(), options())).toMatchObject({ reason: 'invalid-peer-message' });
  });
  it('persists the pair limit across calls and counts channel sends against direct recipients', async () => {
    for (let n = 0; n < PEER_PAIR_LIMIT; n++) expect((await sendPeerMessage({ channel: 'CMESH', kind: 'social', text: 'Hello' }, session(), options())).status).toBe('posted');
    expect(await sendPeerMessage(request, session(), options())).toMatchObject({ reason: 'pair-rate-limit' });
    now += 60_000;
    expect((await sendPeerMessage(request, session(), options())).status).toBe('posted');
  });
  it('derives reply hops and escalates a repeated origin/pair to the human queue', async () => {
    const first = await sendPeerMessage(request, session(), options());
    const reply = await sendPeerMessage({ toAgent: 'agent0', kind: 'review', text: 'Check this', replyTo: first.id }, session(1), options(1));
    expect(reply).toMatchObject({ origin: first.origin, hopCount: 2 });
    const loop = await sendPeerMessage({ ...request, replyTo: reply.id }, session(), options());
    expect(loop).toMatchObject({ status: 'escalated' });
    expect(readFileSync(join(root, 'NEEDS-MASON.md'), 'utf8')).toContain(first.origin);
  });
  it('allows eight hops and escalates the ninth without posting it to Slack', async () => {
    let parent: string | undefined;
    for (let n = 0; n < 8; n++) {
      const result = await sendPeerMessage({ toAgent: `agent${n + 1}`, kind: 'handoff', text: 'Continue', ...(parent ? { replyTo: parent } : {}) }, session(n), options(n));
      expect(result).toMatchObject({ hopCount: n + 1, slack: 'sent' }); parent = result.id;
    }
    const call = api(8);
    expect(await sendPeerMessage({ toAgent: 'agent9', kind: 'query', text: 'Continue', replyTo: parent }, session(8), options(8, call))).toMatchObject({ status: 'escalated' });
    expect(posts(call)).toHaveLength(0);
  });
  it('rejects guessed parents, foreign threads, unknown peers, DMs and kill/pause', async () => {
    expect(await sendPeerMessage({ ...request, replyTo: 'peer-' + '0'.repeat(36) }, session(), options())).toMatchObject({ reason: 'invalid-parent' });
    expect(await sendPeerMessage({ ...request, threadId: 'slack:TOTHER:CMESH:1.1' }, session(), options())).toMatchObject({ reason: 'foreign-thread' });
    expect(await sendPeerMessage({ ...request, toAgent: 'unknown' }, session(), options())).toMatchObject({ reason: 'unknown-peer' });
    expect(await sendPeerMessage({ channel: 'DDIRECT', kind: 'query', text: 'Hi' }, session(), options())).toMatchObject({ reason: 'invalid-peer-message' });
    vi.mocked(localWriteGate).mockReturnValue({ status: 'refused', reason: 'paused' });
    expect(await sendPeerMessage(request, session(), options())).toMatchObject({ reason: 'paused' });
  });
  it('keeps provisioning as stable drafts and channel proposals dry by default', () => {
    const paths = { bindings, busRoot: root, runsDir: root };
    expect(proposeSlackAction('channel.create', 'review-room', false, paths)).toMatchObject({ dryRun: true, private: true });
    expect(proposeSlackAction('identity.register', 'reviewer', true, paths)).toMatchObject({ status: 'drafted', displayName: 'reviewer' });
    expect(proposeSlackAction('identity.register', 'reviewer', true, paths)).toMatchObject({ status: 'drafted' });
    expect(readPeerBindings(bindings)).toHaveLength(10);
    expect(readFileSync(join(root, 'NEEDS-MASON.md'), 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
  });
  it('supports bounded CoS delegation and rejects oversized or impersonating plans', async () => {
    const plan = { reply: 'Delegating review', peers: [request] };
    expect(await emitCosPeerPlan(cosPeerPlanSchema.parse(plan), session(), options())).toMatchObject([{ status: 'posted' }]);
    expect(cosPeerPlanSchema.safeParse({ ...plan, peers: Array(9).fill(request) }).success).toBe(false);
    expect(cosPeerPlanSchema.safeParse({ ...plan, peers: [{ ...request, fromAgent: 'leader' }] }).success).toBe(false);
  });
  it('parses CLI arity strictly and returns structured authenticated send results', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdAgentnet(['peers', 'list', '--json'], options(), session())).toBe(0);
    expect(await cmdAgentnet(['peers', 'send', 'agent1', 'query', 'Status?', '--json'], options(), session())).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string)).toMatchObject({ status: 'posted', slack: 'sent' });
    expect(await cmdAgentnet(['peers', 'read', '--after', '0', '--json'], options(1), session(1))).toBe(0);
    expect(JSON.parse(log.mock.calls.at(-1)![0] as string).messages).toHaveLength(1);
    expect(await cmdAgentnet(['peers', 'send', 'agent1', 'query', 'Status?', '--from', 'forged'], options(), session())).toBe(2);
    expect(await cmdAgentnet(['peers', 'list', '--apply'], options(), session())).toBe(2);
  });
});
