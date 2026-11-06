import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleFleetHoldsApi } from './fleet-holds-api.js';
import { VERSE_FLEET_CONTROL_HOLDS_PATH as PATH } from '../fleet/runs-lane-hold.js';
import type { LaneTargetsV1 } from '../fleet/runs-lane-targets.js';
import { handleVerseApi, setMountedApiModulesForTest, type VerseApiContext } from './verse-api.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holds-route-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'queue/slots.json'), JSON.stringify({ sol: { target: 2, floor: 0, ceiling: 4, held: true, held_reason: 'autobackoff fake job=j-1 until=2026-11-01T00:00:00Z src=cli_line', held_until: '2026-11-01T00:00:00Z', held_by: 'autobackoff' } }));
});
afterEach(async () => { vi.unstubAllEnvs(); setMountedApiModulesForTest(null); await rm(dir, { recursive: true, force: true }); });
async function call(method: string, body?: unknown, token = 'fixture-token', url = PATH, allowDispatch = true) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': token } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch } as VerseApiContext;
  const handled = await handleFleetHoldsApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? JSON.parse(payload) as LaneTargetsV1 : null };
}
it('GET returns lane targets and rejects queries', async () => {
  const result = await call('GET');
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ v: 1, sourceState: 'healthy', lanes: [{ lane: 'sol', held: true, heldReason: expect.any(String), changedBy: 'autobackoff' }] });
  expect((await call('GET', undefined, '', `${PATH}?unknown=1`)).status).toBe(400);
  expect((await call('GET', undefined, '', '/unrelated')).handled).toBe(false);
});
it('POST releases an autobackoff hold and a second concurrent POST is 409', async () => {
  const results = await Promise.all([call('POST', { lane: 'sol', action: 'release' }), call('POST', { lane: 'sol', action: 'release' })]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect(results.find((r) => r.status === 200)?.body?.lanes[0]).toMatchObject({ lane: 'sol', held: false, changedBy: expect.stringContaining('release') });
});
it('POST requires dispatch and a well-formed action', async () => {
  const body = { lane: 'sol', action: 'release' };
  expect((await call('POST', body, 'fixture-token', PATH, false)).status).toBe(404);
  expect((await call('POST', body, '')).status).toBe(401);
  for (const bad of [{ lane: 'sol' }, { lane: 'sol', action: 'hold' }, { lane: 'sol', action: 'release', extra: 1 }, { lane: '../sol', action: 'release' }, { lane: 'sol', action: 'release', reason: 'bad\nreason' }]) {
    expect((await call('POST', bad)).status).toBe(400);
  }
  expect((await call('POST', 'not-an-object')).status).toBe(400);
  expect((await call('DELETE')).status).toBe(405);
});
it('maps hold errors to bounded statuses', async () => {
  expect(await call('POST', { lane: 'sol', action: 'release', reason: 'reset' })).toMatchObject({ status: 200 });
  expect(await call('POST', { lane: 'sol', action: 'release' })).toMatchObject({ status: 422, body: { code: 'not-held' } });
  await rm(join(dir, 'queue/slots.json'));
  expect(await call('POST', { lane: 'sol', action: 'release' })).toMatchObject({ status: 503, body: { code: 'unavailable' } });
});
it('the real server routes the path past the fleet-control family prefix to the mounted module', async () => {
  setMountedApiModulesForTest([{ id: 'fleet-holds', load: async () => handleFleetHoldsApi }]);
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method: 'GET', url: PATH, headers: {} });
  req.end();
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;
  expect(await handleVerseApi(ctx, req, res, PATH, 'GET')).toBe(true);
  expect(status).toBe(200);
  expect(JSON.parse(payload)).toMatchObject({ v: 1, sourceState: 'healthy' });
});
