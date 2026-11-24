import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { FleetLeaderHealth } from '../src/cli/fleet-leader-health.js';
import { handleLeaderApi } from '../src/core/verse/leader-api.js';
import { createLeaderHealthRoute, LEADER_HEALTH_MIN_INTERVAL_MS, VERSE_LEADER_HEALTH_PATH } from '../src/core/verse/leader-health-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.UTC(2026, 10, 20, 12);
const report = (failures: number | null): FleetLeaderHealth => ({
  schema: 'fleet.leader-health.v1', source: failures === null ? 'unknown' : 'read', consecutiveFailures: failures,
  hoursSinceLastSuccess: failures === null ? null : 4, lastBetAt: null, cause: failures ? 'Claude sign-in expired: run claude login' : null,
});
const session = (expiresAt: number) => ({ readSession: { expiresAt } }) as unknown as VerseApiContext;

function response() {
  const sent = { code: 0, body: undefined as unknown };
  const res = {
    writeHead(code: number) { sent.code = code; return this; }, setHeader() { return this; },
    end(text?: string) { sent.body = text ? JSON.parse(text) : undefined; return this; },
  } as unknown as ServerResponse;
  return { sent, res };
}
const request = () => Object.assign(Readable.from([]), { url: VERSE_LEADER_HEALTH_PATH, headers: {} }) as unknown as IncomingMessage;

describe('GET /api/verse/leader/health', () => {
  it('answers the same document the command prints, unknown left as null', async () => {
    for (const failures of [3, 0, null]) {
      const { sent, res } = response();
      expect(await createLeaderHealthRoute(async () => report(failures), () => NOW)(session(NOW + 1), request(), res, 'GET')).toBe(true);
      expect(sent).toEqual({ code: 200, body: report(failures) });
    }
  });

  it('needs a current read session and reads nothing without one', async () => {
    const read = vi.fn(async () => report(0));
    const route = createLeaderHealthRoute(read, () => NOW);
    for (const ctx of [{} as VerseApiContext, session(NOW), session(NOW - 1), session(Number.NaN)]) {
      const { sent, res } = response();
      await route(ctx, request(), res, 'GET');
      expect(sent.code).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it('refuses another method without reading', async () => {
    const read = vi.fn(async () => report(0));
    const { sent, res } = response();
    await createLeaderHealthRoute(read, () => NOW)(session(NOW + 1), request(), res, 'POST');
    expect(sent.code).toBe(405);
    expect(read).not.toHaveBeenCalled();
  });

  it('shares one reading between callers for the interval, then reads again', async () => {
    let now = NOW;
    const read = vi.fn(async () => report(read.mock.calls.length));
    const route = createLeaderHealthRoute(read, () => now);
    const ask = async () => { const { sent, res } = response(); await route(session(now + 1), request(), res, 'GET'); return (sent.body as FleetLeaderHealth).consecutiveFailures; };
    expect(await ask()).toBe(1);
    now += LEADER_HEALTH_MIN_INTERVAL_MS - 1;
    expect(await ask()).toBe(1);
    now += 1;
    expect(await ask()).toBe(2);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('answers 503 without the error text when the read throws, and reads afresh for the next caller', async () => {
    const read = vi.fn<() => Promise<FleetLeaderHealth>>().mockRejectedValueOnce(new Error('private path /Users/someone')).mockResolvedValue(report(0));
    const route = createLeaderHealthRoute(read, () => NOW);
    const first = response();
    await route(session(NOW + 1), request(), first.res, 'GET');
    expect(first.sent).toEqual({ code: 503, body: { error: 'leader-health-unavailable' } });
    const second = response();
    await route(session(NOW + 1), request(), second.res, 'GET');
    expect(second.sent.code).toBe(200);
  });

  it('is mounted on the Leader routes behind the same read session', async () => {
    const { sent, res } = response();
    expect(await handleLeaderApi({ token: 'test-token', allowDispatch: true } as VerseApiContext, request(), res, VERSE_LEADER_HEALTH_PATH, 'GET')).toBe(true);
    expect(sent.code).toBe(401);
  });
});
