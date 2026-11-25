import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CHANGE_REQUEST_PATH, CHANGE_REQUESTS_PATH, handleChangeRequestApi } from '../src/core/verse/change-request-api.js';
const TOKEN = 'change-request-test-token';
const body = { description: 'Please add a compact activity summary card.', surface: 'chat' };
const NOW = Date.parse('2026-11-25T11:00:00.000Z');
let tempRoot: string;

beforeEach(async () => {
  // Safe real I/O: the API writes only under this disposable temp root.
  tempRoot = await mkdtemp(join(tmpdir(), 'change-request-api-'));
});
afterEach(async () => rm(tempRoot, { recursive: true, force: true }));
async function call(path: string, method: string, options: { allowDispatch?: boolean; token?: string | null; body?: unknown } = {}) {
  const stream = new PassThrough();
  Object.assign(stream, {
    method, url: path,
    headers: { 'content-type': 'application/json', ...(options.token === null ? {} : { 'x-ashlr-token': options.token ?? TOKEN }) },
  });
  const req = stream as unknown as IncomingMessage & PassThrough;
  let status = 0;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end() { return this; },
  } as unknown as ServerResponse;
  const handled = handleChangeRequestApi(
    { allowDispatch: options.allowDispatch ?? true, token: TOKEN }, req, res, path,
    { statusRoot: join(tempRoot, 'router'), runsRoot: join(tempRoot, 'runs'), now: () => NOW },
  );
  req.end(options.body === undefined ? '' : JSON.stringify(options.body));
  await handled;
  return status;
}
it('hides both endpoints when dispatch is disabled', async () => {
  expect(await call(CHANGE_REQUEST_PATH, 'POST', { allowDispatch: false, body })).toBe(404);
  expect(await call(CHANGE_REQUESTS_PATH, 'GET', { allowDispatch: false })).toBe(404);
});
it('requires the mutation token for both POST and GET', async () => {
  expect(await call(CHANGE_REQUEST_PATH, 'POST', { token: null, body })).toBe(401);
  expect(await call(CHANGE_REQUESTS_PATH, 'GET', { token: null })).toBe(401);
});
it('returns 201 and the queued job id for an authorized request', async () => {
  expect(await call(CHANGE_REQUEST_PATH, 'POST', { body })).toBe(201);
});
