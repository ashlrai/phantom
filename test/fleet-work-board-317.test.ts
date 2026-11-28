/** Exercises the read-only work-board listing and `fleet work-board` command
 * against real durable stores in a private tmp root. Fixtures are plainly
 * fake; labels and tokens grant no authority and no token may appear in
 * output. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { publishGroupPresence } from '../src/core/fleet/bus-group.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { registerAgentIdentity } from '../src/core/agents/bus-identity.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { cmdFleetWorkBoard } from '../src/cli/fleet-work-board.js';
import { resolveFleetSubcommand } from '../src/cli/fleet-subcommand-resolve.js';

let root: string, now: number;
const TTL = 10_000_000;
const REF_A = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const REF_B = 'T0FAKEWS/C0FAKECH/1700000000.000002';
const iso = (ms: number) => new Date(ms).toISOString();
const slackRequest = (id: string, ref: string): BusEnvelope => ({
  id, from: 'fake-peer-agent', to: 'fake-lane', priority: 'P2', ttl: TTL,
  channel: 'slack', channel_ref: ref,
  sender: { agent_id: 'fake-peer-agent', vendor: 'fake-vendor', human: false, team: true },
  external: false,
  body: { kind: 'slack-coordination', text: 'fake request text' },
});
const busRequest = (id: string): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
  body: { kind: 'work' },
});
const post = (envelope: BusEnvelope) => {
  expect(appendBusInbox(envelope, { root, now: () => now }).status).toBe('posted');
};
/** Four requests that each isolate one shared filter dimension: req-alpha
 * cites job fake-job-7 through a work.status jobId at P0, req-beta is a
 * failed work.result receipt addressed to agent:lane-bot at P3, req-gamma
 * cites the same job through a note's job: thread label at P1, and
 * req-delta comes from the registered lane-bot identity at P2 carrying an
 * unknown-kind body whose fallback summary holds the contains needle. */
const filterRequest = (id: string, over: Partial<BusEnvelope>): BusEnvelope => ({
  id, from: 'fake-sender', to: 'fake-lane', priority: 'P2', ttl: TTL, body: { kind: 'work' }, ...over,
});
const postFilterFixtures = () => {
  post(filterRequest('req-alpha', { from: 'fake-alpha', priority: 'P0',
    body: { kind: 'work.status', jobId: 'fake-job-7', detail: 'deploy step' } }));
  now += 1_000;
  post(filterRequest('req-beta', { from: 'fake-beta', to: 'agent:lane-bot', priority: 'P3',
    body: { kind: 'work.result', outcome: 'failed' } }));
  now += 1_000;
  post(filterRequest('req-gamma', { from: 'fake-gamma', to: 'group:ops:deploy', priority: 'P1',
    body: { kind: 'note', thread: 'job:fake-job-7', text: 'gamma note' } }));
  now += 1_000;
  post(filterRequest('req-delta', { from: 'lane-bot',
    body: { kind: 'custom-thing', marker: 'zebra-quokka' } }));
  now += 1_000;
  expect(registerAgentIdentity({ handle: 'lane-bot', aliases: ['lb-alias'] }, { root }).status).toBe('created');
};
/** slack-a, slack-b then bus-c one second apart, a reply to slack-a, and a
 * live claim on slack-a. */
const seed = () => {
  post(slackRequest('slack-request-a', REF_A));
  now += 1_000;
  post(slackRequest('slack-request-b', REF_B));
  now += 1_000;
  post(busRequest('bus-request-c'));
  now += 1_000;
  expect(postBusReply('slack-request-a', 'fake-reply-1', { text: 'fake ack' },
    { root, now: () => now }).outcome).toBe('posted');
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'slack-request-a', owner: 'fake-owner',
    leaseMs: 600_000, root }).status).toBe('acquired');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-board-317-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('listWorkBoard on real durable stores', { timeout: 60_000 }, () => {
  it('lists every request newest-first, claims classify, replies are absent', () => {
    seed();
    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    expect(board.truncated).toBe(false);
    expect(board.items.map(item => item.id)).toEqual(['bus-request-c', 'slack-request-b', 'slack-request-a']);
    expect(board.items.map(item => item.receivedAt))
      .toEqual([iso(now - 1_000), iso(now - 2_000), iso(now - 3_000)]);
    const claimed = board.items.at(-1)!;
    expect(claimed.state).toBe('RUNNING');
    expect(claimed.missing).toEqual([]);
    expect(claimed.source).toContain('bus-work-claims lease-until');
    expect(claimed.channel).toBe('slack');
    expect(claimed.channelRef).toBe(REF_A);
    for (const item of board.items.slice(0, 2)) {
      expect(item.state).toBe('RECEIVED');
      expect(item.missing).toEqual(['named owner', 'durable claim receipt']);
    }
    expect(board.items[0]!.channel).toBe('bus');
    expect(board.items[0]!.channelRef).toBeNull();
    expect(JSON.stringify(board)).not.toMatch(/[a-f0-9]{64}/);
  });

  it('filters to one channel_ref and honours limit with truncated', () => {
    seed();
    expect(listWorkBoard({ root, now, channelRef: REF_A }).items.map(i => i.id)).toEqual(['slack-request-a']);
    expect(listWorkBoard({ root, now, channelRef: 'T0FAKEWS/C0FAKECH/9999999999.000099' }).items).toEqual([]);
    const one = listWorkBoard({ root, now, limit: 1 });
    expect(one.items.map(i => i.id)).toEqual(['bus-request-c']);
    expect(one.truncated).toBe(true);
  });

  it('a group.presence heartbeat is an observation, never a board request', () => {
    seed();
    expect(publishGroupPresence({ room: 'release', topic: 'general', id: 'presence-1',
      member: 'fake-member', state: 'online' }, { root, now: () => now }).status).toBe('posted');
    const board = listWorkBoard({ root, now });
    expect(board.items.map(item => item.id)).toEqual(['bus-request-c', 'slack-request-b', 'slack-request-a']);
  });

  it('an empty root yields zero items and never throws', () => {
    const board = listWorkBoard({ root, now });
    expect(board.items).toEqual([]);
    expect(board.truncated).toBe(false);
    expect(['ok', 'unavailable']).toContain(board.inbox);
    const gone = join(root, 'does-not-exist');
    expect(() => listWorkBoard({ root: gone, now })).not.toThrow();
    expect(listWorkBoard({ root: gone, now }).items).toEqual([]);
  });

  it('filters by classified state and reports the true matched total', () => {
    // One item per state: a live claim runs, a blocked reply blocks, a
    // verified reply verifies, and two plain requests stay RECEIVED.
    post(slackRequest('req-running', REF_A));
    now += 1_000;
    post(slackRequest('req-blocked', REF_B));
    now += 1_000;
    post(busRequest('req-verified'));
    now += 1_000;
    post(busRequest('req-received-1'));
    now += 1_000;
    post(busRequest('req-received-2'));
    now += 1_000;
    expect(mutateBusWorkClaim({ action: 'acquire', id: 'req-running', owner: 'fake-owner',
      leaseMs: 600_000, root }).status).toBe('acquired');
    expect(postBusReply('req-blocked', 'reply-blocked', { blocked: { dependency: 'fake-dep' } },
      { root, now: () => now }).outcome).toBe('posted');
    expect(postBusReply('req-verified', 'reply-verified', { verified: { pr: 12, head: 'abc1234' } },
      { root, now: () => now }).outcome).toBe('posted');

    const blocked = listWorkBoard({ root, now, state: 'BLOCKED' });
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.matched).toBe(1);
    expect(blocked.truncated).toBe(false);
    expect(blocked.items.map(item => item.id)).toEqual(['req-blocked']);
    expect(blocked.items[0]!.result).toEqual({ kind: 'blocked', dependency: 'fake-dep' });

    // matched counts every RECEIVED request, so a limit-1 board is a slice.
    const received = listWorkBoard({ root, now, state: 'RECEIVED', limit: 1 });
    expect(received.state).toBe('RECEIVED');
    expect(received.matched).toBe(2);
    expect(received.truncated).toBe(true);
    expect(received.items.map(item => item.id)).toEqual(['req-received-2']);

    // state composes with channelRef: REF_A holds only the RUNNING item.
    const scoped = listWorkBoard({ root, now, channelRef: REF_A, state: 'RECEIVED' });
    expect(scoped.items).toEqual([]);
    expect(scoped.matched).toBe(0);
    expect(scoped.state).toBe('RECEIVED');

    // An unmatched state is an honest zero; the unfiltered board is unchanged.
    const none = listWorkBoard({ root, now, state: 'ASSIGNED' });
    expect(none.items).toEqual([]);
    expect(none.matched).toBe(0);
    expect(none.state).toBe('ASSIGNED');
    const all = listWorkBoard({ root, now });
    expect(all.state).toBeUndefined();
    expect(all.matched).toBeUndefined();
    expect(all.items).toHaveLength(5);
  });

  it('filters by the [since, before) receivedAt window and reports the true matched total', () => {
    seed();
    // seed() posts slack-request-a at now-3000, slack-request-b at now-2000
    // and bus-request-c at now-1000; the reply is never a request.
    const t0 = now - 3_000;
    // `since` is inclusive: the request exactly on the cutoff stays.
    const since = listWorkBoard({ root, now, since: t0 + 1_000 });
    expect(since.items.map(item => item.id)).toEqual(['bus-request-c', 'slack-request-b']);
    expect(since.matched).toBe(2);
    expect(since.truncated).toBe(false);
    expect(since.state).toBeUndefined();
    // `before` is exclusive: bus-request-c sits exactly on now-1000 and drops.
    const before = listWorkBoard({ root, now, before: t0 + 2_000 });
    expect(before.items.map(item => item.id)).toEqual(['slack-request-b', 'slack-request-a']);
    expect(before.matched).toBe(2);
    // The pair reads one [since, before) window.
    const window = listWorkBoard({ root, now, since: t0 + 1_000, before: t0 + 2_000 });
    expect(window.items.map(item => item.id)).toEqual(['slack-request-b']);
    expect(window.matched).toBe(1);
    // The window composes with channelRef and state into one filtered total.
    const scoped = listWorkBoard({ root, now, channelRef: REF_B, since: t0 + 1_000 });
    expect(scoped.items.map(item => item.id)).toEqual(['slack-request-b']);
    expect(scoped.matched).toBe(1);
    const running = listWorkBoard({ root, now, state: 'RUNNING', since: t0 });
    expect(running.items.map(item => item.id)).toEqual(['slack-request-a']);
    expect(running.matched).toBe(1);
    expect(running.state).toBe('RUNNING');
    // A window matching nothing is an honest zero, never an error or a pad.
    const none = listWorkBoard({ root, now, since: now + 60_000 });
    expect(none.items).toEqual([]);
    expect(none.matched).toBe(0);
    expect(none.truncated).toBe(false);
    // A channelRef-only read keeps the unfiltered shape: no matched token.
    expect(listWorkBoard({ root, now, channelRef: REF_A }).matched).toBeUndefined();
  });

  it('filters by the shared channel, topic and id address rules', () => {
    const groupReq = (id: string, to: string): BusEnvelope => ({ ...busRequest(id), to });
    post(groupReq('grp-ops-deploy', 'group:ops:deploy'));
    now += 1_000;
    post(groupReq('grp-ops-review', 'group:ops:review'));
    now += 1_000;
    post(groupReq('grp-eng-deploy', 'group:eng:deploy'));
    now += 1_000;
    post(busRequest('plain-lane'));

    // --channel keeps the room's whole traffic under every topic, newest first.
    expect(listWorkBoard({ root, now, channel: 'ops' }).items.map(i => i.id))
      .toEqual(['grp-ops-review', 'grp-ops-deploy']);
    // --topic keeps the exact topic component across every room.
    const deploy = listWorkBoard({ root, now, topic: 'deploy' });
    expect(deploy.items.map(i => i.id)).toEqual(['grp-eng-deploy', 'grp-ops-deploy']);
    expect(deploy.matched).toBe(2);
    // channel AND topic compose into one room and one topic.
    expect(listWorkBoard({ root, now, channel: 'ops', topic: 'deploy' }).items.map(i => i.id))
      .toEqual(['grp-ops-deploy']);
    // --id keeps only the request whose own wire id is strictly equal.
    expect(listWorkBoard({ root, now, id: 'grp-ops-review' }).items.map(i => i.id))
      .toEqual(['grp-ops-review']);
    // An agent address, a bare room and an absent room never match — unknown
    // stays out, and matched reports the honest filtered total.
    expect(listWorkBoard({ root, now, channel: 'nope' })).toMatchObject({ items: [], matched: 0 });
    expect(listWorkBoard({ root, now, topic: 'deploy', id: 'plain-lane' }))
      .toMatchObject({ items: [], matched: 0 });
  });

  it('filters by the shared sender, band and body rules with a true matched total', () => {
    postFilterFixtures();
    const ids = (result: ReturnType<typeof listWorkBoard>) => result.items.map(item => item.id);
    // --to keeps requests addressed to the agent under the pending-address
    // rule: the literal label and every label of the resolved identity.
    expect(ids(listWorkBoard({ root, now, to: 'fake-lane' }))).toEqual(['req-delta', 'req-alpha']);
    expect(listWorkBoard({ root, now, to: 'fake-lane' }).matched).toBe(2);
    expect(ids(listWorkBoard({ root, now, to: 'lane-bot' }))).toEqual(['req-beta']);
    expect(listWorkBoard({ root, now, to: 'lane-bot' }).matched).toBe(1);
    // An unregistered ref keeps exact-label matching — agent:lane-bot is a
    // label of the identity, the bare room label is not 'lane-bot'.
    expect(listWorkBoard({ root, now, to: 'agent:lane-bot' }).matched).toBe(1);
    expect(listWorkBoard({ root, now, to: 'unregistered-agent' })).toMatchObject({ items: [], matched: 0 });
    // --from/--exclude-from apply the sender identity-label rule: the alias
    // resolves to lane-bot's whole label set.
    expect(ids(listWorkBoard({ root, now, from: 'lb-alias' }))).toEqual(['req-delta']);
    expect(ids(listWorkBoard({ root, now, excludeFrom: 'lb-alias' })))
      .toEqual(['req-gamma', 'req-beta', 'req-alpha']);
    expect(listWorkBoard({ root, now, excludeFrom: 'lb-alias' }).matched).toBe(3);
    expect(listWorkBoard({ root, now, from: 'fake-alpha', excludeFrom: 'fake-alpha' }))
      .toMatchObject({ items: [], matched: 0 });
    // --priority keeps one exact band.
    for (const [band, id] of [['P0', 'req-alpha'], ['P1', 'req-gamma'], ['P2', 'req-delta'], ['P3', 'req-beta']] as const) {
      const board = listWorkBoard({ root, now, priority: band });
      expect(ids(board)).toEqual([id]);
      expect(board.matched).toBe(1);
    }
    // --job keeps bodies naming the job through either citation: the
    // work.status jobId and the note's job: thread label.
    expect(ids(listWorkBoard({ root, now, job: 'fake-job-7' }))).toEqual(['req-gamma', 'req-alpha']);
    expect(listWorkBoard({ root, now, job: 'fake-job-7' }).matched).toBe(2);
    expect(listWorkBoard({ root, now, job: 'other-job' })).toMatchObject({ items: [], matched: 0 });
    // --body-kind keeps the exact discriminator, case-sensitive.
    expect(ids(listWorkBoard({ root, now, bodyKind: 'note' }))).toEqual(['req-gamma']);
    expect(ids(listWorkBoard({ root, now, bodyKind: 'work.result' }))).toEqual(['req-beta']);
    expect(ids(listWorkBoard({ root, now, bodyKind: 'custom-thing' }))).toEqual(['req-delta']);
    expect(listWorkBoard({ root, now, bodyKind: 'Work.Result' })).toMatchObject({ items: [], matched: 0 });
    // --result keeps work.result receipts reporting that one outcome.
    expect(ids(listWorkBoard({ root, now, result: 'failed' }))).toEqual(['req-beta']);
    expect(listWorkBoard({ root, now, result: 'complete' })).toMatchObject({ items: [], matched: 0 });
    // --contains matches the scrubbed one-line summary case-insensitively.
    expect(ids(listWorkBoard({ root, now, contains: 'ZEBRA-QUOKKA' }))).toEqual(['req-delta']);
    expect(listWorkBoard({ root, now, contains: 'nothing-here' })).toMatchObject({ items: [], matched: 0 });
    // The filters compose into one narrowed read, and state still applies
    // on top of them.
    expect(ids(listWorkBoard({ root, now, from: 'fake-beta', priority: 'P3' }))).toEqual(['req-beta']);
    const scoped = listWorkBoard({ root, now, job: 'fake-job-7', state: 'RECEIVED' });
    expect(ids(scoped)).toEqual(['req-gamma', 'req-alpha']);
    expect(scoped.matched).toBe(2);
    expect(scoped.state).toBe('RECEIVED');
  });
});

describe('cmdFleetWorkBoard', { timeout: 60_000 }, () => {
  it('is registered under the convention name', () => {
    expect(resolveFleetSubcommand('work-board')).toEqual(
      { module: './fleet-work-board.js', exportName: 'cmdFleetWorkBoard' });
  });

  it('prints one line per item plus the footer, and --json the board object', async () => {
    seed();
    const asOf = iso(now);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`bus-request-c RECEIVED as-of=${iso(now - 1_000)} source=receivedAt `
      + 'owner-missing=yes owner=unknown claim=unknown channel=bus ref=none');
    expect(lines[1]).toBe(`slack-request-b RECEIVED as-of=${iso(now - 2_000)} source=receivedAt `
      + `owner-missing=yes owner=unknown claim=unknown channel=slack ref=${REF_B}`);
    expect(lines[2]).toBe(`slack-request-a RUNNING as-of=${asOf} `
      + `source=bus-work-claims lease-until ${iso(now + 600_000)} owner-missing=no `
      + `owner=fake-owner claim=bus-claim:slack-request-a:1:${now - 3_000} channel=slack ref=${REF_A}`);
    expect(lines[3]).toBe(`items=3 truncated=no inbox=ok as-of=${asOf}`);
    expect(await cmdFleetWorkBoard(['--root', root, '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ inbox: 'ok', truncated: false, asOf });
    expect(parsed.items.map((i: { id: string }) => i.id))
      .toEqual(['bus-request-c', 'slack-request-b', 'slack-request-a']);
    expect(parsed.items[2]).toMatchObject({ state: 'RUNNING', channel: 'slack', channelRef: REF_A });
    expect(String(log.mock.calls.at(-1)![0])).not.toMatch(/[a-f0-9]{64}/);
  });

  it('--thread keeps only the named thread and an empty board prints the footer', async () => {
    seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root, '--thread', REF_B])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('slack-request-b RECEIVED');
    expect(lines[0]).toContain(`ref=${REF_B}`);
    expect(lines[1]).toBe(`items=1 truncated=no inbox=ok as-of=${iso(now)}`);
    const empty = mkdtempSync(join(tmpdir(), 'work-board-317-empty-'));
    try {
      chmodSync(empty, 0o700);
      expect(await cmdFleetWorkBoard(['--root', empty])).toBe(0);
      expect(String(log.mock.calls.at(-1)![0])).toMatch(/^items=0 truncated=no inbox=(ok|unavailable) as-of=/);
    } finally { rmSync(empty, { recursive: true, force: true }); }
  });

  it('--state filters items and the footer reports the true matched total', async () => {
    seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root, '--state', 'RUNNING'])).toBe(0);
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('slack-request-a RUNNING');
    expect(lines[1]).toBe(`items=1 state=RUNNING matched=1 truncated=no inbox=ok as-of=${iso(now)}`);
    expect(await cmdFleetWorkBoard(['--root', root, '--state', 'RECEIVED', '--limit', '1', '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ state: 'RECEIVED', matched: 2, truncated: true, inbox: 'ok' });
    expect(parsed.items).toHaveLength(1);
    expect(parsed.items[0].id).toBe('bus-request-c');
  });

  it('--since/--before keep requests inside the window and the footer echoes it', async () => {
    seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const t0 = now - 3_000;
    // Epoch-ms bounds resolve through the shared grammar; the footer prints
    // the resolved ISO window beside the true matched total.
    expect(await cmdFleetWorkBoard(['--root', root, '--since', String(t0 + 1_000)])).toBe(0);
    let lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('bus-request-c RECEIVED');
    expect(lines[1]).toContain('slack-request-b RECEIVED');
    expect(lines[2]).toBe(`items=2 matched=2 since=${iso(t0 + 1_000)} truncated=no inbox=ok as-of=${iso(now)}`);
    // Relative and ISO spellings take the same grammar every bus read shares.
    expect(await cmdFleetWorkBoard(['--root', root, '--since', '1d', '--before', iso(t0 + 2_000)])).toBe(0);
    lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.at(-1)).toBe(`items=2 matched=2 since=${iso(now - 86_400_000)} before=${iso(t0 + 2_000)} truncated=no inbox=ok as-of=${iso(now)}`);
    // The window composes with --state: footer keeps state= and matched=.
    expect(await cmdFleetWorkBoard(['--root', root, '--state', 'RUNNING', '--since', '1d', '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ state: 'RUNNING', matched: 1, inbox: 'ok' });
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(['slack-request-a']);
  });

  it('--channel/--topic/--id filter requests and the footer reports matched', async () => {
    const groupReq = (id: string, to: string): BusEnvelope => ({ ...busRequest(id), to });
    post(groupReq('grp-ops-deploy', 'group:ops:deploy'));
    now += 1_000;
    post(groupReq('grp-ops-review', 'group:ops:review'));
    now += 1_000;
    post(groupReq('grp-eng-deploy', 'group:eng:deploy'));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root, '--channel', 'ops', '--topic', 'deploy'])).toBe(0);
    let lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('grp-ops-deploy RECEIVED');
    expect(lines[1]).toContain('items=1 matched=1 truncated=no inbox=ok');
    expect(await cmdFleetWorkBoard(['--root', root, '--topic', 'deploy', '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ matched: 2, inbox: 'ok' });
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(['grp-eng-deploy', 'grp-ops-deploy']);
    expect(await cmdFleetWorkBoard(['--root', root, '--id', 'grp-ops-review'])).toBe(0);
    lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.at(-2)).toContain('grp-ops-review');
    expect(await cmdFleetWorkBoard(['--root', root, '--channel', 'BAD ROOM'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--root', root, '--topic', 'Upper'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--root', root, '--id', 'has space'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--root', root, '--channel', 'ops', '--channel', 'eng'])).toBe(2);
  });

  it('the shared sender, band and body flags filter requests and print matched', async () => {
    postFilterFixtures();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root, '--from', 'lb-alias'])).toBe(0);
    let lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('req-delta RECEIVED');
    expect(lines[1]).toContain(`items=1 matched=1 truncated=no inbox=ok as-of=${iso(now)}`);
    expect(await cmdFleetWorkBoard(['--root', root, '--exclude-from', 'fake-beta',
      '--priority', 'P1', '--body-kind', 'note', '--job', 'fake-job-7', '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ matched: 1, inbox: 'ok' });
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(['req-gamma']);
    expect(await cmdFleetWorkBoard(['--root', root, '--result', 'failed', '--to', 'lane-bot'])).toBe(0);
    lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.at(-2)).toContain('req-beta');
    expect(await cmdFleetWorkBoard(['--root', root, '--contains', 'ZEBRA-quokka'])).toBe(0);
    lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.at(-2)).toContain('req-delta');
    expect(lines.at(-1)).toContain('matched=1');
  });

  it('exits 2 on bad or duplicate flags and prints nothing on stdout', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--limit', '0'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--limit', '101'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--limit', 'abc'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--limit'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--root', 'relative/path'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--bogus'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--thread', REF_A, '--thread', REF_B])).toBe(2);
    expect(await cmdFleetWorkBoard(['--state', 'bogus'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--state', 'running'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--state'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--state', 'RUNNING', '--state', 'BLOCKED'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--since', 'bogus'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--since', '1.5.2'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--since', ''])).toBe(2);
    expect(await cmdFleetWorkBoard(['--before', 'not-a-time'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--since'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--before'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--since', '1h', '--since', '2h'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--before', '1h', '--before', '2h'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--json', '--json'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--to', 'has space'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--from'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--exclude-from', 'x'.repeat(129)])).toBe(2);
    expect(await cmdFleetWorkBoard(['--priority', 'P9'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--priority', 'p1'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--job', ''])).toBe(2);
    expect(await cmdFleetWorkBoard(['--body-kind', 'has space'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--result', 'bogus'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--result', 'FAILED'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--contains', '   '])).toBe(2);
    expect(await cmdFleetWorkBoard(['--contains'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--to', 'a', '--to', 'b'])).toBe(2);
    // --from and --exclude-from are independent flags, not mutually exclusive.
    expect(await cmdFleetWorkBoard(['--from', 'a', '--exclude-from', 'a'])).toBe(0);
    log.mockClear();
    expect(await cmdFleetWorkBoard(['--root', root, '--root', root])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
