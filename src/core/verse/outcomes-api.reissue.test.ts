import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { reissueJob } from '../fleet/job-reissue.js';
import { handleOutcomesApiWithDeps } from './outcomes-api.js';
import type { VerseApiContext } from './verse-api.js';
vi.mock('./verse-api.js', () => ({ getVerseEngine: vi.fn() }));
let runsDir: string;
const token = 'plainly-fake-reissue-token';
const id = 'RQ-PHX-EXAMPLE31';
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'reissue-api-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
async function request(body: unknown, authenticated = true, allowDispatch = true) {
  const path = '/api/verse/outcomes/fleet-reissue';
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.url = path;
  req.headers = { 'content-type': 'application/json', ...(authenticated ? { 'x-ashlr-token': token } : {}) };
  const result = { status: 0, value: {} as Record<string, unknown> };
  const res = { writeHead(status: number) { result.status = status; }, end(body: string) { result.value = JSON.parse(body); } } as unknown as ServerResponse;
  expect(await handleOutcomesApiWithDeps({ token, allowDispatch } as VerseApiContext, req, res, path, 'POST', {
    reissueJob: (id, opts) => reissueJob(id, { ...opts, runsDir }),
  })).toBe(true);
  return result;
}
it('requires mutation authority, writes with it, and honors dispatch disablement', async () => {
  await writeFile(join(runsDir, `${id}.prompt`), 'Recover work.');
  expect((await request({ id, lane: 'devin' }, false)).status).toBe(401);
  expect((await request({ id, lane: 'devin' }, true, false)).status).toBe(404);
  expect(await request({ id, lane: 'devin' })).toMatchObject({ status: 202, value: { outcome: 'written', newId: 'EXAMPLE31R1' } });
});
it('returns 400 for an unsafe id and 409 for a missing prompt', async () => {
  expect((await request({ id: '../escape' })).status).toBe(400);
  expect((await request({ id })).status).toBe(409);
});
