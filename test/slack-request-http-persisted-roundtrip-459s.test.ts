/**
 * RQ-PHX-SLACKREQUESTDISKROUNDTRIP459S — persisted-to-HTTP roundtrip for
 * Mason's exact Slack request selection. Real journal.jsonl and
 * messages.json fixtures on private temp roots are read through the real
 * evidence bundle and trace join; only runsDir/stateRoot and the clock are
 * injected at the reader seam. Proves a `?thread&channel&message` GET selects
 * exactly one persisted request: sibling rows and another channel sharing the
 * thread ts cannot answer it, an eligible `sent` receipt answers while a
 * timestamped `attempted` receipt is only `uncertain`, freshness is recomputed
 * on the selection (absent selection is `unknown`), and a fresh reader after
 * "restart" returns identical evidence with no file mutation. Output stays
 * local evidence -- never a runtime reachability/claim/execution assertion.
 */
import { fakeRequestId, replyKey } from './helpers/slack-causal.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceRead } from '../src/core/agents/slack-request-trace.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetSlackTraceApi } from '../src/core/verse/fleet-slack-trace-api.js';

const path = '/api/verse/fleet/control/slack-trace';
const NOW = new Date('2024-11-07T18:00:00.000Z'); // epoch 1731002400.000
const AS_OF = NOW.toISOString();
const THREAD = '1731000000.000100';
const CH_A = 'C0FAKE0001';
const CH_B = 'C0FAKE0002';
const M_OLD = '1731000010.000100';    // older sibling, channel A, answered by its own receipt
const M_TARGET = '1731000020.000100'; // the selected request, channel A
const M_ATTEMPT = '1731000030.000100';// channel A request with only an attempted receipt
const M_B = '1731000020.000100';      // channel B request sharing thread ts AND message ts
const M_UNKNOWN = '1731999999.000100';
const R_OLD = '1731000015.000100';
const R_TARGET = '1731000025.000100';
const R_B = '1731000022.000100';
const ATTEMPT_TS = '1731002395.000100';
const MARKERS = ['PRIVATE-MARKER-J459S', 'PRIVATE-MARKER-IGNORED-459S',
  'PRIVATE-MARKER-SEND-OLD-459S', 'PRIVATE-MARKER-SEND-TARGET-459S',
  'PRIVATE-MARKER-SEND-OTHER-459S', 'PRIVATE-MARKER-ATTEMPT-459S',
  'U0FAKE459S', 'synthetic-digest-459s', 'synthetic-client-459s'];
const roots: string[] = [];

const EMPTY: SlackRequestTraceRead = { asOf: AS_OF, rows: [],
  counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 },
  sources: { journal: 'ok', sends: 'ok' } };

const rid = (channelId: string, ts: string) => fakeRequestId(`459s:${channelId}:${ts}`);
const journalRow = (channelId: string, at: string, messageTs: string) => JSON.stringify({
  at, decision: 'ingested', bus: 'posted', channelId, threadTs: THREAD, messageTs, requestId: rid(channelId, messageTs),
  authorId: 'U0FAKE459S', text: 'PRIVATE-MARKER-J459S',
});
const JOURNAL = [
  journalRow(CH_A, '2024-11-07T11:00:00.000Z', M_OLD),
  journalRow(CH_A, '2024-11-07T12:00:00.000Z', M_TARGET),
  journalRow(CH_A, '2024-11-07T17:59:50.000Z', M_ATTEMPT),
  journalRow(CH_B, '2024-11-07T12:30:00.000Z', M_B),
  JSON.stringify({ at: '2024-11-07T12:31:00.000Z', decision: 'ignored',
    reason: 'PRIVATE-MARKER-IGNORED-459S', channelId: CH_A }),
].join('\n') + '\n';

const sendRow = (channel: string, state: string, ts: string | undefined, marker: string) => ({
  digest: 'synthetic-digest-459s', clientId: 'synthetic-client-459s', channel,
  thread: THREAD, state, ...(ts !== undefined ? { ts } : {}),
  expiresAt: Date.parse(AS_OF) + 3_600_000, note: marker,
});
const STORE = { version: 1, messages: {
  [replyKey(rid(CH_A, M_OLD))]: sendRow(CH_A, 'sent', R_OLD, 'PRIVATE-MARKER-SEND-OLD-459S'),
  [replyKey(rid(CH_A, M_TARGET))]: sendRow(CH_A, 'sent', R_TARGET, 'PRIVATE-MARKER-SEND-TARGET-459S'),
  [replyKey(rid(CH_B, M_B))]: sendRow(CH_B, 'sent', R_B, 'PRIVATE-MARKER-SEND-OTHER-459S'),
  [replyKey(rid(CH_A, M_ATTEMPT))]: sendRow(CH_A, 'attempted', ATTEMPT_TS, 'PRIVATE-MARKER-ATTEMPT-459S'),
} };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'slack-rt-459s-')); roots.push(root);
  const runsDir = join(root, 'runs'); const stateRoot = join(root, 'state');
  mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true, mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  const journalPath = join(runsDir, 'slack-bridge', 'journal.jsonl');
  const sendsPath = join(stateRoot, 'messages.json');
  writeFileSync(journalPath, JOURNAL, { mode: 0o600 });
  writeFileSync(sendsPath, JSON.stringify(STORE), { mode: 0o600 });
  // A fresh reader pair per call simulates a process restart: same disk, new closures.
  const makeApi = () => createFleetSlackTraceApi(
    () => EMPTY,
    (thread, options) => readSlackEvidenceBundle(thread,
      { ...options, runsDir, stateRoot, now: () => NOW }));
  return { root, journalPath, sendsPath, makeApi };
}

const call = (api: ReturnType<typeof createFleetSlackTraceApi>, query: string) =>
  api({} as VerseApiContext, { url: `${path}${query}` } as IncomingMessage,
    {} as ServerResponse, path, 'GET');
const lastBody = () => send.mock.lastCall!.slice(1);
const journalBytes = (f: ReturnType<typeof fixture>) => readFileSync(f.journalPath);
const sendsBytes = (f: ReturnType<typeof fixture>) => readFileSync(f.sendsPath);

afterEach(() => { send.mockClear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

it('answers the exact selected request from persisted evidence; siblings and other channels cannot answer it', async () => {
  const f = fixture();
  const journalBefore = journalBytes(f); const sendsBefore = sendsBytes(f);

  await call(f.makeApi(), `?thread=${THREAD}&channel=${CH_A}&message=${M_TARGET}&maxAgeSeconds=60`);
  const [status, body] = lastBody();
  expect(status).toBe(200);
  expect(body).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread: THREAD, asOf: AS_OF,
    collectionScope: { thread: THREAD, channelId: CH_A },
    selection: { channelId: CH_A, messageTs: M_TARGET },
    counts: { total: 1, answered: 1, uncertain: 0, busFailed: 0, unanswered: 0 },
    truncated: false,
    sources: { journal: 'ok', sends: 'ok' },
    freshness: { maxAgeSeconds: 60, verdict: 'stale' } });
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0]).toMatchObject({ at: '2024-11-07T12:00:00.000Z', channelId: CH_A,
    threadTs: THREAD, messageTs: M_TARGET, ingress: 'posted', outcome: 'answered', replyTs: R_TARGET });
  expect(Object.keys(body.rows[0]).sort())
    .toEqual(['at', 'channelId', 'ingress', 'messageTs', 'outcome', 'replyTs', 'threadTs']);
  // Local evidence only: the scope and freshness basis disclaim live reachability.
  expect(body.scope).toContain('does not prove current runtime reachability, durable task ownership, or execution');
  expect(body.freshness.basis).toContain('not a live probe');
  // Stale verdict is recomputed on the selected 12:00 row, not inherited from
  // the fresh 17:59:50 sibling collected in the same bundle.
  const output = JSON.stringify(body);
  for (const marker of [...MARKERS, f.root]) expect(output).not.toContain(marker);

  // The older sibling is a different request with its own persisted answer.
  await call(f.makeApi(), `?thread=${THREAD}&channel=${CH_A}&message=${M_OLD}&maxAgeSeconds=60`);
  const [, sibling] = lastBody();
  expect(sibling.selection).toEqual({ channelId: CH_A, messageTs: M_OLD });
  expect(sibling.rows).toHaveLength(1);
  expect(sibling.rows[0]).toMatchObject({ messageTs: M_OLD, outcome: 'answered', replyTs: R_OLD });

  // Channel B shares the thread ts and message ts but binds only its own
  // channel-scoped receipt -- A's answer can never leak across channels.
  await call(f.makeApi(), `?thread=${THREAD}&channel=${CH_B}&message=${M_B}&maxAgeSeconds=60`);
  const [, other] = lastBody();
  expect(other.rows).toHaveLength(1);
  expect(other.rows[0]).toMatchObject({ channelId: CH_B, threadTs: THREAD,
    messageTs: M_B, outcome: 'answered', replyTs: R_B });
  expect(other.rows[0].replyTs).not.toBe(R_TARGET);

  expect(journalBytes(f).equals(journalBefore)).toBe(true);
  expect(sendsBytes(f).equals(sendsBefore)).toBe(true);
});

it('a timestamped attempted receipt makes only its own request uncertain; an absent selection is unknown', async () => {
  const f = fixture();
  await call(f.makeApi(), `?thread=${THREAD}&channel=${CH_A}&message=${M_ATTEMPT}&maxAgeSeconds=60`);
  const [status, body] = lastBody();
  expect(status).toBe(200);
  expect(body).toMatchObject({ selection: { channelId: CH_A, messageTs: M_ATTEMPT },
    counts: { total: 1, answered: 0, uncertain: 1, busFailed: 0, unanswered: 0 },
    freshness: { maxAgeSeconds: 60, verdict: 'fresh' } });
  expect(body.rows).toHaveLength(1);
  expect(body.rows[0]).toMatchObject({ channelId: CH_A, messageTs: M_ATTEMPT,
    outcome: 'uncertain' });
  expect(body.rows[0]).not.toHaveProperty('replyTs');

  await call(f.makeApi(), `?thread=${THREAD}&channel=${CH_A}&message=${M_UNKNOWN}&maxAgeSeconds=60`);
  const [, missing] = lastBody();
  expect(missing.selection).toEqual({ channelId: CH_A, messageTs: M_UNKNOWN });
  expect(missing.rows).toEqual([]);
  expect(missing.counts).toEqual({ total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 });
  expect(missing.freshness).toMatchObject({ verdict: 'unknown', maxAgeSeconds: 60 });
  expect(missing.sources).toEqual({ journal: 'ok', sends: 'ok' });
});

it('a fresh reader after restart returns identical evidence without mutating the stores', async () => {
  const f = fixture();
  const journalBefore = journalBytes(f); const sendsBefore = sendsBytes(f);
  const query = `?thread=${THREAD}&channel=${CH_A}&message=${M_TARGET}&maxAgeSeconds=60`;

  await call(f.makeApi(), query);
  const [, first] = lastBody();
  await call(f.makeApi(), query); // new reader closures, same disk bytes
  const [, second] = lastBody();
  expect(second).toEqual(first);
  expect(journalBytes(f).equals(journalBefore)).toBe(true);
  expect(sendsBytes(f).equals(sendsBefore)).toBe(true);
});
