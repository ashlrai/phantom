/** Exercises the read-only work-board listing and `fleet work-board` command
 * against real durable stores in a private tmp root. Fixtures are plainly
 * fake; labels and tokens grant no authority and no token may appear in
 * output. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { publishGroupPresence } from '../src/core/fleet/bus-group.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
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

  it('filters by exact envelope id and P0..P3 band, reporting the true matched total', () => {
    seed();
    // Every item carries its own envelope stamp: P1 for the bus request,
    // P2 for both slack requests — never a guessed default.
    const all = listWorkBoard({ root, now });
    expect(all.items.map(item => [item.id, item.priority]))
      .toEqual([['bus-request-c', 'P1'], ['slack-request-b', 'P2'], ['slack-request-a', 'P2']]);
    // --id is the same exact-envelope match every bus read applies: one
    // request survives, replies and every other id drop out.
    const one = listWorkBoard({ root, now, id: 'slack-request-a' });
    expect(one.items.map(item => item.id)).toEqual(['slack-request-a']);
    expect(one.matched).toBe(1);
    expect(one.truncated).toBe(false);
    const missing = listWorkBoard({ root, now, id: 'no-such-envelope' });
    expect(missing.items).toEqual([]);
    expect(missing.matched).toBe(0);
    // --priority keeps only requests stamped with that band; the pair
    // composes into one filtered total before the display cap.
    const urgent = listWorkBoard({ root, now, priority: 'P1' });
    expect(urgent.items.map(item => item.id)).toEqual(['bus-request-c']);
    expect(urgent.matched).toBe(1);
    const slack = listWorkBoard({ root, now, priority: 'P2', limit: 1 });
    expect(slack.items.map(item => item.id)).toEqual(['slack-request-b']);
    expect(slack.matched).toBe(2);
    expect(slack.truncated).toBe(true);
    const running = listWorkBoard({ root, now, priority: 'P2', state: 'RUNNING' });
    expect(running.items.map(item => item.id)).toEqual(['slack-request-a']);
    expect(running.matched).toBe(1);
    expect(running.state).toBe('RUNNING');
    // An unmatched band is an honest zero, never an error or a pad.
    const none = listWorkBoard({ root, now, priority: 'P3' });
    expect(none.items).toEqual([]);
    expect(none.matched).toBe(0);
    // The envelope match composes with the receivedAt window too.
    const windowed = listWorkBoard({ root, now, priority: 'P2', before: now - 1_500 });
    expect(windowed.items.map(item => item.id)).toEqual(['slack-request-b', 'slack-request-a']);
    expect(windowed.matched).toBe(2);
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
      + 'owner-missing=yes owner=unknown claim=unknown channel=bus ref=none priority=P1');
    expect(lines[1]).toBe(`slack-request-b RECEIVED as-of=${iso(now - 2_000)} source=receivedAt `
      + `owner-missing=yes owner=unknown claim=unknown channel=slack ref=${REF_B} priority=P2`);
    expect(lines[2]).toBe(`slack-request-a RUNNING as-of=${asOf} `
      + `source=bus-work-claims lease-until ${iso(now + 600_000)} owner-missing=no `
      + `owner=fake-owner claim=bus-claim:slack-request-a:1:${now - 3_000} channel=slack ref=${REF_A} priority=P2`);
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

  it('--id and --priority keep the matching request and the footer reports matched', async () => {
    seed();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdFleetWorkBoard(['--root', root, '--id', 'slack-request-b'])).toBe(0);
    let lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('slack-request-b RECEIVED');
    expect(lines[0]).toContain('priority=P2');
    expect(lines[1]).toBe(`items=1 matched=1 truncated=no inbox=ok as-of=${iso(now)}`);
    // The band filter composes with --state and --limit like every bus read.
    expect(await cmdFleetWorkBoard(['--root', root, '--priority', 'P2', '--state', 'RUNNING', '--json'])).toBe(0);
    const parsed = JSON.parse(String(log.mock.calls.at(-1)![0]));
    expect(parsed).toMatchObject({ state: 'RUNNING', matched: 1, inbox: 'ok' });
    expect(parsed.items.map((i: { id: string }) => i.id)).toEqual(['slack-request-a']);
    expect(await cmdFleetWorkBoard(['--root', root, '--priority', 'P1'])).toBe(0);
    lines = log.mock.calls.slice(-2).map(call => String(call[0]));
    expect(lines[0]).toContain('bus-request-c RECEIVED');
    expect(lines[0]).toContain('priority=P1');
    expect(lines[1]).toBe(`items=1 matched=1 truncated=no inbox=ok as-of=${iso(now)}`);
    // An unmatched id or band is an honest empty board with matched=0.
    expect(await cmdFleetWorkBoard(['--root', root, '--id', 'no-such-envelope'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/^items=0 matched=0 truncated=no inbox=ok as-of=/);
    expect(await cmdFleetWorkBoard(['--root', root, '--priority', 'P3'])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toMatch(/^items=0 matched=0 truncated=no inbox=ok as-of=/);
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
    expect(await cmdFleetWorkBoard(['--id', 'bad id'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--id', ''])).toBe(2);
    expect(await cmdFleetWorkBoard(['--id'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--id', 'a', '--id', 'b'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--priority', 'bogus'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--priority', 'p1'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--priority'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--priority', 'P1', '--priority', 'P2'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--json', '--json'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--root', root, '--root', root])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
