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
const thread = '1731000000.000100';
const call = (api: ReturnType<typeof createFleetSlackTraceApi>, query = '', method = 'GET') =>
  api({} as VerseApiContext, { url: path + query } as IncomingMessage, {} as ServerResponse, path, method);
const empty: SlackRequestTraceRead = { asOf: '2024-11-07T18:00:00.000Z', rows: [],
  counts: { total: 0, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 }, sources: { journal: 'ok', sends: 'ok' } };

afterEach(() => { vi.useRealTimers(); send.mockClear(); });

it('preserves query-free behavior and rejects methods and invalid queries before reading', async () => {
  const read = vi.fn(() => empty);
  const scoped = vi.fn((t: string) => readSlackEvidenceBundle(t));
  const api = createFleetSlackTraceApi(read, scoped);
  await call(api);
  expect(send.mock.lastCall!.slice(1)).toEqual([200, { ...empty, truncated: false }]);
  await call(api, '', 'POST');
  expect(send.mock.lastCall![1]).toBe(405);
  for (const query of ['?channel=C0FAKE0001', '?maxAgeSeconds=1', '?thread=', '?thread=no',
    `?thread=${thread}&thread=${thread}`, `?thread=${thread}&channel=C0FAKE0001&channel=C0FAKE0001`,
    `?thread=${thread}&unknown=1`, `?thread=${thread}&channel=bad`,
    ...['0', '-1', '1.5', '1e2', '9007199254740992', '', '+1'].map(age => `?thread=${thread}&maxAgeSeconds=${age}`)]) {
    await call(api, query);
    expect(send.mock.lastCall![1], query).toBe(400);
  }
  expect(read).toHaveBeenCalledTimes(1);
  expect(scoped).not.toHaveBeenCalled();
});

it('returns only scoped persisted evidence, retaining full counts and freshness without writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'slack-scoped-447s-'));
  try {
    const runsDir = join(root, 'runs');
    const stateRoot = join(root, 'state');
    mkdirSync(join(runsDir, 'slack-bridge'), { recursive: true });
    mkdirSync(stateRoot);
    const journalPath = join(runsDir, 'slack-bridge', 'journal.jsonl');
    const journal = Array.from({ length: 26 }, (_, i) => JSON.stringify({
      at: new Date(Date.UTC(2024, 10, 7, 17, i)).toISOString(), decision: 'ingested', bus: 'posted',
      channelId: i === 25 ? 'C0FAKE0002' : 'C0FAKE0001', threadTs: thread,
      messageTs: `17310000${String(i).padStart(2, '0')}.000100`, authorId: 'UFAKE', text: 'synthetic',
      requestId: fakeRequestId(`447s:${i}`),
    })).join('\n') + '\n';
    writeFileSync(journalPath, journal);
    const read = vi.fn(() => empty);
    const scoped = vi.fn((t: string, options: { channelId?: string; maxAgeSeconds?: number }) =>
      readSlackEvidenceBundle(t, { ...options, runsDir, stateRoot, now: () => new Date(empty.asOf) }));
    await call(createFleetSlackTraceApi(read, scoped), `?thread=${thread}&channel=C0FAKE0001&maxAgeSeconds=7200`);
    const [status, body] = send.mock.lastCall!.slice(1);
    expect(status).toBe(200);
    expect(scoped).toHaveBeenCalledWith(thread, { channelId: 'C0FAKE0001', maxAgeSeconds: 7200 });
    expect(read).not.toHaveBeenCalled();
    expect(body).toMatchObject({ schema: 'phantom.fleet.slack-evidence.v1', thread, asOf: empty.asOf,
      counts: { total: 25, unanswered: 25 }, truncated: true, freshness: { maxAgeSeconds: 7200, verdict: 'fresh' } });
    expect(body.scope).toContain('does not prove current runtime reachability');
    expect(body.freshness.basis).toContain('not a live probe');
    expect(body.rows).toHaveLength(20);
    expect(body.rows.every((row: { channelId: string }) => row.channelId === 'C0FAKE0001')).toBe(true);
    expect(body.rows[0].messageTs).toBe('1731000024.000100');
    expect(readFileSync(journalPath, 'utf8')).toBe(journal);
    expect(readSlackEvidenceBundle(thread, { runsDir, stateRoot }).rows).toHaveLength(26);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it('returns generic errors and times out scoped reads', async () => {
  const query = `?thread=${thread}`;
  const fail = createFleetSlackTraceApi(() => empty, () => { throw new Error('private detail'); });
  await call(fail, query);
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'slack trace unavailable' }]);
  vi.useFakeTimers();
  const stalled = createFleetSlackTraceApi(() => empty, () => new Promise<ReturnType<typeof readSlackEvidenceBundle>>(() => {}));
  const pending = call(stalled, query);
  await vi.advanceTimersByTimeAsync(5001);
  await pending;
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'slack trace unavailable' }]);
});
