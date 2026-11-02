import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps/action';
const ok = { stdout: JSON.stringify({ code: 'restart_requested' }), stderr: '' };
function deferred() {
  let resolve!: (value: typeof ok) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<typeof ok>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function call(api: ApiModule, body: unknown, options: { token?: string; address?: string; channel?: string; allowDispatch?: boolean } = {}) {
  const req = Object.assign(new PassThrough(), {
    headers: { 'x-ashlr-token': options.token ?? 'test', 'content-type': 'application/json', 'x-ashlr-channel': options.channel ?? '' },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const pending = api({ allowDispatch: options.allowDispatch ?? true, token: 'test' } as VerseApiContext, req, res, path, 'POST');
  (req as unknown as PassThrough).end(JSON.stringify(body));
  await pending;
  return { status, body: JSON.parse(text) };
}
const restart = { app: 'Codex', action: 'restart' };

describe('fleet app action reservations', () => {
  it('rejects same-app actions while allowing another app and releases after success', async () => {
    const first = deferred();
    const exec = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok);
    const api = createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs', now: () => 0 });
    const pending = call(api, restart);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    expect(await call(api, restart)).toEqual({ status: 409, body: { code: 'VERSE_APP_BUSY', error: 'app action in progress' } });
    expect((await call(api, { app: 'Codex', action: 'focus' })).status).toBe(409);
    expect((await call(api, { app: 'Cursor', action: 'launch' })).status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(2);
    first.resolve(ok);
    expect(await pending).toEqual({ status: 202, body: { ...restart, code: 'restart_requested', at: new Date(0).toISOString() } });
    expect((await call(api, restart)).status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('does not reserve for rejected requests and keeps gates ahead of busy responses', async () => {
    const first = deferred();
    const exec = vi.fn().mockReturnValue(first.promise);
    const api = createFleetAppsApi({ exec, locateScript: () => '/fake/script' });
    expect((await call(api, restart, { token: '' })).status).toBe(401);
    expect((await call(api, restart, { allowDispatch: false })).status).toBe(404);
    expect((await call(api, restart, { address: '192.0.2.1' })).status).toBe(403);
    expect((await call(api, restart, { channel: 'mobile' })).status).toBe(403);
    expect((await call(api, { ...restart, extra: true })).status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
    const pending = call(api, restart);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    expect((await call(api, restart, { token: '' })).status).toBe(401);
    expect((await call(api, { ...restart, action: 'quit' })).status).toBe(400);
    first.resolve(ok);
    expect((await pending).status).toBe(202);
  });

  it.each([
    ['refusal', { code: 1, stdout: JSON.stringify({ code: 'refused' }) }, 202],
    ['malformed JSON', { code: 1, stdout: 'bad json' }, 503],
    ['malformed result', { code: 1, stdout: '{}' }, 503],
    ['exception', new Error('unavailable'), 503],
  ])('releases after %s', async (_label, failure, status) => {
    const first = deferred();
    const exec = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(ok);
    const api = createFleetAppsApi({ exec, locateScript: () => '/fake/script' });
    const pending = call(api, restart);
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(1));
    first.reject(failure);
    expect((await pending).status).toBe(status);
    expect((await call(api, restart)).status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});
