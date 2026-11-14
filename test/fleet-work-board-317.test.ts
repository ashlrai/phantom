/** Exercises the read-only work-board listing and `fleet work-board` command
 * against real durable stores in a private tmp root. Fixtures are plainly
 * fake; labels and tokens grant no authority and no token may appear in
 * output. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
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

  it('an empty root yields zero items and never throws', () => {
    const board = listWorkBoard({ root, now });
    expect(board.items).toEqual([]);
    expect(board.truncated).toBe(false);
    expect(['ok', 'unavailable']).toContain(board.inbox);
    const gone = join(root, 'does-not-exist');
    expect(() => listWorkBoard({ root: gone, now })).not.toThrow();
    expect(listWorkBoard({ root: gone, now }).items).toEqual([]);
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
      + 'owner-missing=yes channel=bus ref=none');
    expect(lines[1]).toBe(`slack-request-b RECEIVED as-of=${iso(now - 2_000)} source=receivedAt `
      + `owner-missing=yes channel=slack ref=${REF_B}`);
    expect(lines[2]).toBe(`slack-request-a RUNNING as-of=${asOf} `
      + `source=bus-work-claims lease-until ${iso(now + 600_000)} owner-missing=no channel=slack ref=${REF_A}`);
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
    expect(await cmdFleetWorkBoard(['--json', '--json'])).toBe(2);
    expect(await cmdFleetWorkBoard(['--root', root, '--root', root])).toBe(2);
    expect(log).not.toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
  });
});
