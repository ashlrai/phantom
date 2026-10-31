import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import { VERSE_FLEET_CONTROL_SWITCHES_PATH as PATH, type RunsSwitchesV1 } from '../src/core/fleet/runs-switches.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'switch-route-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
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
  return { handled, status, body: payload ? JSON.parse(payload) as RunsSwitchesV1 : null };
}
it('GET returns the six switch rows and rejects queries', async () => {
  const result = await call('GET');
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ v: 1, sourceState: 'healthy', switches: expect.any(Array) });
  expect(result.body?.switches).toHaveLength(6);
  expect((await call('GET', undefined, '', `${PATH}?unknown=1`)).status).toBe(400);
});
it('POST requires dispatch, token and JSON before changing flags', async () => {
  const body = { id: 'PAUSE', on: true };
  expect((await call('POST', body, '')).status).toBe(401);
  expect((await call('POST', body, 'fixture-token', PATH, false)).status).toBe(404);
  expect((await call('POST', body, 'fixture-token', PATH, true, 'text/plain')).status).toBe(415);
  expect((await call('GET')).body?.switches.find((row) => row.id === 'PAUSE')?.on).toBe(false);
  const result = await call('POST', body);
  expect(result.status).toBe(200);
  expect(result.body?.switches.find((row) => row.id === 'PAUSE')).toMatchObject({ on: true, since: expect.any(String) });
});
it('rejects invalid bodies and methods and ignores unrelated paths', async () => {
  expect((await call('POST', { id: 'unknown', on: true })).status).toBe(400);
  expect((await call('POST', { id: 'PAUSE', on: 'true' })).status).toBe(400);
  expect((await call('DELETE')).status).toBe(405);
  expect((await call('GET', undefined, '', '/unrelated')).handled).toBe(false);
});

it('serializes simultaneous switch mutations through the shared action lock', async () => {
  const results = await Promise.all([
    call('POST', { id: 'PAUSE', on: true }),
    call('POST', { id: 'HOLD', on: true }),
  ]);
  expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
});
