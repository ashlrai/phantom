import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { VERSE_FLEET_CONTROL_LANES_PATH as PATH, type LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import * as laneTargets from '../src/core/fleet/runs-lane-targets.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'switch-route-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ sol: { target: 2, floor: 0, ceiling: 4, held: false } }));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
async function call(method: string, body?: unknown, token = 'fixture-token', url = PATH, allowDispatch = true, contentType = 'application/json') {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': contentType, 'x-ashlr-token': token } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch } as VerseApiContext;
  const handled = await handleFleetControlApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? JSON.parse(payload) as LaneTargetsV1 : null };
}
it('GET returns lane targets and rejects queries', async () => {
  const result = await call('GET');
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ v: 1, sourceState: 'healthy', generatedAt: expect.any(String), lanes: [{ lane: 'sol', target: 2, floor: 0, ceiling: 4, held: false }] });
  expect((await call('GET', undefined, '', `${PATH}?unknown=1`)).status).toBe(400);
});
it('POST requires dispatch, token and JSON before changing targets', async () => {
  const body = { lane: 'sol', target: 3 };
  expect((await call('POST', body, '')).status).toBe(401);
  expect((await call('POST', body, 'fixture-token', PATH, false)).status).toBe(404);
  expect((await call('POST', body, 'fixture-token', PATH, true, 'text/plain')).status).toBe(415);
  expect((await call('GET')).body?.lanes[0].target).toBe(2);
  const result = await call('POST', body);
  expect(result.status).toBe(200);
  expect(result.body?.lanes[0]).toMatchObject({ target: 3, lastChange: expect.any(String), changedBy: expect.stringContaining('Phantom desktop') });
});
it('returns bounded errors and validates bodies and methods', async () => {
  expect(await call('POST', { lane: 'sol', target: 5 })).toMatchObject({ status: 422, body: { code: 'out-of-range', error: 'Target is outside lane bounds' } });
  expect(await call('POST', { lane: 'absent', target: 1 })).toMatchObject({ status: 422, body: { code: 'unknown-lane' } });
  for (const body of [{ lane: 'sol', target: '1' }, { lane: 'sol', target: 1, extra: true }, { lane: '../sol', target: 1 }]) expect((await call('POST', body)).status).toBe(400);
  expect((await call('DELETE')).status).toBe(405);
  expect((await call('GET', undefined, '', '/unrelated')).handled).toBe(false);
  await rm(join(dir, 'queue/slots.json'));
  expect(await call('POST', { lane: 'sol', target: 1 })).toMatchObject({ status: 503, body: { code: 'unavailable', error: 'Lane targets unavailable' } });
});
it('serializes concurrent lane mutations and shares the switch action lock', async () => {
  const results = await Promise.all([call('POST', { lane: 'sol', target: 3 }), call('POST', { lane: 'sol', target: 1 })]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  // Hold a real lane mutation open so a cold switches import cannot make
  // the requests run sequentially and accidentally miss the shared lock.
  const original = laneTargets.setLaneTarget;
  let release!: () => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const spy = vi.spyOn(laneTargets, 'setLaneTarget').mockImplementation(async (...args) => {
    started();
    await gate;
    return original(...args);
  });
  const pending = call('POST', { lane: 'sol', target: 2 });
  try {
    await ready;
    expect((await call('POST', { id: 'PAUSE', on: true }, 'fixture-token', '/api/verse/fleet/control/switches')).status).toBe(409);
  } finally {
    release();
    await pending;
    spy.mockRestore();
  }
});
