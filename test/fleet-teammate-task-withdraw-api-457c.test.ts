import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createFleetTeammateTaskWithdrawApi, VERSE_FLEET_TEAMMATE_TASK_WITHDRAW_PATH as PATH } from '../src/core/verse/fleet-teammate-task-withdraw-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

type Result = { state: string; reason?: unknown; task?: unknown; token?: string };
async function call(cancel: ReturnType<typeof vi.fn>, method: string, body?: unknown, opts: { token?: string; allowDispatch?: boolean; url?: string } = {}) {
  const url = opts.url ?? PATH;
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': opts.token ?? 'fixture-token' } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const headers: Record<string, string> = {};
  const res = {
    setHeader(k: string, v: string) { headers[k] = v; },
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch: opts.allowDispatch ?? true } as VerseApiContext;
  const handled = await createFleetTeammateTaskWithdrawApi(cancel as never)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, headers, raw: payload, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}
const cancelled = () => vi.fn(async (): Promise<Result> => ({ state: 'cancelled' }));
const ok = { jobId: 'RQ-FAKE-1' };

it('ignores other paths', async () => {
  expect((await call(cancelled(), 'POST', ok, { url: '/api/verse/fleet/control/holds' })).handled).toBe(false);
});
it('404 when dispatch is off, 401 without the mutation token, 405 for GET', async () => {
  const cancel = cancelled();
  expect((await call(cancel, 'POST', ok, { allowDispatch: false })).status).toBe(404);
  expect((await call(cancel, 'POST', ok, { token: '' })).status).toBe(401);
  const get = await call(cancel, 'GET');
  expect(get.status).toBe(405);
  expect(get.headers.Allow).toBe('POST');
  expect(cancel).not.toHaveBeenCalled();
});
it('400 for extra keys, bad ids and non-object bodies', async () => {
  const cancel = cancelled();
  for (const bad of [{}, { jobId: 'RQ-FAKE-1', extra: 1 }, { jobId: '../x' }, { jobId: '-lead' }, { jobId: 'a'.repeat(81) }, { jobId: 7 }, [ok], 'str']) {
    expect((await call(cancel, 'POST', bad)).status).toBe(400);
  }
  expect(cancel).not.toHaveBeenCalled();
});
it('200 cancelled: projection only, cancel called once with apply true', async () => {
  const cancel = vi.fn(async (): Promise<Result> => ({ state: 'cancelled', task: { claimKey: 'k' }, token: 't' }));
  const r = await call(cancel, 'POST', ok);
  expect(r.status).toBe(200);
  expect(r.body).toEqual({ v: 1, jobId: 'RQ-FAKE-1', state: 'cancelled' });
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(cancel).toHaveBeenCalledWith('RQ-FAKE-1', { apply: true });
});
it('200 refused uses a closed reason and never echoes caller text', async () => {
  const secret = `Already sent ${'x'.repeat(500)}`;
  const cancel = vi.fn(async (): Promise<Result> => ({ state: 'refused', reason: secret, task: {} }));
  const r = await call(cancel, 'POST', ok);
  expect(r.status).toBe(200);
  expect(Object.keys(r.body!).sort()).toEqual(['jobId', 'reason', 'state', 'v']);
  expect(r.body!.reason).toBe('Teammate task withdrawal refused');
  expect(r.raw).not.toContain('Already sent');
});
it('409 busy and 503 unavailable without leaking the message', async () => {
  const busy = await call(vi.fn(async () => { throw new Error('Teammate tasks busy'); }), 'POST', ok);
  expect(busy).toMatchObject({ status: 409, body: { code: 'busy' } });
  const down = await call(vi.fn(async () => { throw new Error('secret /Users/x/path detail'); }), 'POST', ok);
  expect(down.status).toBe(503);
  expect(down.body).toEqual({ code: 'unavailable', error: 'teammate task withdraw unavailable' });
  expect(down.raw).not.toMatch(/secret|Users/);
});
it('a concurrent second request gets 409', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const cancel = vi.fn(async (): Promise<Result> => { await gate; return { state: 'cancelled' }; });
  const first = call(cancel, 'POST', ok);
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect((await call(cancel, 'POST', ok)).status).toBe(409);
  release();
  expect((await first).status).toBe(200);
  expect(cancel).toHaveBeenCalledTimes(1);
});
