import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFleetRunsApi } from './fleet-runs-api.js';
import { VERSE_FLEET_RUNS_STOP_PATH as PATH, type JobStopResult, type StopJobOptions } from '../fleet/job-stop.js';
import type { VerseApiContext } from './verse-api.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'runs-stop-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function call(api: ReturnType<typeof createFleetRunsApi>, method: string, body?: unknown, token = 'fixture-token', url = PATH, allowDispatch = true, contentType = 'application/json') {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': contentType, 'x-ashlr-token': token } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch } as VerseApiContext;
  const handled = await api(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

const stopped: JobStopResult = { id: 'RQ-PHX-TEST1', pids: [111, 222], outcome: 'stopped', at: '2026-11-01T00:08:00.000Z' };
const stubStop = () => vi.fn(async (_id: string, _opts: StopJobOptions): Promise<JobStopResult> => stopped);

it('rejects the POST the way fleet-control rejects without dispatch or the mutation token', async () => {
  const stopJob = stubStop();
  const api = createFleetRunsApi({ stopJob, runsDir: dir });
  expect((await call(api, 'POST', { id: 'RQ-PHX-TEST1' }, 'fixture-token', PATH, false)).status).toBe(404);
  expect((await call(api, 'POST', { id: 'RQ-PHX-TEST1' }, '')).status).toBe(401);
  expect((await call(api, 'POST', { id: 'RQ-PHX-TEST1' }, 'fixture-token', PATH, true, 'text/plain')).status).toBe(415);
  expect(stopJob).not.toHaveBeenCalled();
});

it('answers 202 with the result and calls the injected stopJob with the id', async () => {
  const stopJob = stubStop();
  const api = createFleetRunsApi({ stopJob, runsDir: dir });
  const result = await call(api, 'POST', { id: 'RQ-PHX-TEST1' });
  expect(result.status).toBe(202);
  expect(result.body).toMatchObject({ id: 'RQ-PHX-TEST1', pids: [111, 222], outcome: 'stopped' });
  expect(stopJob).toHaveBeenCalledWith('RQ-PHX-TEST1', { runsDir: dir });
});

it('answers 400 for a bad id and 409 when nothing is running', async () => {
  const stopJob = stubStop();
  const api = createFleetRunsApi({ stopJob, runsDir: dir });
  for (const bad of ['', 'has space', '../x', 'a/b', 'x'.repeat(81)]) {
    expect((await call(api, 'POST', { id: bad })).status).toBe(400);
  }
  expect((await call(api, 'POST', { id: 'RQ-PHX-TEST1', extra: 1 })).status).toBe(400);
  expect((await call(api, 'POST', 'not-an-object')).status).toBe(400);
  expect(stopJob).not.toHaveBeenCalled();
  stopJob.mockImplementation(async (id) => ({ id, pids: [], outcome: 'not-running', at: '2026-11-01T00:08:00.000Z' }));
  expect((await call(api, 'POST', { id: 'RQ-PHX-TEST1' })).status).toBe(409);
  expect((await call(api, 'GET')).status).toBe(405);
});
