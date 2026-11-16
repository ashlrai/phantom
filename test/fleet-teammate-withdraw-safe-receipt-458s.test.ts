import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createFleetTeammateTaskWithdrawApi, VERSE_FLEET_TEAMMATE_TASK_WITHDRAW_PATH as PATH } from '../src/core/verse/fleet-teammate-task-withdraw-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const fake = 'plainly-fake-private-detail';
const unavailable = { code: 'unavailable', error: 'teammate task withdraw unavailable' };
async function call(cancel: () => unknown, method = 'POST', body: unknown = { jobId: 'RQ-FAKE' }, token = 'fixture', allowDispatch = true) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url: PATH, headers: { 'content-type': 'application/json', 'x-ashlr-token': token } });
  req.end(JSON.stringify(body));
  let status = 0, raw = '';
  const res = { setHeader() {}, writeHead(code: number) { status = code; }, end(chunk: string) { raw = chunk; } } as unknown as ServerResponse;
  await createFleetTeammateTaskWithdrawApi(cancel)({ token: 'fixture', allowDispatch } as VerseApiContext, req, res, PATH, method);
  expect(raw).not.toContain(fake);
  return { status, body: JSON.parse(raw) as unknown };
}
const receipt = (state: string, reason?: string) => ({ v: 1, jobId: 'RQ-FAKE', state, ...(reason ? { reason } : {}) });
it.each(['cancelled', 'planned'])('projects only the public %s state', async state => {
  const cancel = vi.fn(() => ({ state, reason: fake, envelope: fake, receipt: fake, token: fake, scope: fake, handle: fake, path: fake }));
  expect(await call(cancel)).toEqual({ status: 200, body: receipt(state) });
  expect(cancel).toHaveBeenCalledExactlyOnceWith('RQ-FAKE', { apply: true });
});
it.each([
  ['refused', 'Cancellation cannot prove a remote stop', 200, 'Cancellation cannot prove a remote stop'],
  ['refused', 'Teammate queue claim changed', 200, 'Teammate queue claim changed'],
  ['refused', fake, 200, 'Teammate task withdrawal refused'],
  ['unavailable', 'Teammate task not found', 503, 'Teammate task not found'],
  ['unavailable', fake, 503, 'Teammate task withdraw unavailable'],
])('bounds %s reason %s', async (state, reason, status, message) => {
  expect(await call(() => ({ state, reason }))).toEqual({ status, body: receipt(String(state), String(message)) });
});
it.each([null, undefined, [], fake, {}, { state: fake }, { state: 200 }, { state: { toString: () => 'cancelled' } }])('fails closed for malformed evidence %#', async result => {
  expect(await call(() => result)).toEqual({ status: 503, body: unavailable });
});
it('keeps busy while pending, hides exceptions and releases after failure', async () => {
  let reject!: (error: Error) => void;
  const cancel = vi.fn(() => new Promise((_resolve, fail) => { reject = fail; }));
  const first = call(cancel);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(await call(cancel)).toEqual({ status: 409, body: { code: 'busy' } });
  reject(new Error(fake));
  expect(await first).toEqual({ status: 503, body: unavailable });
  expect(await call(() => { throw new Error('Teammate tasks busy'); })).toEqual({ status: 409, body: { code: 'busy' } });
  expect(await call(() => ({ state: 'cancelled' }))).toEqual({ status: 200, body: receipt('cancelled') });
});
it('retains method, body, token and dispatch guards', async () => {
  const cancel = vi.fn(() => ({ state: 'cancelled' }));
  expect((await call(cancel, 'GET')).status).toBe(405);
  for (const body of [null, [], {}, { jobId: '../fake' }, { jobId: 'RQ-FAKE', extra: true }]) expect((await call(cancel, 'POST', body)).status).toBe(400);
  expect((await call(cancel, 'POST', { jobId: 'RQ-FAKE' }, '')).status).toBe(401);
  expect((await call(cancel, 'POST', { jobId: 'RQ-FAKE' }, 'fixture', false)).status).toBe(404);
  expect(cancel).not.toHaveBeenCalled();
});
