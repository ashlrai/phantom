import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { readReplyState } from '../src/core/comms/reply-state.js';
import { RUNNING_FRESH_MS } from '../src/core/comms/work-item-state.js';

const start = Date.parse('2026-11-12T22:29:00.000Z');
let root: string;
let now: number;
const request = (id: string): BusEnvelope => ({
  id, from: 'fake-peer', to: 'fake-lane', priority: 'P2', ttl: 10_000_000,
  channel: 'slack', channel_ref: 'TFAKE/CFAKE/1700000000.000001',
  sender: { agent_id: 'fake-peer', vendor: 'fake-vendor', human: false, team: true },
  external: false, body: { kind: 'work' },
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'reply-freshness-'));
  chmodSync(root, 0o700);
  now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

it('reports stale claim evidence on the original and repeated request', () => {
  expect(appendBusInbox(request('first'), { root, now: () => now }).status).toBe('posted');
  now += 1000;
  expect(appendBusInbox(request('repeat'), { root, now: () => now }).status).toBe('posted');
  expect(mutateBusWorkClaim({ action: 'acquire', id: 'first', owner: 'fake-owner', leaseMs: 60_000, root }).status).toBe('acquired');
  const read = (at: number, id = 'first') => readReplyState(id, { root, now: at });
  const leaseEnd = now + 60_000;
  expect(read(now).state).toBe('RUNNING');
  const boundary = read(leaseEnd + RUNNING_FRESH_MS);
  expect(boundary).toMatchObject({ state: 'ASSIGNED', missing: [] });
  expect(boundary.text).not.toContain('missing:');
  const stale = read(leaseEnd + RUNNING_FRESH_MS + 1);
  expect(stale).toMatchObject({ state: 'ASSIGNED', owner: 'fake-owner',
    claim: `bus-claim:first:1:${start}`, missing: ['fresh running evidence'],
    source: `claim:bus-claim:first:1:${start}`, asOf: new Date(start).toISOString() });
  expect(stale.text).toContain(`owner fake-owner, claim bus-claim:first:1:${start} (missing: fresh running evidence)`);
  const repeat = read(leaseEnd + RUNNING_FRESH_MS + 1, 'repeat');
  expect(repeat).toMatchObject({ requestId: 'repeat', id: 'first', duplicateOf: 'first',
    state: stale.state, missing: stale.missing, source: stale.source, asOf: stale.asOf });
  expect(repeat.text).toContain('(missing: fresh running evidence); repeat of first');
});
