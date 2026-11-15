import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetSlackTraceApi } from '../src/core/verse/fleet-slack-trace-api.js';
import type { SlackRequestTraceRead, SlackTraceRow } from '../src/core/agents/slack-request-trace.js';

const path = '/api/verse/fleet/control/slack-trace';
const call = (api: ReturnType<typeof createFleetSlackTraceApi>, url: string, method: string) =>
  api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
const traceOf = (n: number): SlackRequestTraceRead => ({
  asOf: '2026-11-15T00:00:00.000Z',
  rows: Array.from({ length: n }, (_, i): SlackTraceRow => ({
    at: new Date(Date.UTC(2026, 10, 14, 0, i)).toISOString(), channelId: 'C00000000',
    threadTs: `1700000000.${String(i).padStart(6, '0')}`, messageTs: `1700000000.${String(i).padStart(6, '0')}`,
    ingress: 'posted', outcome: 'unanswered',
  })),
  counts: { total: n, answered: 0, uncertain: 0, busFailed: 0, unanswered: n },
  sources: { journal: 'ok', sends: 'ok' },
});

beforeEach(() => send.mockClear());
afterEach(() => vi.useRealTimers());

it('caps rows at the newest 20 and flags truncation, keeping full counts', async () => {
  const api = createFleetSlackTraceApi(() => traceOf(25));
  expect(await call(api, '/unrelated', 'GET')).toBe(false);
  await call(api, path, 'GET');
  const [, status, body] = send.mock.lastCall!;
  expect(status).toBe(200);
  expect(body.rows).toHaveLength(20);
  expect(body.truncated).toBe(true);
  expect(body.counts.total).toBe(25);
  expect(body.sources).toEqual({ journal: 'ok', sends: 'ok' });
  expect(body.rows[0].threadTs).toBe('1700000000.000024');
  await call(createFleetSlackTraceApi(() => traceOf(3)), path, 'GET');
  expect(send.mock.lastCall![2].truncated).toBe(false);
  expect(send.mock.lastCall![2].rows).toHaveLength(3);
});

it('rejects non-GET with 405 and any query with 400 without reading', async () => {
  const read = vi.fn(() => traceOf(1)), api = createFleetSlackTraceApi(read);
  expect(await call(api, path, 'POST')).toBe(true); expect(send.mock.lastCall![1]).toBe(405);
  await call(api, `${path}?x=1`, 'GET'); expect(send.mock.lastCall![1]).toBe(400);
  expect(read).not.toHaveBeenCalled();
});

it('answers 503 without thrown text when the reader throws', async () => {
  const api = createFleetSlackTraceApi(() => { throw new Error('/Users/private/secret path'); });
  await call(api, path, 'GET');
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'slack trace unavailable' }]);
  expect(JSON.stringify(send.mock.lastCall![2])).not.toContain('private');
});

it('degrades to 503 when the read exceeds 5 seconds', async () => {
  vi.useFakeTimers();
  const api = createFleetSlackTraceApi(() => new Promise<SlackRequestTraceRead>(() => {}));
  const pending = call(api, path, 'GET');
  await vi.advanceTimersByTimeAsync(5_001);
  await pending;
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'slack trace unavailable' }]);
});
