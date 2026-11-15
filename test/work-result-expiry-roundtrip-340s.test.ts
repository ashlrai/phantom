import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cmdFleetWorkResult } from '../src/cli/fleet-work-result.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { appendBusInbox, listBusInboxAfter, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { inspectBusWorkClaims } from '../src/core/fleet/bus-work-claims.js';

const A = 'fake-request-340-a', B = 'fake-request-340-b';
const THREAD_A = 'T0FAKE/C0FAKE/1700000000.000340';
const THREAD_B = 'T0FAKE/C0FAKE/1700000000.000341';
const START = 1_700_000_000_000, TTL = 10_000;
const request = (id: string, channel_ref: string, ttl: number): BusEnvelope => ({
  id, from: 'fake-requester', to: 'fake-worker', priority: 'P1', ttl,
  channel: 'slack', channel_ref,
  sender: { agent_id: 'fake-requester', vendor: 'fake-vendor', human: false, team: true },
  external: false, body: { kind: 'work' },
});

describe('work-result expiry roundtrip', { timeout: 120_000 }, () => {
  const root = mkdtempSync(join(tmpdir(), 'work-result-expiry-340-'));
  chmodSync(root, 0o700);
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('keeps replay lifetimes fixed and refuses results at and beyond request expiry', async () => {
    let now = START;
    const opts = { root, now: () => now };
    const result = async (requestId: string, replyId: string, text: string) => {
      const output: string[] = [];
      const code = await cmdFleetWorkResult(
        ['--request-id', requestId, '--reply-id', replyId, '--tests', text, '--root', root, '--json'],
        opts, { output: value => output.push(value) });
      return { code, body: JSON.parse(output.join('')) as { outcome: string } };
    };
    const inbox = () => {
      const page = listBusInboxAfter(0, 100, opts);
      expect(page.status).toBe('ok');
      if (page.status !== 'ok') throw new Error('inbox unavailable');
      return page.messages;
    };
    const board = (id: string) => listWorkBoard({ root, now }).items.find(item => item.id === id);

    expect(appendBusInbox(request(A, THREAD_A, TTL), opts).status).toBe('posted');
    expect(appendBusInbox(request(B, THREAD_B, TTL * 3), opts).status).toBe('posted');
    now += 1_000;
    expect(await result(A, 'fake-result-340-a', 'fake suite A')).toMatchObject({ code: 0, body: { outcome: 'posted' } });
    expect(await result(B, 'fake-result-340-b', 'fake suite B')).toMatchObject({ code: 0, body: { outcome: 'posted' } });
    const initialA = inbox().find(row => row.envelope.id === 'fake-result-340-a')!;
    const initialB = inbox().find(row => row.envelope.id === 'fake-result-340-b')!;
    expect(initialA.receivedAt).toBe(now);
    expect(initialA.envelope.ttl).toBe(TTL - 1_000);
    expect(board(A)).toMatchObject({ state: 'VERIFIED', channelRef: THREAD_A, owner: null, claimReceipt: null,
      result: { kind: 'verified', tests: 'fake suite A' } });
    expect(board(B)).toMatchObject({ state: 'VERIFIED', channelRef: THREAD_B, owner: null, claimReceipt: null,
      result: { kind: 'verified', tests: 'fake suite B' } });

    now += 2_000;
    expect(await result(A, 'fake-result-340-a', 'fake suite A')).toMatchObject({ code: 0, body: { outcome: 'duplicate' } });
    const replayA = inbox().find(row => row.envelope.id === 'fake-result-340-a')!;
    const replayB = inbox().find(row => row.envelope.id === 'fake-result-340-b')!;
    expect(replayA.receivedAt).toBe(initialA.receivedAt);
    expect(replayA.envelope.ttl).toBe(initialA.envelope.ttl - 2_000);
    expect(replayB.receivedAt).toBe(initialB.receivedAt);
    expect(replayB.envelope.ttl).toBe(initialB.envelope.ttl - 2_000);
    expect(inbox()).toHaveLength(4);

    now = START + TTL - 1;
    expect(inbox().find(row => row.envelope.id === A)?.envelope.ttl).toBe(1);
    expect(await result(A, 'fake-result-340-a', 'fake suite A')).toMatchObject({ code: 0, body: { outcome: 'duplicate' } });
    expect(inbox().find(row => row.envelope.id === 'fake-result-340-a')?.envelope.ttl).toBe(1);
    now = START + TTL;
    expect(inbox().map(row => row.envelope.id)).toEqual([B, 'fake-result-340-b']);
    expect(await result(A, 'fake-result-340-boundary', 'too late')).toMatchObject({ code: 3, body: { outcome: 'request-not-found' } });
    now += 1;
    expect(await result(A, 'fake-result-340-late', 'too late')).toMatchObject({ code: 3, body: { outcome: 'request-not-found' } });
    expect(await result(A, 'fake-result-340-a', 'fake suite A')).toMatchObject({ code: 3, body: { outcome: 'request-not-found' } });
    const remaining = inbox();
    expect(remaining.map(row => row.envelope.id)).toEqual([B, 'fake-result-340-b']);
    expect(remaining[1]).toMatchObject({ receivedAt: initialB.receivedAt,
      envelope: { ttl: initialB.envelope.ttl - (now - initialB.receivedAt) } });
    // The board reads retained history, not live-work eligibility; a later
    // successful append may prune expired rows from that history.
    expect(board(A)).toMatchObject({ state: 'VERIFIED', channelRef: THREAD_A, owner: null, claimReceipt: null,
      result: { kind: 'verified', tests: 'fake suite A' } });
    expect(board(B)).toMatchObject({ state: 'VERIFIED', channelRef: THREAD_B, owner: null, claimReceipt: null,
      result: { kind: 'verified', tests: 'fake suite B' } });
    expect(inspectBusWorkClaims(root).claims).toEqual([]);
  });
});
