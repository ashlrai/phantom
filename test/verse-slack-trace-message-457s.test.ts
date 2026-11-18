/**
 * RQ-PHX-SLACKREQUESTAPI457S — the desktop slack-trace API gains the optional
 * `message` query the CLI `--message` flag and the MCP `messageTs` argument
 * already support, completing the receipt-backed request evidence path:
 * `?thread=<ts>&channel=<id>&message=<ts>` selects exactly one request after
 * scoped collection — rows, counts and requested freshness recomputed for the
 * selected channel+message only, `selection` echoed as channelId/messageTs —
 * before the 20-row presentation cap. Hermetic: temp roots, fake ids.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceRead } from '../src/core/agents/slack-request-trace.js';
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetSlackTraceApi } from '../src/core/verse/fleet-slack-trace-api.js';

const path = '/api/verse/fleet/control/slack-trace';
const THREAD = '1731000000.000100';
const CHANNEL_A = 'C0FAKE0001';
const CHANNEL_B = 'C0FAKE0002';
const TARGET_TS = '1731000010.000100';
const SIBLING_TS = '1731000020.000100';
const UNKNOWN_TS = '1731999999.000100';
const AS_OF = '2024-11-07T18:00:00.000Z';
const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  send.mockClear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const call = (api: ReturnType<typeof createFleetSlackTraceApi>, query = '', method = 'GET') =>
  api({} as VerseApiContext, { url: path + query } as IncomingMessage, {} as ServerResponse, path, method);
const empty: SlackRequestTraceRead = { asOf: AS_OF, rows: [],
  counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 }, sources: { journal: 'ok', sends: 'ok' } };

const rid = (channelId: string, ts: string) => fakeRequestId(`457s:${channelId}:${ts}`);
const entry = (channelId: string, at: string, messageTs: string, bus = 'posted') =>
  ({ at, decision: 'ingested', bus, channelId, threadTs: THREAD, messageTs, requestId: rid(channelId, messageTs) });
const sent = (channel: string, ts: string) => ({ channel, thread: THREAD, state: 'sent', ts });

/** Temp runs/state roots read through the real collector behind the real API factory. */
function fixture(journal: string, messages: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'slack-trace-message-457s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  const journalPath = join(runsDir, 'slack-bridge', 'journal.jsonl');
  const sendsPath = join(stateRoot, 'messages.json');
  writeFileSync(journalPath, journal, { mode: 0o600 });
  writeFileSync(sendsPath, JSON.stringify({ version: 1, messages }), { mode: 0o600 });
  const read = vi.fn(() => empty);
  const scoped = vi.fn((thread: string, options: { channelId?: string; maxAgeSeconds?: number }) =>
    readSlackEvidenceBundle(thread, { ...options, runsDir, stateRoot, now: () => new Date(AS_OF) }));
  return { api: createFleetSlackTraceApi(read, scoped), read, scoped, runsDir, stateRoot, journalPath, sendsPath };
}

// One answered, stale target in channel A; one fresh unanswered sibling in the
// same channel+thread; one same-messageTs request in another channel.
const sharedJournal = [
  entry(CHANNEL_A, '2024-11-07T12:00:00.000Z', TARGET_TS),
  entry(CHANNEL_B, '2024-11-07T17:59:40.000Z', TARGET_TS),
  entry(CHANNEL_A, '2024-11-07T17:59:50.000Z', SIBLING_TS),
].map((row) => JSON.stringify(row)).join('\n') + '\n';
const sharedMessages = { [replyKey(rid(CHANNEL_A, TARGET_TS))]: sent(CHANNEL_A, '1731002390.000100') };

it('selects exactly one request: siblings never inflate counts or freshness', async () => {
  const f = fixture(sharedJournal, sharedMessages);
  const journalBefore = readFileSync(f.journalPath, 'utf8');
  const sendsBefore = readFileSync(f.sendsPath, 'utf8');

  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}&maxAgeSeconds=60`);
  const [status, body] = send.mock.lastCall!.slice(1);
  expect(status).toBe(200);
  // `message` is a post-collection filter: the collector still sees only
  // thread+channel, and collectionScope carries no messageTs.
  expect(f.scoped).toHaveBeenCalledWith(THREAD, { channelId: CHANNEL_A, maxAgeSeconds: 60 });
  expect(f.read).not.toHaveBeenCalled();
  expect(body).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: THREAD, asOf: AS_OF,
    collectionScope: { thread: THREAD, channelId: CHANNEL_A },
    selection: { channelId: CHANNEL_A, messageTs: TARGET_TS },
    counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 },
    truncated: false, freshness: { maxAgeSeconds: 60, verdict: 'stale' },
    sources: { journal: 'ok', sends: 'ok' } });
  expect(body.collectionScope).toEqual({ thread: THREAD, channelId: CHANNEL_A });
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0]).toMatchObject({ channelId: CHANNEL_A, threadTs: THREAD,
    messageTs: TARGET_TS, ingress: 'posted', outcome: 'answered', replyTs: '1731002390.000100' });
  expect(body.scope).toContain('does not prove current runtime reachability');
  expect(body.freshness.basis).toContain('not a live probe');
  // The verdict is stale from the selected row alone even though a fresh
  // same-channel sibling exists in the collected bundle.

  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}&message=${SIBLING_TS}&maxAgeSeconds=60`);
  const [, sibling] = send.mock.lastCall!.slice(1);
  expect(sibling.selection).toEqual({ channelId: CHANNEL_A, messageTs: SIBLING_TS });
  expect(sibling.rows).toHaveLength(1);
  expect(sibling.rows[0]).toMatchObject({ channelId: CHANNEL_A, messageTs: SIBLING_TS, outcome: 'unanswered' });
  expect(sibling.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
  expect(sibling.freshness.verdict).toBe('fresh');

  // The same messageTs in another channel is a different request: selection is
  // exact channel+message, never a cross-channel borrow of the answer.
  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_B}&message=${TARGET_TS}&maxAgeSeconds=60`);
  const [, other] = send.mock.lastCall!.slice(1);
  expect(other.selection).toEqual({ channelId: CHANNEL_B, messageTs: TARGET_TS });
  expect(other.rows).toHaveLength(1);
  expect(other.rows[0]).toMatchObject({ channelId: CHANNEL_B, messageTs: TARGET_TS, outcome: 'unanswered' });
  expect(other.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
  expect(other.freshness.verdict).toBe('fresh');

  expect(readFileSync(f.journalPath, 'utf8')).toBe(journalBefore);
  expect(readFileSync(f.sendsPath, 'utf8')).toBe(sendsBefore);
});

it('reports an absent selection as empty rows with unknown freshness, not sibling state', async () => {
  const f = fixture(sharedJournal, sharedMessages);
  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}&message=${UNKNOWN_TS}&maxAgeSeconds=60`);
  const [status, body] = send.mock.lastCall!.slice(1);
  expect(status).toBe(200);
  expect(body.selection).toEqual({ channelId: CHANNEL_A, messageTs: UNKNOWN_TS });
  expect(body.rows).toEqual([]);
  expect(body.counts).toEqual({ total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(body.freshness).toMatchObject({ verdict: 'unknown', maxAgeSeconds: 60 });
  expect(body.sources).toEqual({ journal: 'ok', sends: 'ok' });
  expect(body.truncated).toBe(false);
});

it('echoes the selection without a freshness key when no bound is requested', async () => {
  const f = fixture(sharedJournal, sharedMessages);
  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}`);
  const [status, body] = send.mock.lastCall!.slice(1);
  expect(status).toBe(200);
  expect(body.selection).toEqual({ channelId: CHANNEL_A, messageTs: TARGET_TS });
  expect(body.rows).toHaveLength(1);
  expect(body.counts).toEqual({ total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(body).not.toHaveProperty('freshness');
});

it('applies the 20-row cap after selection, so the oldest request survives newer siblings', async () => {
  const journal = Array.from({ length: 26 }, (_, i) => JSON.stringify(
    entry(CHANNEL_A, new Date(Date.UTC(2024, 10, 7, 17, i)).toISOString(), `17310001${String(i).padStart(2, '0')}.000100`),
  )).join('\n') + '\n';
  const f = fixture(journal, {});

  // The selected request is the oldest of 26: a cap applied before selection
  // would drop it; after selection it is the single returned row.
  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}&message=1731000100.000100`);
  const [status, body] = send.mock.lastCall!.slice(1);
  expect(status).toBe(200);
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0]).toMatchObject({ messageTs: '1731000100.000100' });
  expect(body.counts.total).toBe(1);
  expect(body.truncated).toBe(false);

  // Baseline: the same thread+channel without selection is capped at 20 of 26.
  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}`);
  const [, unselected] = send.mock.lastCall!.slice(1);
  expect(unselected.rows).toHaveLength(20);
  expect(unselected.truncated).toBe(true);
  expect(unselected.counts.total).toBe(26);
  expect(unselected).not.toHaveProperty('selection');
});

it('still caps a selection larger than 20 rows', async () => {
  const journal = Array.from({ length: 25 }, (_, i) => JSON.stringify(
    entry(CHANNEL_A, new Date(Date.UTC(2024, 10, 7, 17, i)).toISOString(), TARGET_TS),
  )).join('\n') + '\n';
  const f = fixture(journal, {});
  await call(f.api, `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}`);
  const [, body] = send.mock.lastCall!.slice(1);
  expect(body.counts).toEqual({ total: 25, answered: 0, uncertain: 0, busFailed: 0, unanswered: 25 });
  expect(body.rows).toHaveLength(20);
  expect(body.truncated).toBe(true);
  expect(body.rows.every((row: { messageTs: string }) => row.messageTs === TARGET_TS)).toBe(true);
});

it('rejects malformed, duplicate or under-scoped message queries before any read', async () => {
  const f = fixture(sharedJournal, sharedMessages);
  const queries = [
    `?message=${TARGET_TS}`,                                                            // no thread
    `?thread=${THREAD}&message=${TARGET_TS}`,                                           // no channel
    `?channel=${CHANNEL_A}&message=${TARGET_TS}`,                                       // no thread
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=bad`,                               // malformed ts
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=`,                                  // empty
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=1731000010`,                        // missing dot
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=1.2.3`,                             // extra dot
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}&message=${TARGET_TS}`, // duplicate
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}&bogus=1`,              // unknown key
    `?thread=${THREAD}&channel=bad&message=${TARGET_TS}`,                               // invalid channel
    `?thread=bad&channel=${CHANNEL_A}&message=${TARGET_TS}`,                            // invalid thread
    `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}&maxAgeSeconds=0`,      // invalid age
  ];
  for (const query of queries) {
    await call(f.api, query);
    expect(send.mock.lastCall![1], query).toBe(400);
    expect(send.mock.lastCall![2]).toEqual({ error: 'invalid query parameters' });
  }
  expect(f.scoped).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
});

it('keeps the fixed timeout and generic error for message queries', async () => {
  const query = `?thread=${THREAD}&channel=${CHANNEL_A}&message=${TARGET_TS}`;
  const fail = createFleetSlackTraceApi(() => empty, () => { throw new Error('private collector detail'); });
  await call(fail, query);
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'slack trace unavailable' }]);
  expect(JSON.stringify(send.mock.lastCall![2])).not.toContain('private');

  vi.useFakeTimers();
  const stalled = createFleetSlackTraceApi(() => empty,
    () => new Promise<ReturnType<typeof readSlackEvidenceBundle>>(() => {}));
  const pending = call(stalled, query);
  await vi.advanceTimersByTimeAsync(5_001);
  await pending;
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'slack trace unavailable' }]);
});

it('preserves query-free and thread-scoped output without a selection key', async () => {
  const f = fixture(sharedJournal, sharedMessages);
  await call(f.api);
  expect(send.mock.lastCall!.slice(1)).toEqual([200, { ...empty, truncated: false }]);
  expect(f.read).toHaveBeenCalledTimes(1);

  await call(f.api, `?thread=${THREAD}`);
  const [status, body] = send.mock.lastCall!.slice(1);
  expect(status).toBe(200);
  const bundle = readSlackEvidenceBundle(THREAD,
    { runsDir: f.runsDir, stateRoot: f.stateRoot, now: () => new Date(AS_OF) });
  expect(body).toEqual({ ...bundle, rows: [...bundle.rows].reverse(), truncated: false });
  expect(body).not.toHaveProperty('selection');
  expect(body.rows).toHaveLength(3);
});
