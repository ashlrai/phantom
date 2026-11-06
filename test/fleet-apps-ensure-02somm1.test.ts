import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps/action';
const out = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: 'secret-stderr' });
const accepted = out({ ok: true, code: 'launch_requested' });
const status = (running: unknown, ok: unknown = true) => out({ ok, running });
const hang = () => new Promise<never>(() => {});
const later = <T>(ms: number, value: T) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));
const ensure = (app = 'Codex', extra: object = {}) => ({ app, action: 'ensure', ...extra });
const at = new Date(0).toISOString();

async function call(api: ApiModule, body: unknown, options: { token?: string; address?: string; channel?: string; allowDispatch?: boolean } = {}) {
  const req = Object.assign(new PassThrough(), {
    headers: { 'x-ashlr-token': options.token ?? 'test', 'content-type': 'application/json', 'x-ashlr-channel': options.channel ?? '' },
    socket: { remoteAddress: options.address ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
  let code = 0, text = '';
  const res = { writeHead(c: number) { code = c; return this; }, end(v: string) { text = v; } } as unknown as ServerResponse;
  const pending = api({ allowDispatch: options.allowDispatch ?? true, token: 'test' } as VerseApiContext, req, res, path, 'POST');
  (req as unknown as PassThrough).end(JSON.stringify(body));
  await pending;
  return { status: code, body: JSON.parse(text) };
}
const make = (exec: ReturnType<typeof vi.fn>) =>
  createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs', now: () => 0 });
/** Fake child: argv is ['-I', script, action, app, ...], so step receives (app, action). */
const scripted = (step: (app: string, action: string) => unknown) =>
  vi.fn(async (_file: string, argv: string[]) => step(argv[3]!, argv[2]!));
const verbs = (exec: ReturnType<typeof vi.fn>) => exec.mock.calls.map(c => (c[1] as string[])[2]);
const timeouts = (exec: ReturnType<typeof vi.fn>) => exec.mock.calls.map(c => (c[2] as { timeout: number }).timeout);

/** Advances fake time in small steps until the request settles; no wall-clock waits. */
async function drive<T>(pending: Promise<T>): Promise<T> {
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  for (let steps = 0; !settled; steps++) {
    if (steps > 4000) throw new Error('request never settled');
    await vi.advanceTimersByTimeAsync(50);
  }
  return pending;
}

describe('fleet app ensure', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('already running: status only, no launch, focus or restart', async () => {
    const exec = scripted(() => status(true));
    const res = await drive(call(make(exec), ensure()));
    expect(res).toEqual({ status: 200, body: { app: 'Codex', action: 'ensure', outcome: 'already_running', launchRequested: false, running: true, at } });
    expect(verbs(exec)).toEqual(['status']);
  });

  it('stopped: launches exactly once, then confirms running through sequential probes', async () => {
    const readings = [false, false, true];
    const exec = scripted((_app, action) => (action === 'launch' ? accepted : status(readings.length > 1 ? readings.shift() : readings[0])));
    const res = await drive(call(make(exec), ensure()));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ outcome: 'launched', launchRequested: true, running: true });
    expect(verbs(exec)).toEqual(['status', 'launch', 'status', 'status']);
    expect(JSON.stringify(res.body)).not.toMatch(/secret|\/Users\//);
  });

  it.each([
    ['not ok', () => status(true, false)],
    ['non-boolean running', () => status('yes')],
    ['malformed JSON', () => ({ stdout: 'not json', stderr: 'secret-stderr' })],
    ['child failure', () => Promise.reject(Object.assign(new Error('boom'), { stderr: 'secret-stderr' }))],
  ])('unknown initial status (%s) is unavailable and never launches', async (_label, probe: () => unknown) => {
    const exec = scripted(() => probe());
    const res = await drive(call(make(exec), ensure()));
    expect(res).toEqual({ status: 503, body: { app: 'Codex', action: 'ensure', outcome: 'unavailable', launchRequested: false, running: null, at, code: 'unavailable', error: 'fleet apps unavailable' } });
    expect(verbs(exec)).toEqual(['status']);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('a refused initial status is reported as a refusal and never launches', async () => {
    const exec = scripted(() => out({ ok: false, code: 'permission_denied', needs_mason_written: true }));
    const res = await drive(call(make(exec), ensure()));
    expect(res).toMatchObject({ status: 422, body: { outcome: 'unavailable', launchRequested: false, code: 'permission_denied', error: 'app control permission required', needsMason: true } });
    expect(verbs(exec)).toEqual(['status']);
  });

  it.each([
    ['refused', out({ ok: false, code: 'permission_denied', needs_mason_written: true }), 422],
    ['unavailable', out({ ok: false, code: 'unavailable' }), 503],
    ['malformed', { stdout: 'nope', stderr: 'secret-stderr' }, 503],
  ])('failed launch (%s) is reported and never retried', async (_label, launchResult, http) => {
    const exec = scripted((_app, action) => (action === 'launch' ? launchResult : status(false)));
    const res = await drive(call(make(exec), ensure()));
    expect(res.status).toBe(http);
    expect(res.body).toMatchObject({ outcome: 'unavailable', launchRequested: true, running: false });
    expect(verbs(exec)).toEqual(['status', 'launch']);
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('a hanging initial status exhausts the budget at 30 s without launching', async () => {
    const exec = scripted(() => hang());
    const start = Date.now();
    const res = await drive(call(make(exec), ensure()));
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ outcome: 'unavailable', launchRequested: false });
    expect(Date.now() - start).toBeLessThanOrEqual(30_000);
    expect(verbs(exec)).toEqual(['status']);
  });

  it('a hanging launch ends as an unconfirmed timeout inside the one budget', async () => {
    const exec = scripted((_app, action) => (action === 'launch' ? hang() : status(false)));
    const start = Date.now();
    const res = await drive(call(make(exec), ensure()));
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ outcome: 'timeout', launchRequested: true, running: false, code: 'VERSE_ENSURE_TIMEOUT' });
    expect(Date.now() - start).toBeLessThanOrEqual(30_000);
    expect(verbs(exec)).toEqual(['status', 'launch']);
  });

  it('confirmation gets only what the launch left of the single 30 s budget', async () => {
    let statuses = 0;
    const exec = scripted((_app, action) => {
      if (action === 'launch') return later(20_000, accepted);
      return statuses++ === 0 ? status(false) : hang();
    });
    const start = Date.now();
    const res = await drive(call(make(exec), ensure()));
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ outcome: 'timeout', launchRequested: true });
    expect(verbs(exec)).toEqual(['status', 'launch', 'status']);
    expect(timeouts(exec)[2]).toBeLessThanOrEqual(10_000);
    expect(Date.now() - start).toBeLessThanOrEqual(30_000);
  });

  it('waitRunningMs caps the confirmation below the 30 s budget', async () => {
    const exec = scripted((_app, action) => (action === 'launch' ? accepted : status(false)));
    const start = Date.now();
    const res = await drive(call(make(exec), ensure('Codex', { waitRunningMs: 1000 })));
    expect(res.status).toBe(504);
    expect(res.body).toMatchObject({ outcome: 'timeout', launchRequested: true, running: false });
    expect(Date.now() - start).toBeLessThanOrEqual(1000);
    expect(verbs(exec).filter(v => v === 'launch')).toHaveLength(1);
  });

  it('a same-app action gets 409 for the whole ensure while other apps stay unaffected', async () => {
    let release!: (value: unknown) => void;
    const gate = new Promise(resolve => { release = resolve; });
    let codexStatus = 0;
    const exec = scripted((app, action) => {
      if (app === 'Claude') return status(true);
      if (action === 'launch') return accepted;
      return codexStatus++ === 0 ? status(false) : gate;
    });
    const api = make(exec);
    const first = call(api, ensure());
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(3)); // launch observed, confirmation probe waiting on the gate
    expect((await call(api, ensure())).status).toBe(409);
    expect((await call(api, { app: 'Codex', action: 'launch' })).status).toBe(409);
    expect((await call(api, { app: 'Codex', action: 'restart' })).status).toBe(409);
    expect((await call(api, ensure('Claude'))).body).toMatchObject({ outcome: 'already_running' });
    expect(exec).toHaveBeenCalledTimes(4);
    release(status(true));
    expect(await first).toMatchObject({ status: 200, body: { outcome: 'launched', running: true } });
    expect((await drive(call(api, ensure()))).body).toMatchObject({ outcome: 'already_running' });
  });

  it('invalidates the status snapshot cache once ensure finishes', async () => {
    const exec = scripted(() => status(true));
    const api = createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs', now: () => 0 });
    const get = async () => {
      let text = '';
      const res = { writeHead() { return this; }, end(v: string) { text = v; } } as unknown as ServerResponse;
      await api({ allowDispatch: true, token: 'test' } as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/apps', 'GET');
      return JSON.parse(text);
    };
    await get();
    const cachedCalls = exec.mock.calls.length;
    await get();
    expect(exec.mock.calls.length).toBe(cachedCalls); // served from cache
    await drive(call(api, ensure()));
    const afterEnsure = exec.mock.calls.length;
    await get();
    expect(exec.mock.calls.length).toBeGreaterThan(afterEnsure); // refetched
  });

  it('rejects unauthorized, remote, mobile, disabled and unknown-app requests with zero child calls', async () => {
    const exec = scripted(() => accepted);
    const api = make(exec);
    const body = ensure('Codex', { waitRunningMs: 100 });
    expect((await call(api, body, { token: '' })).status).toBe(401);
    expect((await call(api, body, { allowDispatch: false })).status).toBe(404);
    expect((await call(api, body, { address: '192.0.2.1' })).status).toBe(403);
    expect((await call(api, body, { channel: 'mobile' })).status).toBe(403);
    expect((await call(api, ensure('Nope'))).status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
  });
});
