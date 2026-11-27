/**
 * readLeaderNetworkState — the read-only projection behind the unified
 * inbox's leader-network source: the leader network's durable route and
 * digest state at <runsDir>/leader/network-state.json. The network's own
 * pending() mutates recovery state under its writer lock, so the inbox
 * reads the file directly — the same bounded anchored read
 * readRouteReplyFacts applies, never a lock, never a write, never a
 * throw. Hermetic: state lives under a temp dir; no network, no model
 * calls.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readLeaderNetworkState } from '../src/core/agents/leader-network-read.js';

let runsDir: string;
const roots: string[] = [];
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);

beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'leader-network-read-')); roots.push(runsDir);
});
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const leaderDir = () => join(runsDir, 'leader');
const stateFile = () => join(leaderDir(), 'network-state.json');
function writeState(state: unknown): void {
  mkdirSync(leaderDir(), { recursive: true, mode: 0o700 });
  writeFileSync(stateFile(), typeof state === 'string' ? state : JSON.stringify(state), { mode: 0o600 });
}

/** A route shaped like the writer's own record — recipient id, channel ref
 * and fingerprint are writer-private and must never surface in a fact. */
const route = (over: Record<string, unknown> = {}) => ({
  channel: 'telegram',
  recipient: '+15550001111',
  channelRef: 'private-channel-ref-123',
  receivedAt: NOW - 3_600_000,
  inbox: true,
  bus: true,
  fingerprint: 'f'.repeat(64),
  message: {
    id: 'env-1', from: 'mason', to: 'leader', channel: 'telegram',
    channel_ref: 'private-channel-ref-123', priority: 'P0', ttl: 86_400_000,
    body: { kind: 'message', text: 'fake owner request' },
  },
  ...over,
});
const digestReceipt = (over: Record<string, unknown> = {}) => ({
  at: NOW - 7_200_000, sent: false, attempted: true,
  envelope: {
    id: 'env-digest', from: 'leader', to: 'mason', channel: 'telegram', priority: 'P2', ttl: 86_400_000,
    body: { kind: 'leader-away-digest', day: '2026-11-06', text: 'fake digest' },
  },
  ...over,
});
const state = (routes: Record<string, unknown>, digests: Record<string, unknown> = {}) => ({
  version: 1, startedAt: NOW - 86_400_000, lastMasonAt: null,
  inboxRetryCursor: 0, routes, digests,
});

describe('readLeaderNetworkState', () => {
  it('reports missing for an absent state file and creates nothing', () => {
    expect(readLeaderNetworkState({ runsDir })).toEqual({ status: 'missing' });
    expect(existsSync(leaderDir())).toBe(false);
  });

  it('projects routes and digests to delivery facts with job citations', () => {
    writeState(state({
      [KEY_A]: route({
        message: {
          id: 'env-1', from: 'mason', to: 'leader', channel: 'telegram',
          body: { kind: 'work.post', jobId: 'RQ-LEADER-9', text: 'fake cited request' },
        },
      }),
      [KEY_B]: route({
        receivedAt: NOW - 1_800_000, inbox: false, bus: true,
        reply: { text: 'fake reply', fingerprint: 'e'.repeat(64), at: NOW - 900_000, recorded: true, published: true, delivered: false, attempted: true },
      }),
    }, {
      ['c'.repeat(64)]: digestReceipt(),
    }));
    const read = readLeaderNetworkState({ runsDir });
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(read.requests).toHaveLength(2);
    expect(read.digests).toHaveLength(1);
    const awaiting = read.requests.find(r => r.requestId === KEY_A)!;
    expect(awaiting).toMatchObject({
      channel: 'telegram', to: 'leader', receivedAt: NOW - 3_600_000,
      text: 'fake cited request', inbox: true, bus: true, reply: null,
      jobIds: ['RQ-LEADER-9'],
    });
    const unconfirmed = read.requests.find(r => r.requestId === KEY_B)!;
    expect(unconfirmed.reply).toEqual({ delivered: false, attempted: true, at: NOW - 900_000 });
    expect(read.digests[0]).toMatchObject({
      key: 'c'.repeat(64), channel: 'telegram', day: '2026-11-06',
      at: NOW - 7_200_000, sent: false, attempted: true,
    });
    // Writer-private fields — recipient ids, channel refs, fingerprints,
    // reply text — never leave the projection.
    const serialized = JSON.stringify(read);
    for (const privateValue of ['+15550001111', 'private-channel-ref-123', 'f'.repeat(64), 'fake reply']) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it('reads an empty but valid state as ok with no facts', () => {
    writeState(state({}, {}));
    expect(readLeaderNetworkState({ runsDir })).toEqual({ status: 'ok', requests: [], digests: [] });
  });

  it('reports unavailable for malformed JSON, a wrong version and non-object stores', () => {
    for (const bad of [
      '{not json',
      JSON.stringify({ version: 2, routes: {}, digests: {} }),
      JSON.stringify({ version: 1, routes: [], digests: {} }),
      JSON.stringify({ version: 1, routes: {}, digests: null }),
      'null',
    ]) {
      writeState(bad);
      expect(readLeaderNetworkState({ runsDir })).toEqual({ status: 'unavailable' });
    }
  });

  it('fails the whole read closed on one malformed route or digest', () => {
    for (const bad of [
      // A non-digest route key.
      state({ 'not-a-key': route() }),
      // A route missing its routing label.
      state({ [KEY_A]: route({ message: { to: '' } }) }),
      // A route with a non-boolean delivery leg.
      state({ [KEY_A]: route({ inbox: 'yes' }) }),
      // A digest missing its channel.
      state({}, { [KEY_B]: digestReceipt({ envelope: { channel: '' } }) }),
      // A digest missing its outcome flags.
      state({}, { [KEY_B]: digestReceipt({ attempted: 'yes' }) }),
    ]) {
      writeState(bad);
      expect(readLeaderNetworkState({ runsDir })).toEqual({ status: 'unavailable' });
    }
  });

  it('reports unavailable when the state path is not a regular file', () => {
    mkdirSync(stateFile(), { recursive: true });
    expect(readLeaderNetworkState({ runsDir })).toEqual({ status: 'unavailable' });
  });
});
