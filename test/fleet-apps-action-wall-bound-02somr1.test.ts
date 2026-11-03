import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/fleet/apps';
const actionPath = `${PATH}/action`;
const ok = (extra?: Record<string, unknown>) =>
  ({ stdout: JSON.stringify({ ok: true, code: 'launch_requested', ...extra }), stderr: 'never-echo' });
const refusal = (code: string, extra?: Record<string, unknown>) =>
  ({ stdout: JSON.stringify({ ok: false, code, ...extra }), stderr: 'refusal-stderr' });
const hang = () => new Promise<Record<string, unknown>>(() => {});

/* ---------- helper: build a POST /action request ---------- */
async function call(
  api: ApiModule,
  body: Record<string, unknown>,
  options: { token?: string; address?: string; channel?: string; allowDispatch?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = Object.assign(new PassThrough(), {
    headers: {
      'x-ashlr-token': options.token ?? 'test',
      'content-type': 'application/json',
      'x-ashlr-channel': options.channel ?? '',
    },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
  let code = 0, text = '';
  const res = {
    writeHead(c: number) { code = c; return this; },
    end(v: string) { text = v; },
  } as unknown as ServerResponse;
  const pending = api(
    { allowDispatch: options.allowDispatch ?? true, token: 'test' } as VerseApiContext,
    req, res, actionPath, 'POST',
  );
  (req as unknown as PassThrough).end(JSON.stringify(body));
  await pending;
  return { status: code, body: JSON.parse(text) };
}

function makeApi(exec: ReturnType<typeof vi.fn>) {
  return createFleetAppsApi({
    exec,
    locateScript: () => '/fake/script',
    runsDir: '/fake/runs',
    now: () => 0,
  });
}

/* ---------- helpers for deferred / never-settling exec ---------- */
function deferredExec<T>(settled?: T) {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/* ---------- drive: advance fake timers until settled ---------- */
async function drive<T>(p: Promise<T>, timeout = 50_000): Promise<T> {
  const end = Date.now() + timeout;
  let settled = false;
  p.finally(() => { settled = true; });
  for (let steps = 0; !settled && Date.now() < end; steps++) {
    if (steps > 2000) throw new Error('request never settled');
    await vi.advanceTimersByTimeAsync(50);
  }
  return p;
}
/* ------------------------------------------------------------------ */

describe('fleet-apps action wall-bound (RQ-PHX-APPACTIONWALLBOUND02SOMR1)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a never-settling action returns a 504 timeout within the budget', async () => {
    const exec = vi.fn(async () => hang() as Record<string, unknown>);
    const api = makeApi(exec);
    const res = await drive(call(api, { app: 'Codex', action: 'restart' }));
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      app: 'Codex',
      action: 'restart',
      outcome: 'timeout',
      code: 'VERSE_ACTION_TIMEOUT',
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('a never-settling action frees the app for a subsequent action', async () => {
    const { promise, resolve } = deferredExec<Record<string, unknown>>(ok());
    const exec = vi.fn(async () => promise);
    const api = makeApi(exec);
    // Call the API (exec fires synchronously), then advance fake time so
    // the bounded 30 s timeout fires.
    const pending = call(api, { app: 'Codex', action: 'restart' });
    await vi.advanceTimersByTimeAsync(30_100);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({
      outcome: 'timeout',
      code: 'VERSE_ACTION_TIMEOUT',
    });
    expect(exec).toHaveBeenCalledTimes(1);
    // After timeout the app is no longer inFlight; a fresh action is admitted
    resolve(ok());
    const res2 = await call(api, { app: 'Codex', action: 'launch' });
    expect(res2.status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('late resolution of the action promise does not send a second response', async () => {
    const { promise, resolve, reject } = deferredExec<Record<string, unknown>>(ok());
    const exec = vi.fn(async () => promise);
    const api = makeApi(exec);
    // Call the API (exec fires synchronously), then advance past the 30 s
    // bounded window. The timeout fires first and returns 504.
    const pending = call(api, { app: 'Codex', action: 'launch' });
    await vi.advanceTimersByTimeAsync(35_000);
    resolve(ok()); // resolves late (bounded already returned undefined)
    reject(new Error('late')); // also rejects late (no-op, already resolved by timeout)
    const res = await pending;
    // Exactly one response: the bounded timeout (504), not the late 202
    expect(res.status).toBe(504);
  });

  it('after a timeout, a second action for the same app is admitted', async () => {
    // The inner action never settles. We advance 30 s so the bounded
    // action times out — the finally block clears inFlight.
    const { promise, resolve } = deferredExec<Record<string, unknown>>(ok());
    const exec = vi.fn(async () => promise);
    const api = makeApi(exec);
    const pending = call(api, { app: 'Codex', action: 'restart' });
    await vi.advanceTimersByTimeAsync(30_100);
    const res = await pending;
    expect(res.status).toBe(504);
    expect(exec).toHaveBeenCalledTimes(1);
    // Now make a second call — the app is no longer inFlight
    resolve(ok());
    const res2 = await call(api, { app: 'Codex', action: 'launch' });
    expect(res2.status).toBe(202);
  });

  it('successful 202 path remains compatible', async () => {
    const exec = vi.fn(async () => ok());
    const api = makeApi(exec);
    const res = await call(api, { app: 'Codex', action: 'launch' });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ app: 'Codex', action: 'launch', code: 'launch_requested' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('known refusal paths remain compatible (422)', async () => {
    const exec = vi.fn(async () => refusal('permission_denied'));
    const api = makeApi(exec);
    const res = await call(api, { app: 'Codex', action: 'focus' });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: 'permission_denied' });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('the action (restart/launch/focus) is called exactly once on success', async () => {
    const exec = vi.fn(async () => ok());
    const api = makeApi(exec);
    for (const action of ['launch', 'restart', 'focus'] as const) {
      const res = await call(api, { app: 'Codex', action });
      expect(res.status).toBe(202);
      expect(exec).toHaveBeenCalledTimes(1);
      exec.mockClear();
    }
  });

  it('child diagnostics (stderr / paths) do not leak into responses', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ ok: true, code: 'launch_requested' }),
      stderr: 'secret-exec-path:/Users/mason/secret',
    }));
    const api = makeApi(exec);
    const res = await call(api, { app: 'Codex', action: 'launch' });
    expect(res.status).toBe(202);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/secret|\/Users\//);
  });
});

/* ---------- focus is unaffected by wall-bound ---------- */
describe('focus boundary', () => {
  it('focus is unaffected by wall-bound (no confirmation, 202 immediately)', async () => {
    const exec = vi.fn(async () => ok());
    const api = makeApi(exec);
    const res = await call(api, { app: 'Codex', action: 'focus' });
    expect(res.status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
