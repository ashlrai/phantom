/**
 * readLeaderThreadUndelivered — the read-only scan behind the unified
 * inbox's leader-delivery source: Leader-thread messages whose Telegram
 * delivery the drain can no longer finish (`failed` after its retries, or
 * `pending` past the 72 h offer window `pendingOutbound` applies). Every
 * other read path syncs memos first — a write — so this projection must
 * stay pure. Hermetic: the thread store lives under a temp HOME; no
 * network, no model calls.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  markDelivered,
  postLeaderMessage,
  readLeaderThreadUndelivered,
  THREAD_LIMITS,
} from '../src/core/vision/leader-thread.js';
import { useTmpHome } from './helpers/leader-310b-fakes.js';

const home = useTmpHome();
const NOW = Date.parse('2026-11-07T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

function leaderDir(): string {
  return join(home.home(), '.ashlr', 'vision', 'leader');
}
function writeLog(rows: readonly unknown[]): void {
  mkdirSync(leaderDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(leaderDir(), 'thread.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
}
function writeIndex(delivery: Record<string, { telegram: 'pending' | 'sent' | 'failed'; attempts: number; sentAt?: string }>): void {
  mkdirSync(leaderDir(), { recursive: true, mode: 0o700 });
  writeFileSync(join(leaderDir(), 'thread-index.json'), `${JSON.stringify({
    v: 1, updatedAt: new Date(NOW).toISOString(), delivery, memosPosted: [], modelCalls: {},
  })}\n`, { mode: 0o600 });
}
const msg = (id: string, over: Record<string, unknown> = {}) => ({
  id, at: ago(HOUR), from: 'leader', channel: 'system', kind: 'memo', text: `fake ${id}`, ...over,
});

beforeEach(() => home.setup());
afterEach(() => home.teardown());

describe('readLeaderThreadUndelivered', () => {
  it('reports missing for an absent thread store and creates nothing', () => {
    const read = readLeaderThreadUndelivered({ now: () => NOW });
    expect(read).toEqual({ status: 'missing', items: [] });
    // The scan is read-only: no leader dir, lock file or index appears.
    expect(existsSync(leaderDir())).toBe(false);
  });

  it('lists failed and drain-expired pending deliveries and keeps every other state out', () => {
    writeLog([
      msg('lt-20261107010000-000001'),                                                        // index failed → lists
      msg('lt-20261107020000-000002', { kind: 'question', channel: 'telegram', at: ago(THREAD_LIMITS.outboundMaxAgeMs + 1) }), // index pending, past window → lists
      msg('lt-20261107030000-000003', { kind: 'message' }),                                   // index pending, fresh → drain's queue, never lists
      msg('lt-20261107040000-000004', { kind: 'update' }),                                    // index sent → proved, never lists
      msg('lt-20261107050000-000005', { from: 'mason', channel: 'cli' }),                     // mason's own message → never lists
      msg('lt-20261107060000-000006', { kind: 'answer', at: ago(80 * HOUR), delivery: { telegram: 'pending' } }), // embedded pending, no index entry, stale → lists
      msg('lt-20261107070000-000007', { kind: 'directive', at: 'not-a-time' }),               // pending with unparseable age → unknown stays out
      msg('lt-20261107080000-000008', { kind: 'action', at: ago(THREAD_LIMITS.outboundMaxAgeMs) }), // pending exactly on the window edge → still drainable, never lists
    ]);
    writeIndex({
      'lt-20261107010000-000001': { telegram: 'failed', attempts: 3 },
      'lt-20261107020000-000002': { telegram: 'pending', attempts: 1 },
      'lt-20261107030000-000003': { telegram: 'pending', attempts: 0 },
      'lt-20261107040000-000004': { telegram: 'sent', attempts: 1, sentAt: ago(HOUR) },
      'lt-20261107050000-000005': { telegram: 'failed', attempts: 3 },
      'lt-20261107070000-000007': { telegram: 'pending', attempts: 2 },
      'lt-20261107080000-000008': { telegram: 'pending', attempts: 0 },
      // An index entry whose message rotated out of the log never lists —
      // there is no line left to show.
      'lt-20260101000000-999999': { telegram: 'failed', attempts: 3 },
    });
    const read = readLeaderThreadUndelivered({ now: () => NOW });
    expect(read.status).toBe('ok');
    expect(read.items.map((item) => item.id)).toEqual([
      'lt-20261107010000-000001',
      'lt-20261107020000-000002',
      'lt-20261107060000-000006',
    ]);
    expect(read.items[0]).toMatchObject({
      at: ago(HOUR), channel: 'system', kind: 'memo', text: 'fake lt-20261107010000-000001',
      telegram: 'failed', attempts: 3,
    });
    expect(read.items[1]).toMatchObject({ kind: 'question', channel: 'telegram', telegram: 'pending', attempts: 1 });
    // The embedded-only pending message has no index entry: 0 recorded attempts.
    expect(read.items[2]).toMatchObject({ kind: 'answer', telegram: 'pending', attempts: 0 });
  });

  it('reads the real write path: a posted message lists once its sends are exhausted', () => {
    const posted = postLeaderMessage({ channel: 'system', kind: 'update', text: 'fake proactive update' });
    // Fresh pending is the drain's own queue — it never lists.
    expect(readLeaderThreadUndelivered().items).toEqual([]);
    for (let i = 0; i < THREAD_LIMITS.deliveryAttempts; i += 1) expect(markDelivered(posted.id, 'telegram', false)).toBe(true);
    const read = readLeaderThreadUndelivered();
    expect(read.status).toBe('ok');
    expect(read.items).toHaveLength(1);
    expect(read.items[0]).toMatchObject({
      id: posted.id, kind: 'update', channel: 'system', text: 'fake proactive update',
      telegram: 'failed', attempts: THREAD_LIMITS.deliveryAttempts,
    });
  });

  it('ages a pending message into the list only past the drain window', () => {
    const posted = postLeaderMessage({ channel: 'system', kind: 'memo', text: 'fake memo text' });
    const postedAt = Date.parse(posted.at);
    // Exactly on the window edge the drain still offers it (pendingOutbound
    // includes `<= outboundMaxAgeMs`); one ms past, it is stuck.
    expect(readLeaderThreadUndelivered({ now: () => postedAt + THREAD_LIMITS.outboundMaxAgeMs }).items).toEqual([]);
    const read = readLeaderThreadUndelivered({ now: () => postedAt + THREAD_LIMITS.outboundMaxAgeMs + 1 });
    expect(read.items.map((item) => item.id)).toEqual([posted.id]);
    expect(read.items[0]).toMatchObject({ telegram: 'pending', attempts: 0 });
  });

  it('reports unavailable when the delivery index is malformed', () => {
    writeLog([msg('lt-20261107010000-000001', { at: ago(80 * HOUR), delivery: { telegram: 'pending' } })]);
    mkdirSync(leaderDir(), { recursive: true, mode: 0o700 });
    writeFileSync(join(leaderDir(), 'thread-index.json'), '{"v":2}\n', { mode: 0o600 });
    const read = readLeaderThreadUndelivered({ now: () => NOW });
    // The index is authoritative for delivery state: its refusal hides the
    // whole set rather than guessing from stale line states.
    expect(read).toEqual({ status: 'unavailable', items: [] });
  });

  it('reports unavailable when the log is not a regular file', () => {
    mkdirSync(join(leaderDir(), 'thread.jsonl'), { recursive: true, mode: 0o700 });
    const read = readLeaderThreadUndelivered({ now: () => NOW });
    expect(read).toEqual({ status: 'unavailable', items: [] });
  });

  it('reports degraded when the log exceeds the read cap', () => {
    writeLog([]);
    writeFileSync(join(leaderDir(), 'thread.jsonl'), 'x'.repeat(THREAD_LIMITS.maxBytes * 4 + 1), { mode: 0o600 });
    const read = readLeaderThreadUndelivered({ now: () => NOW });
    expect(read.status).toBe('degraded');
    expect(read.items).toEqual([]);
  });

  it('never mutates the store', () => {
    writeLog([msg('lt-20261107010000-000001')]);
    writeIndex({ 'lt-20261107010000-000001': { telegram: 'failed', attempts: 3 } });
    const indexBytes = readFileSync(join(leaderDir(), 'thread-index.json'));
    const logBytes = readFileSync(join(leaderDir(), 'thread.jsonl'));
    readLeaderThreadUndelivered({ now: () => NOW });
    expect(readFileSync(join(leaderDir(), 'thread-index.json'))).toEqual(indexBytes);
    expect(readFileSync(join(leaderDir(), 'thread.jsonl'))).toEqual(logBytes);
    // No thread lock was taken — the scan never enters the write path.
    expect(existsSync(join(leaderDir(), '.thread.lock'))).toBe(false);
  });
});
