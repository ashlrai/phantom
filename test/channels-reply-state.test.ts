/** reply-state reads the real durable stores in a private tmp root: all five
 * states, a missing record, and a repeat request mapped to the first id. */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { readReplyState, REPLY_STATE_SCHEMA } from '../src/core/comms/reply-state.js';
import { cmdChannelsReplyState } from '../src/cli/channels-reply-state.js';

let root: string, now: number;
const REF = 'T0FAKEWS/C0FAKECH/1700000000.000001';
const request = (id: string, ref?: string): BusEnvelope => ({
  id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
  ...(ref ? { channel: 'slack' as const, channel_ref: ref,
    sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true }, external: false } : {}),
  body: { kind: 'work' },
});
const post = (id: string, ref?: string) => {
  expect(appendBusInbox(request(id, ref), { root, now: () => now }).status).toBe('posted');
  now += 1_000;
};
const claim = (id: string, leaseMs: number) =>
  expect(mutateBusWorkClaim({ action: 'acquire', id, owner: 'fake-owner', leaseMs, root }).status).toBe('acquired');
const reply = (to: string, rid: string, body: Record<string, unknown>) =>
  expect(postBusReply(to, rid, body, { root, now: () => now }).outcome).toBe('posted');
const read = (id: string, at = now) => readReplyState(id, { root, now: at });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-state-'));
  chmodSync(root, 0o700);
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('readReplyState', { timeout: 60_000 }, () => {
  it('RECEIVED with no owner yet for a posted request', () => {
    post('fake-a');
    const s = read('fake-a');
    expect(s.schema).toBe(REPLY_STATE_SCHEMA);
    expect(s).toMatchObject({ state: 'RECEIVED', owner: null, claim: null, duplicateOf: null });
    expect(s.text).toMatch(/^RECEIVED \(as of \d\d:\d\d UTC, source: [^)]+\)\nno owner yet/);
  });

  it('RECEIVED with no owner yet when no record exists at all', () => {
    const s = read('fake-unknown');
    expect(s).toMatchObject({ state: 'RECEIVED', owner: null, id: 'fake-unknown' });
    expect(s.records.inbox).toBe('missing');
    expect(s.text).toContain('no owner yet');
  });

  it('ASSIGNED once an owner holds a durable claim but nothing is running', () => {
    post('fake-b');
    claim('fake-b', 60_000);
    const s = read('fake-b', now + 120_000);
    expect(s.state).toBe('ASSIGNED');
    expect(s.owner).toBe('fake-owner');
    expect(s.claim).toContain('bus-claim:fake-b');
    expect(s.text).toMatch(/^ASSIGNED \(as of .*\)\nowner fake-owner, claim bus-claim:fake-b/);
  });

  it('RUNNING with live claim evidence', () => {
    post('fake-c');
    claim('fake-c', 600_000);
    const s = read('fake-c');
    expect(s.state).toBe('RUNNING');
    expect(s.evidence.running?.source).toContain('bus-work-claims lease-until');
    expect(s.text).toMatch(/^RUNNING \(as of .*\)\nowner fake-owner/);
  });

  it('BLOCKED names the missing dependency', () => {
    post('fake-d');
    reply('fake-d', 'fake-reply-d', { blocked: { dependency: 'fake dep' } });
    const s = read('fake-d');
    expect(s.state).toBe('BLOCKED');
    expect(s.evidence.blocked).toEqual({ dependency: 'fake dep' });
    expect(s.text).toContain('waiting on fake dep');
  });

  it('VERIFIED carries the PR and head', () => {
    post('fake-e');
    reply('fake-e', 'fake-reply-e', { verified: { pr: 7, head: 'fakehead' } });
    const s = read('fake-e');
    expect(s.state).toBe('VERIFIED');
    expect(s.evidence.verified).toMatchObject({ pr: 7, head: 'fakehead' });
    expect(s.text).toContain('PR 7 at fakehead');
  });

  it('prose alone never raises the state', () => {
    post('fake-f');
    reply('fake-f', 'fake-reply-f', { text: 'routed to the fleet, running now' });
    expect(read('fake-f').state).toBe('RECEIVED');
    expect(read('fake-f').text).not.toMatch(/routed|running now/);
  });

  it('a repeat request in the same thread reuses the first id', () => {
    post('fake-first', REF);
    post('fake-second', REF);
    claim('fake-first', 600_000);
    const s = read('fake-second');
    expect(s).toMatchObject({ requestId: 'fake-second', id: 'fake-first', duplicateOf: 'fake-first', state: 'RUNNING' });
    expect(s.text).toContain('repeat of fake-first');
    expect(read('fake-first').duplicateOf).toBeNull();
  });
});

describe('phm channels reply-state', { timeout: 60_000 }, () => {
  it('rejects a missing id and prints help', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdChannelsReplyState([])).toBe(2);
    expect(await cmdChannelsReplyState(['--json'])).toBe(2);
    expect(await cmdChannelsReplyState(['--help'])).toBe(0);
    expect(err).toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('reply-state'));
  });
});

describe('phm work state', () => {
  it('delegates to the reply-state read and rejects other verbs', async () => {
    const { cmdWork } = await import('../src/cli/work.js');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdWork([])).toBe(2);
    expect(await cmdWork(['nope'])).toBe(2);
    expect(await cmdWork(['state'])).toBe(2);
    expect(await cmdWork(['--help'])).toBe(0);
    expect(await cmdWork(['state', 'fake-plain-id'])).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^RECEIVED \(as of .*\)\nno owner yet/));
    expect(err).toHaveBeenCalled();
  });
});
