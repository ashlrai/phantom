import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFleetRunsApi, VERSE_FLEET_RUNS_REASSIGN_PATH as PATH } from './fleet-runs-api.js';
import { ReassignError, type ReassignInput, type ReassignOptions, type ReassignReportV1 } from '../fleet/runs-reassign.js';
import type { VerseApiContext } from './verse-api.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'runs-reassign-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function call(api: ReturnType<typeof createFleetRunsApi>, method: string, body?: unknown, token = 'fixture-token', allowDispatch = true, channel = '') {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: PATH, headers: { 'content-type': 'application/json', 'x-ashlr-token': token, 'x-ashlr-channel': channel } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(chunk?: string) { payload = chunk ?? ''; return this; } } as unknown as ServerResponse;
  await api({ token: 'fixture-token', allowDispatch } as VerseApiContext, req, res, PATH, method);
  return { status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null, payload };
}
const report: ReassignReportV1 = { v: 1, generatedAt: 'private', applied: true, lane: 'codex', moved: [{ id: 'RQ-PHX-TEST1', fromLane: 'claude', toLane: 'codex', fromTier: 'fast', toTier: 'smart' }], skipped: [{ id: 'RQ-PHX-TEST2', reason: 'job-parked' }], verified: true };
const stub = () => vi.fn(async (_input: ReassignInput, _opts?: ReassignOptions): Promise<ReassignReportV1> => report);

it('applies and projects a single job with server-owned identity', async () => {
  const reassign = stub();
  const result = await call(createFleetRunsApi({ reassign, runsDir: dir }), 'POST', { job: 'RQ-PHX-TEST1', lane: 'codex', tier: 'smart' });
  expect(result.status).toBe(200);
  expect(result.body).toEqual({ v: 1, applied: true, lane: 'codex', moved: report.moved, skipped: report.skipped, verified: true });
  expect(reassign).toHaveBeenCalledWith({ job: 'RQ-PHX-TEST1', lane: 'codex', tier: 'smart', apply: true, force: false, reason: 'desktop' }, { runsDir: dir, changedBy: 'desktop' });
});

it('passes lane selection and maps mobile identity', async () => {
  const reassign = stub();
  const result = await call(createFleetRunsApi({ reassign, runsDir: dir }), 'POST', { fromLane: 'claude', lane: 'codex' }, 'fixture-token', true, 'mobile');
  expect(result.status).toBe(200);
  expect(reassign).toHaveBeenCalledWith({ fromLane: 'claude', lane: 'codex', apply: true, force: false, reason: 'desktop' }, { runsDir: dir, changedBy: 'mobile' });
});

it('rejects malformed bodies without touching the queue', async () => {
  const reassign = stub();
  const api = createFleetRunsApi({ reassign, runsDir: dir });
  for (const body of [{ job: 'RQ-PHX-TEST1', fromLane: 'claude', lane: 'codex' }, { lane: 'codex' }, { job: 'RQ-PHX-TEST1', lane: 'codex', extra: 1 }, { job: 'RQ-PHX-TEST1', lane: '../bad' }, { job: 'RQ-PHX-TEST1', lane: 'codex', force: true }, { job: '../bad', lane: 'codex' }, { fromLane: 'BAD', lane: 'codex' }, { job: 'RQ-PHX-TEST1', lane: 'codex', tier: 'bad-tier' }]) {
    expect(await call(api, 'POST', body)).toMatchObject({ status: 400, body: { code: 'VERSE_INVALID', error: 'invalid reassign body' } });
  }
  expect(reassign).not.toHaveBeenCalled();
});

it('returns typed refusals without messages and hides unexpected errors', async () => {
  const reassign = stub();
  const api = createFleetRunsApi({ reassign, runsDir: dir });
  for (const [code, status] of [['lane-held', 422], ['job-not-found', 404]] as const) {
    reassign.mockRejectedValueOnce(new ReassignError(code));
    expect(await call(api, 'POST', { job: 'RQ-PHX-TEST1', lane: 'codex' })).toMatchObject({ status, body: { code: 'REASSIGN_REFUSED', reason: code } });
  }
  reassign.mockRejectedValueOnce(new Error('/Users/example/x'));
  const result = await call(api, 'POST', { job: 'RQ-PHX-TEST1', lane: 'codex' });
  expect(result).toMatchObject({ status: 503, body: { code: 'REASSIGN_UNAVAILABLE' } });
  expect(result.payload).not.toContain('/Users/example/x');
});

it('enforces method, dispatch and mutation gate', async () => {
  const reassign = stub();
  const api = createFleetRunsApi({ reassign, runsDir: dir });
  expect((await call(api, 'GET')).status).toBe(405);
  expect((await call(api, 'POST', {}, 'fixture-token', false)).status).toBe(404);
  expect((await call(api, 'POST', {}, '')).status).toBe(401);
  expect(reassign).not.toHaveBeenCalled();
});
