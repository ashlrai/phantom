/**
 * verse/runs-history-api.ts — GET /api/verse/runs-history/lane-truth. The
 * handler is invoked directly with injected deps; no server, no real files.
 * Fake lanes and fake meter values only.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createRunsHistoryApi,
  VERSE_RUNS_HISTORY_LANE_TRUTH_PATH as PATH,
  VERSE_RUNS_HISTORY_PATH,
  type RunsHistoryApiDeps,
} from '../src/core/verse/runs-history-api.js';
import type { LaneState, MeterSample } from '../src/core/fleet/lane-truth.js';
import type { RunsHistory } from '../src/core/fleet/runs-history.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const AT = '2026-10-31T12:00:00.000Z';
const series: RunsHistory = {
  v: 1, generatedAt: AT, from: '2026-10-30T12:00:00.000Z', to: AT,
  sourceState: 'healthy', dropped: 0,
  samples: [{ at: AT, lanes: [{ lane: 'fake-lane', running: 1, target: 2, queued: 3, held: false }], workers: 4, leaders: 1, paused: false }],
};
const now = Date.now();
const lane: LaneState = { lane: 'codex-personal', target: 14, running: 0, queued: 16, held: true };
const meter: MeterSample = {
  provider: 'codex-personal', window: 'primary:300', usedPercent: 1,
  resetAt: new Date(now + 7 * 24 * 3600_000).toISOString(), sampledAt: new Date(now).toISOString(),
};
const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
const deps = (over: Partial<RunsHistoryApiDeps> = {}): RunsHistoryApiDeps => ({
  sample: vi.fn(async () => true),
  readHistory: vi.fn(async () => series),
  laneTruth: { lanes: vi.fn(async () => [lane]), meters: vi.fn(async () => [meter]) },
  ...over,
});

async function call(method: string, url = PATH, d: RunsHistoryApiDeps = deps()) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createRunsHistoryApi(d)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null };
}

describe('GET /api/verse/runs-history/lane-truth', () => {
  it('serves the lane verdict with the meter that produced it', async () => {
    const result = await call('GET');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ v: 1, source: 'ok', maxAgeMs: 15 * 60_000 });
    expect(Number.isFinite(Date.parse(result.json!.generatedAt as string))).toBe(true);
    expect(result.json!.lanes).toEqual([{
      lane: 'codex-personal', verdict: 'held_with_capacity',
      target: 14, running: 0, queued: 16, held: true,
      meter: { provider: 'codex-personal', usedPercent: 1, resetAt: meter.resetAt, sampledAt: meter.sampledAt },
      reason: 'held while its meter shows available capacity',
    }]);
  });

  it('serves a lane with no meter evidence as unknown with a null meter', async () => {
    const result = await call('GET', PATH, deps({ laneTruth: { lanes: async () => [lane], meters: async () => [] } }));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ source: 'ok' });
    expect(result.json!.lanes).toEqual([
      expect.objectContaining({ lane: 'codex-personal', verdict: 'unknown', meter: null }),
    ]);
  });

  it.each(['lanes', 'meters'] as const)('answers 200 unavailable when the %s reader throws', async (reader) => {
    const laneTruth = {
      lanes: reader === 'lanes' ? vi.fn(async () => { throw new Error('fixture-secret-path'); }) : vi.fn(async () => [lane]),
      meters: reader === 'meters' ? vi.fn(async () => { throw new Error('fixture-secret-path'); }) : vi.fn(async () => [meter]),
    };
    const result = await call('GET', PATH, deps({ laneTruth }));
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ v: 1, source: 'unavailable', lanes: [] });
    expect(JSON.stringify(result.json)).not.toContain('fixture-secret-path');
  });

  it('answers 405 for other methods on the path and false for other paths', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('DELETE')).status).toBe(405);
    expect((await call('GET', '/api/verse/runs-history/other')).handled).toBe(false);
    expect((await call('GET', '/api/verse/other')).handled).toBe(false);
  });

  it('rejects query parameters — the route takes none', async () => {
    const result = await call('GET', `${PATH}?hours=24`);
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({ code: 'VERSE_INVALID' });
  });

  it('keeps the ?hours= route answering beside it', async () => {
    const d = deps();
    const result = await call('GET', `${VERSE_RUNS_HISTORY_PATH}?hours=6`, d);
    expect(result.status).toBe(200);
    expect(result.json).toEqual(series);
    expect(d.readHistory).toHaveBeenCalledWith(6);
    expect(d.laneTruth!.lanes).not.toHaveBeenCalled();
  });
});
