import { expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createFleetRunsApi } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_LANE_MODELS_PATH as path, toFleetLaneModelsV1 } from '../src/core/verse/fleet-lane-models-contract.js';
import type { LaneModelSnapshot } from '../src/core/fleet/lane-models.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const snapshot: LaneModelSnapshot = {
  schema: 'fleet.lane-models.v1', generatedAt: '2026-11-01T00:00:00Z', tiers: ['mid'],
  lanes: [{ lane: 'codex-personal', family: 'codex', tiers: [{ tier: 'mid', model: 'fake-model', via: 'codex.mid' }], lastLaunch: null, mismatch: false }],
  sources: { models: { state: 'healthy', file: 'models.json', entries: 1 }, launches: { state: 'healthy', file: 'metrics/jobs.jsonl', launches: 3, dropped: 0 } },
};
async function request(api: ReturnType<typeof createFleetRunsApi>, method = 'GET') {
  const req = Readable.from([]) as unknown as IncomingMessage;
  req.url = path; req.headers = {};
  let status = 0, body = '';
  const res = { writeHead(code: number) { status = code; }, end(value: string) { body = value; } } as unknown as ServerResponse;
  expect(await api({} as VerseApiContext, req, res, path, method)).toBe(true);
  return { status, body: JSON.parse(body) };
}
it('serves the v1 lane projection and coalesces concurrent reads until 15 seconds', async () => {
  let now = 0;
  const laneModels = vi.fn(async () => snapshot);
  const api = createFleetRunsApi({ laneModels, now: () => now });
  const [first, second] = await Promise.all([request(api), request(api)]);
  expect(first).toEqual({ status: 200, body: { v: 1, generatedAt: new Date(0).toISOString(), source: 'ok', reason: null, lanes: snapshot.lanes, launches: 3 } });
  expect(second).toEqual(first);
  now = 14_999; expect(await request(api)).toEqual(first);
  expect(laneModels).toHaveBeenCalledTimes(1);
  now++; await request(api);
  expect(laneModels).toHaveBeenCalledTimes(2);
});
it('caches a safe unavailable result without leaking reader errors', async () => {
  const laneModels = vi.fn(async () => { throw new Error('fake private diagnostic'); });
  const api = createFleetRunsApi({ laneModels, now: () => 0 });
  expect(await request(api)).toEqual({ status: 200, body: { v: 1, generatedAt: new Date(0).toISOString(), source: 'unavailable', reason: 'Lane model table unavailable', lanes: [], launches: null } });
  await request(api); expect(laneModels).toHaveBeenCalledTimes(1);
});
it('refuses POST without reading models', async () => {
  const laneModels = vi.fn(async () => snapshot);
  expect((await request(createFleetRunsApi({ laneModels }), 'POST')).status).toBe(405);
  expect(laneModels).not.toHaveBeenCalled();
});
it('distinguishes missing tables and unknown launch counts', () => {
  expect(toFleetLaneModelsV1({ ...snapshot, sources: { ...snapshot.sources, models: { ...snapshot.sources.models, state: 'missing', entries: 0 } } }, 0)).toMatchObject({ source: 'unavailable', lanes: [] });
  expect(toFleetLaneModelsV1({ ...snapshot, sources: { ...snapshot.sources, launches: { ...snapshot.sources.launches, state: 'missing' } } }, 0)).toMatchObject({ source: 'ok', launches: null });
});
