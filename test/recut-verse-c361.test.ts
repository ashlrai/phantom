/**
 * recut-verse-c361.test.ts — the RQ-PHX-RECUTVERSEC361 acceptance proof for
 * the recut of PR #5253 (RQ-PHX-RECUTDESKOLDC203): the per-session guidance
 * box on the Working card of the desktop fleet pane.
 *
 * The PR's api.ts routes could not come across the scope boundary, so the
 * same three endpoints live inside the fleet-control family instead:
 *
 *   GET  /api/verse/fleet/control/guidance        → aggregate ack state
 *   GET  /api/verse/fleet/control/guidance/<job>  → one session's file
 *   POST /api/verse/fleet/control/guidance/<job>  → append one {text}
 *
 * What is asserted here is the PR's visible goal: a posted guidance message
 * lands in the session's file, the aggregate read reports it as queued, and
 * the view-model the Guide cell renders produces the "Queued" ack line a
 * row shows until a consumer acknowledges it.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { ackLabel, guidanceForJob, narrowGuidanceList } from '../src/web-ui/routes/verse/fleet/session-guidance-model.js';

const LIST_PATH = '/api/verse/fleet/control/guidance';
const JOB = 'RQ-PHX-SESSION-1';

let runsDir: string;
beforeEach(async () => {
  runsDir = await mkdtemp(join(tmpdir(), 'recut-verse-c361-'));
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(runsDir, { recursive: true, force: true });
});

async function call(path: string, method = 'GET', body?: unknown, token = 'fixture-token', allowDispatch = true, contentType = 'application/json') {
  const url = `${path}${method === 'GET' ? '' : ''}`;
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, {
    method,
    url,
    headers: { 'content-type': contentType, 'x-ashlr-token': token },
  });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    setHeader() { return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch } as VerseApiContext;
  const handled = await handleFleetControlApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? (JSON.parse(payload) as Record<string, unknown>) : null };
}

it('POST appends one guidance message and the aggregate read reports it queued', async () => {
  const posted = await call(`${LIST_PATH}/${JOB}`, 'POST', { text: 'prefer the existing helper' });
  expect(posted.status).toBe(201);
  expect(posted.body).toMatchObject({ v: 1, ok: true, job: JOB, state: 'queued', strategy: 'requeue', truncated: false });

  const list = await call(LIST_PATH);
  expect(list.status).toBe(200);
  expect(list.body).toMatchObject({ v: 1, sourceState: 'healthy' });

  // The view-model the Working card's Guide cell renders, fed the real payload:
  const narrowed = narrowGuidanceList(list.body);
  const summary = narrowed && guidanceForJob(narrowed.sessions, JOB);
  expect(summary).toMatchObject({ job: JOB, pending: 1, latest: { state: 'queued' } });
  expect(ackLabel(summary?.latest ?? null)).toBe('Queued');

  const one = await call(`${LIST_PATH}/${JOB}`);
  expect(one.status).toBe(200);
  expect(one.body).toMatchObject({ v: 1, job: JOB, sourceState: 'healthy', pending: 1 });
  expect((one.body?.entries as { text: string }[])[0]?.text).toBe('prefer the existing helper');
});

it('refuses bad jobs, bad bodies and wrong methods the same way the PR route did', async () => {
  expect((await call(`${LIST_PATH}/bad%2Fid`, 'GET')).status).toBe(400);
  expect((await call(`${LIST_PATH}/x`, 'GET')).status).toBe(400);
  expect((await call(`${LIST_PATH}/`, 'GET')).status).toBe(400);
  expect((await call(`${LIST_PATH}?extra=1`)).status).toBe(400);
  expect((await call(`${LIST_PATH}/${JOB}`, 'PUT')).status).toBe(405);
  expect((await call(LIST_PATH, 'POST', { text: 'x' })).status).toBe(405);
  for (const body of [
    { text: 5 }, { text: 'ok', extra: true }, { text: 'ok', source: 'bad source!' }, 'junk', 4,
  ]) {
    expect((await call(`${LIST_PATH}/${JOB}`, 'POST', body)).status).toBe(400);
  }
  expect(await call(`${LIST_PATH}/${JOB}`, 'POST', { text: '   ' })).toMatchObject({ status: 400, body: { error: 'guidance text is empty' } });
});

it('keeps the mutation gate: no dispatch, no token, no JSON, no write', async () => {
  const body = { text: 'steer this job' };
  expect((await call(`${LIST_PATH}/${JOB}`, 'POST', body, 'fixture-token', false)).status).toBe(404);
  expect((await call(`${LIST_PATH}/${JOB}`, 'POST', body, 'wrong-token')).status).toBe(401);
  expect((await call(`${LIST_PATH}/${JOB}`, 'POST', body, 'fixture-token', true, 'text/plain')).status).toBe(415);
  // And nothing landed: the aggregate read is still empty.
  expect((await call(LIST_PATH)).body).toMatchObject({ sourceState: 'missing', sessions: [] });
});

it('a missing route payload narrows to the not-in-build null, never a broken row', async () => {
  expect(narrowGuidanceList(null)).toBeNull();
  expect(narrowGuidanceList({ error: 'not found' })).toBeNull();
});
