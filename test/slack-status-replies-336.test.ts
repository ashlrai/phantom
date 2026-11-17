import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import { recordSlackObservation } from '../src/core/agents/slack-journal.js';
import { buildSlackBridgeStatus, readSlackWorkStatus, slackWorkStatusLine } from '../src/core/agents/slack-status.js';

import { appendBusInbox, type BusEnvelope } from '../src/core/fleet/bus-inbox.js';
import { mutateBusWorkClaim } from '../src/core/fleet/bus-work-claims.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';

const CH = 'C0TESTCHAN1';
const THREAD = '1700000000.000100';
const SECOND = '1700000100.000100';
const NOW = new Date('2023-11-15T00:00:00Z');
const AT1 = '2023-11-14T22:13:20Z';
const AT2 = '2023-11-14T22:15:00Z';
const DIGEST = 'a'.repeat(64);
const CLIENT = '11111111-1111-1111-1111-111111111111';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slack-replies-336-'));
  roots.push(dir);
  return { runsDir: join(dir, 'runs'), stateRoot: join(dir, 'state'), configPath: join(dir, 'agent-network.toml'), commsPath: join(dir, 'comms.toml') };
}
type Row = { key?: string; channel: string; thread?: string; state: 'attempted' | 'sent'; ts?: string };
function writeStore(stateRoot: string, rows: Row[]): void {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const messages: Record<string, unknown> = {};
  rows.forEach((row, i) => {
    const { key, ...rest } = row;
    messages[key ?? String(i).padStart(64, '0')] = { digest: DIGEST, clientId: CLIENT, expiresAt: 9e12, ...rest };
  });
  writeFileSync(join(stateRoot, 'messages.json'), JSON.stringify({ version: 1, messages }), { mode: 0o600 });
}
const rid = (messageTs: string) => fakeRequestId(`336:${messageTs}`);
const key = (messageTs: string) => replyKey(rid(messageTs));
function ingest(runsDir: string, at: string, messageTs: string, decision: 'ingested' | 'ignored' = 'ingested', keyed = true): void {
  recordSlackObservation({ at, decision, channelId: CH, messageTs, threadTs: THREAD, ...(decision === 'ingested' ? { bus: 'posted' as const } : {}), ...(keyed ? { requestId: rid(messageTs) } : {}), ...(decision === 'ignored' ? { reason: 'untrusted-sender' } : {}) }, { runsDir });
}
const status = (p: ReturnType<typeof setup>) => buildSlackBridgeStatus({ ...p, now: () => NOW });

describe('slack status replies (336)', () => {
  it('binds a sent reply only to the request whose reply key it carries', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    ingest(p.runsDir, AT2, SECOND);
    writeStore(p.stateRoot, [{ key: key(THREAD), channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' }]);
    const { replies } = status(p);
    expect(replies).toMatchObject({ state: 'ok', answered: 1, unanswered: 1, unverified: 0, oldestUnansweredAt: AT2, uncertainSends: 0 });
    expect(replies.unansweredSample).toEqual([{ channelId: CH, threadTs: THREAD, messageTs: SECOND, at: AT2 }]);
  });

  it('a keyed exact-key sent reply with unknown bus ingress is uncertain, never answered or overdue', () => {
    const p = setup();
    recordSlackObservation({ at: AT1, decision: 'ingested', channelId: CH, messageTs: THREAD, threadTs: THREAD, requestId: rid(THREAD) }, { runsDir: p.runsDir });
    recordSlackObservation({ at: AT2, decision: 'ingested', channelId: CH, messageTs: SECOND, threadTs: THREAD, requestId: rid(SECOND) }, { runsDir: p.runsDir });
    writeStore(p.stateRoot, [{ key: key(THREAD), channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' }]);
    const { replies } = status(p);
    expect(replies).toMatchObject({ answered: 0, unanswered: 0, uncertainRequests: 2 });
    expect(replies.unansweredSample).toEqual([]);
  });

  it('never treats an attempted receipt as an answer', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [{ key: key(THREAD), channel: CH, thread: THREAD, state: 'attempted' }]);
    // The exact key was attempted: the request is uncertain, never answered, never keyed-unanswered.
    expect(status(p).replies).toMatchObject({ answered: 0, unanswered: 0, uncertainRequests: 1, uncertainSends: 1 });
    // An attempt under an unrelated key leaves the request unanswered.
    writeStore(p.stateRoot, [{ key: key(SECOND), channel: CH, thread: THREAD, state: 'attempted' }]);
    expect(status(p).replies).toMatchObject({ answered: 0, unanswered: 1, uncertainRequests: 0, uncertainSends: 1 });
  });

  it('never lets a same-thread sent receipt without the request key answer it', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [{ channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' }]);
    expect(status(p).replies).toMatchObject({ answered: 0, unanswered: 1 });
  });

  it('keeps a request with no reply identity visible as unverified, not unanswered', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD, 'ingested', false);
    writeStore(p.stateRoot, [{ channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' }]);
    const { replies } = status(p);
    expect(replies).toMatchObject({ answered: 0, unanswered: 0, unverified: 1, oldestUnansweredAt: null });
    expect(replies.unansweredSample).toEqual([]);
  });

  it('does not let a top-level sent post answer a thread', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [{ key: key(THREAD), channel: CH, state: 'sent', ts: '1700000050.000100' }]);
    // Even under the exact key, a top-level post cannot answer a threaded request.
    expect(status(p).replies).toMatchObject({ answered: 0, unanswered: 0, uncertainRequests: 1 });
  });

  it('ignores non-ingested journal entries', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD, 'ignored');
    writeStore(p.stateRoot, []);
    expect(status(p).replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 0, oldestUnansweredAt: null });
  });

  it('reports all ingested requests unanswered when the send store is missing', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    expect(status(p).replies).toMatchObject({ state: 'ok', answered: 0, unanswered: 1, oldestUnansweredAt: AT1 });
  });

  it('reports missing with zeros when both sources are missing', () => {
    const p = setup();
    expect(status(p).replies).toEqual({
      state: 'missing', answered: 0, unanswered: 0, oldestUnansweredAt: null,
      uncertainSends: 0, unverified: 0, uncertainRequests: 0, rejected: 0, futureDated: 0, unansweredSample: [],
      busFailed: 0, busFailedSample: [],
    });
  });

  it('degrades on a corrupt store without throwing or leaking digest/clientId', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    mkdirSync(p.stateRoot, { recursive: true, mode: 0o700 });
    writeFileSync(join(p.stateRoot, 'messages.json'), '{not json', { mode: 0o600 });
    const s = status(p);
    expect(s.replies).toMatchObject({ state: 'degraded', answered: 0, unanswered: 1 });
    expect(JSON.stringify(s)).not.toContain(DIGEST);
  });

  it('never exposes digest or clientId from a valid store, and degrades on malformed rows', () => {
    const p = setup();
    ingest(p.runsDir, AT1, THREAD);
    writeStore(p.stateRoot, [
      { key: key(THREAD), channel: CH, thread: THREAD, state: 'sent', ts: '1700000050.000100' },
      { channel: 'bogus', state: 'sent', ts: '1700000050.000100' },
    ]);
    const s = status(p);
    expect(s.replies).toMatchObject({ state: 'degraded', answered: 1 });
    const text = JSON.stringify(s);
    expect(text).not.toContain(DIGEST);
    expect(text).not.toContain(CLIENT);
  });
});

// Same durable stores and classifier used by the fleet work board.
it('labels receipt, assignment, running, dependency and verification from exact work evidence', () => {
  const p = setup(), busRoot = join(p.runsDir, 'bus');
  const now = Date.now(), channelRef = `slack:T0TEST:${CH}:${THREAD}`;
  const opts = { ...p, busRoot, now: () => new Date(now), channelRef };
  const request: BusEnvelope = { id: 'fake-status-request', from: 'fake-owner', to: 'leader', priority: 'P1', ttl: 600_000,
    channel: 'slack', channel_ref: channelRef, external: false,
    sender: { agent_id: 'fake-owner', vendor: 'fake', human: true, team: true }, body: { kind: 'note', text: 'status' } };
  expect(appendBusInbox(request, { root: busRoot, now: () => now }).status).toBe('posted');
  const line = () => slackWorkStatusLine(readSlackWorkStatus(opts), { inReplyTo: request.id });
  expect(line()).toBe('RECEIVED; owner unknown; claim unknown; fleet as of unknown');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const claim = mutateBusWorkClaim({ action: 'acquire', root: busRoot, id: request.id, owner: 'fake-worker', leaseMs: 60_000 });
  expect(claim.status).toBe('acquired');
  expect(line()).toBe(`RUNNING; owner fake-worker; claim bus-claim:fake-status-request:1:${now}; fleet as of unknown`);
  expect(mutateBusWorkClaim({ action: 'complete', root: busRoot, id: request.id, token: claim.token }).status).toBe('completed');
  expect(line()).toMatch(/^ASSIGNED; owner fake-worker; claim bus-claim:fake-status-request:1:/);
  expect(postBusReply(request.id, 'fake-block', { blocked: { dependency: 'review <@FAKE>\nneeded' } }, { root: busRoot, now: () => now }).outcome).toBe('posted');
  expect(line()).toBe('BLOCKED; dependency review ?@FAKE? needed; fleet as of unknown');
  expect(postBusReply(request.id, 'fake-verified', { verified: { pr: 42, head: 'abcdef123' } }, { root: busRoot, now: () => now }).outcome).toBe('posted');
  expect(line()).toBe('VERIFIED; PR 42; head abcdef123; fleet as of unknown');
  expect(JSON.stringify(readSlackWorkStatus(opts))).not.toContain(claim.token!);
  expect(slackWorkStatusLine(readSlackWorkStatus(opts), { inReplyTo: 'different-request' })).toMatch(/^UNKNOWN;/);
  expect(readSlackWorkStatus({ ...opts, channelRef: `slack:T0OTHER:${CH}:${THREAD}` }).items).toEqual([]);
  expect(buildSlackBridgeStatus(opts).work).toEqual(readSlackWorkStatus(opts));
});

it.each(['not-json', '{}', '{"last_tick":"tomorrow"}', '{"last_tick":"2999-01-01T00:00:00Z"}'])('keeps unavailable fleet time unknown: %s', raw => {
  const p = setup();
  mkdirSync(join(p.runsDir, 'queue'), { recursive: true });
  writeFileSync(join(p.runsDir, 'queue/status.json'), raw);
  expect(readSlackWorkStatus({ ...p, busRoot: join(p.runsDir, 'missing'), now: () => NOW }).asOf).toBeNull();
});
