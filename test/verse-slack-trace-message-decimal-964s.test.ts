import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { readSlackEvidenceBundle } from '../src/core/agents/slack-evidence-bundle.js';
import type { SlackRequestTraceRead } from '../src/core/agents/slack-request-trace.js';

const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetSlackTraceApi } from '../src/core/verse/fleet-slack-trace-api.js';

const path = '/api/verse/fleet/control/slack-trace';
const channel = 'C0FAKE0001';
const otherChannel = 'C0FAKE0002';
const asOf = '2024-11-07T18:00:00.000Z';
type Bundle = ReturnType<typeof readSlackEvidenceBundle>;

function row(messageTs: string, channelId = channel, at = '2024-11-07T17:59:50.000Z') {
  return { messageTs, channelId, at, outcome: 'unanswered' } as Bundle['rows'][number];
}

async function select(rows: Bundle['rows'], message: string) {
  const bundle = {
    schema: 'phantom.fleet.slack-evidence.v1', thread: '1.0', asOf, rows,
    counts: { total: rows.length, answered: 99, uncertain: 0, busFailed: 0, unanswered: 0 },
    sources: { journal: 'ok', sends: 'unreadable' },
    freshness: { maxAgeSeconds: 60, verdict: 'stale' },
  } as unknown as Bundle;
  const scoped = vi.fn(() => bundle);
  const api = createFleetSlackTraceApi(() => ({} as SlackRequestTraceRead), scoped);
  await api({} as VerseApiContext, {
    url: `${path}?thread=1.0&channel=${channel}&message=${message}&maxAgeSeconds=60`,
  } as IncomingMessage, {} as ServerResponse, path, 'GET');
  expect(scoped).toHaveBeenCalledWith('1.0', { channelId: channel, maxAgeSeconds: 60 });
  expect(send.mock.lastCall![1]).toBe(200);
  return send.mock.lastCall![2];
}

afterEach(() => send.mockClear());

it('selects decimal equivalents before the cap, preserving timestamps and scoped metadata', async () => {
  const rows = [
    row('000123.4500'),
    row('123.4500000001'),
    row('123.45', otherChannel),
    row('000123.4500invalid'),
    ...Array.from({ length: 25 }, (_, i) => row(`${200 + i}.0`, channel, '2024-11-07T12:00:00.000Z')),
  ];
  const body = await select(rows, '123.45');
  expect(body.rows).toEqual([rows[0]]);
  expect(body.selection).toEqual({ channelId: channel, messageTs: '123.45' });
  expect(body.counts).toEqual({ total: 1, answered: 0, uncertain: 0, busFailed: 0, unanswered: 1 });
  expect(body.freshness.verdict).toBe('fresh');
  expect(body.sources).toEqual({ journal: 'ok', sends: 'unreadable' });
  expect(body.truncated).toBe(false);
});

it('compares large seconds and fractional digits without rounding and reports no match as unknown', async () => {
  const rows = [row('09007199254740993.4500'), row('9007199254740992.45'), row('9007199254740993.4500000001')];
  const body = await select(rows, '9007199254740993.45');
  expect(body.rows).toEqual([rows[0]]);
  expect(body.counts.total).toBe(1);
  expect(body.freshness.verdict).toBe('fresh');
  const absent = await select(rows, '9007199254740994.45');
  expect(absent.rows).toEqual([]);
  expect(absent.counts.total).toBe(0);
  expect(absent.freshness.verdict).toBe('unknown');
});
