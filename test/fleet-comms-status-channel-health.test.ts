/** GET /api/verse/fleet/comms-status — the channelHealth bridge-health field. */
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import type { ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import { createFleetCommsStatusApi, VERSE_FLEET_COMMS_STATUS_PATH as PATH } from '../src/core/verse/fleet-comms-status-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');

const report: ChannelHealthReport = {
  schemaVersion: 1,
  asOf: '2026-11-13T11:59:00.000Z',
  channels: [
    {
      channel: 'slack', configured: true, processAlive: true, runtimeHost: 'dot-host',
      lastInboundAt: '2026-11-13T11:50:00.000Z', lastReplyAt: '2026-11-13T11:52:00.000Z',
      unansweredCount: 0, state: 'LIVE', missing: [], asOf: '2026-11-13T11:59:00.000Z',
    },
    {
      channel: 'imessage', configured: false, processAlive: 'unknown', runtimeHost: null,
      lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, state: 'BLOCKED',
      missing: ['imessage comms configuration not configured'], asOf: '2026-11-13T11:59:00.000Z',
    },
  ],
};

const unavailable = { schemaVersion: 1, asOf: NOW.toISOString(), channels: [], error: 'unavailable' };

async function call(over: Partial<Parameters<typeof createFleetCommsStatusApi>[0]> = {}, runsDir?: string) {
  const api = createFleetCommsStatusApi({ runsDir: runsDir ?? await mkdtemp(join(tmpdir(), 'channel-health-')), now: () => NOW, ...over });
  let status = 404, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, new PassThrough() as IncomingMessage, res, PATH, 'GET');
  return { handled, status, body: JSON.parse(text), text };
}

afterEach(() => {
  vi.useRealTimers();
});

it('returns the injected report under channelHealth with states intact', async () => {
  const { handled, status, body } = await call({ channelHealth: async () => report });
  expect(handled).toBe(true);
  expect(status).toBe(200);
  expect(body.channelHealth).toEqual(report);
  expect(body.channelHealth.channels.map((channel: { state: string }) => channel.state)).toEqual(['LIVE', 'BLOCKED']);
});

it('degrades to unavailable when the read throws and leaves the rest unchanged', async () => {
  const runsDir = await mkdtemp(join(tmpdir(), 'channel-health-'));
  const baseline = await call({ channelHealth: async () => report }, runsDir);
  for (const channelHealth of [() => { throw new Error('boom'); }, async () => { throw new Error('boom'); }]) {
    const failure = await call({ channelHealth }, runsDir);
    expect(failure.status).toBe(200);
    expect(failure.body.channelHealth).toEqual(unavailable);
    const { channelHealth: _a, ...restBaseline } = baseline.body;
    const { channelHealth: _b, ...restFailure } = failure.body;
    expect(restFailure).toEqual(restBaseline);
  }
});

it('degrades to unavailable when the read never resolves', async () => {
  vi.useFakeTimers();
  const pending = call({ channelHealth: () => new Promise<ChannelHealthReport>(() => {}) });
  let settled = false;
  void pending.then(() => { settled = true; });
  // The health timeout arms after the other collectors; each advance also
  // yields a real event-loop turn so their fs reads can finish.
  for (let i = 0; i < 30 && !settled; i++) await vi.advanceTimersByTimeAsync(1_000);
  expect(settled).toBe(true);
  const { status, body } = await pending;
  expect(status).toBe(200);
  expect(body.channelHealth).toEqual(unavailable);
  expect(body.version).toBe(1);
});

it('redacts the home path and IPv4 addresses in runtimeHost', async () => {
  const dirty: ChannelHealthReport = {
    ...report,
    channels: [
      { ...report.channels[0]!, runtimeHost: `${homedir()}/dot-host` },
      { ...report.channels[1]!, runtimeHost: 'bridge at 192.168.1.20' },
    ],
  };
  const { body } = await call({ channelHealth: async () => dirty });
  expect(body.channelHealth.channels[0].runtimeHost).toBe('~/dot-host');
  expect(body.channelHealth.channels[1].runtimeHost).toBe('bridge at [ip]');
  expect(JSON.stringify(body.channelHealth)).not.toContain(homedir());
});
