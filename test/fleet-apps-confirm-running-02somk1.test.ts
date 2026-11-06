import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps/action';
const out = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' });
const accepted = out({ ok: true, code: 'launch_requested' });
const status = (running: unknown, ok: unknown = true) => out({ ok, running });
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
const verbs = (exec: ReturnType<typeof vi.fn>) => exec.mock.calls.map(c => (c[1] as string[])[2]);
const launch = { app: 'Codex', action: 'launch' };

describe('fleet app action running confirmation', () => {
  it('confirms running after stopped probes, launching exactly once', async () => {
    const exec = vi.fn().mockResolvedValueOnce(accepted).mockResolvedValueOnce(status(false)).mockResolvedValueOnce(status(true));
    const res = await call(make(exec), { ...launch, waitRunningMs: 5000 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ app: 'Codex', action: 'launch', code: 'launch_requested',
      confirmation: { target: 'running', outcome: 'reached', attempts: 2, running: true, confirmed: true } });
    expect(verbs(exec)).toEqual(['launch', 'status', 'status']);
    const timeouts = exec.mock.calls.map(c => (c[2] as { timeout: number }).timeout);
    expect(timeouts[0]).toBeLessThanOrEqual(30_000);
    expect(timeouts[1]).toBeLessThanOrEqual(5000);
  });

  it('keeps the no-wait response shape unchanged', async () => {
    const exec = vi.fn().mockResolvedValue(accepted);
    const res = await call(make(exec), launch);
    expect(res).toEqual({ status: 202, body: { ...launch, code: 'launch_requested', at: new Date(0).toISOString() } });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('reports timeout when the app stays stopped, never as recovered', async () => {
    const exec = vi.fn().mockImplementation(async (_f, argv: string[]) => (argv[2] === 'launch' ? accepted : status(false)));
    const res = await call(make(exec), { ...launch, waitRunningMs: 50 });
    expect(res.status).toBe(202);
    expect(res.body.code).toBe('launch_requested');
    expect(res.body.confirmation).toMatchObject({ outcome: 'timeout', running: false, confirmed: false });
    expect(verbs(exec).filter(v => v === 'launch')).toHaveLength(1);
  });

  it.each([
    ['not ok', status(true, false)],
    ['non-boolean running', status('yes')],
    ['malformed JSON', { stdout: 'bad', stderr: 'secret-stderr' }],
  ])('never confirms on an unknown probe (%s) and leaks nothing', async (_label, probe) => {
    const exec = vi.fn().mockImplementation(async (_f, argv: string[]) => (argv[2] === 'launch' ? accepted : probe));
    const res = await call(make(exec), { ...launch, waitRunningMs: 40 });
    expect(res.body.confirmation).toMatchObject({ outcome: 'unavailable', running: null, confirmed: false });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('treats a throwing probe as unknown without echoing child content', async () => {
    const exec = vi.fn().mockImplementation(async (_f, argv: string[]) => {
      if (argv[2] !== 'status') return accepted;
      throw Object.assign(new Error('boom secret-stderr'), { stderr: 'secret-stderr' });
    });
    const res = await call(make(exec), { app: 'Codex', action: 'restart', waitRunningMs: 40 });
    expect(res.body.confirmation).toMatchObject({ outcome: 'unavailable', confirmed: false });
    expect(JSON.stringify(res.body)).not.toContain('secret');
  });

  it('never polls after a refusal, unavailable result or failure', async () => {
    for (const result of [out({ ok: false, code: 'permission_denied' }), out({ ok: false, code: 'unavailable' }), out({ code: 'x' })]) {
      const exec = vi.fn().mockResolvedValue(result);
      const res = await call(make(exec), { ...launch, waitRunningMs: 1000 });
      expect(res.status).toBeGreaterThanOrEqual(422);
      expect(res.body.confirmation).toBeUndefined();
      expect(exec).toHaveBeenCalledTimes(1);
    }
    const exec = vi.fn().mockRejectedValue(new Error('stderr: secret'));
    const res = await call(make(exec), { ...launch, waitRunningMs: 1000 });
    expect(res).toEqual({ status: 503, body: { code: 'unavailable', error: 'fleet apps unavailable' } });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('stays busy for the same app through confirmation, then releases', async () => {
    let release!: (v: typeof accepted) => void;
    const gate = new Promise<typeof accepted>(r => { release = r; });
    const exec = vi.fn().mockResolvedValueOnce(accepted).mockReturnValueOnce(gate).mockResolvedValue(status(true));
    const api = make(exec);
    const first = call(api, { ...launch, waitRunningMs: 5000 });
    await vi.waitFor(() => expect(exec).toHaveBeenCalledTimes(2)); // action done, probe in flight
    expect((await call(api, launch)).status).toBe(409);
    expect((await call(api, { ...launch, waitRunningMs: 10 })).status).toBe(409);
    expect(exec).toHaveBeenCalledTimes(2);
    release(status(true));
    expect((await first).body.confirmation.confirmed).toBe(true);
    exec.mockResolvedValueOnce(accepted);
    expect((await call(api, launch)).status).toBe(202);
  });

  it('invalidates the status snapshot cache once the operation finishes', async () => {
    const exec = vi.fn().mockImplementation(async (_f, argv: string[]) => (argv[2] === 'launch' ? accepted : status(true)));
    const api = createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs', now: () => 0 });
    const get = async () => {
      let text = '';
      const res = { writeHead() { return this; }, end(v: string) { text = v; } } as unknown as ServerResponse;
      await api({ allowDispatch: true, token: 'test' } as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/apps', 'GET');
      return JSON.parse(text);
    };
    await get();
    const before = exec.mock.calls.length;
    await get();
    expect(exec.mock.calls.length).toBe(before); // cached
    await call(api, { ...launch, waitRunningMs: 1000 });
    const mid = exec.mock.calls.length;
    await get();
    expect(exec.mock.calls.length).toBeGreaterThan(mid); // refetched
  });

  it.each([
    ['zero', 0], ['negative', -5], ['fraction', 1.5], ['too large', 30_001], ['string', '100'], ['null', null], ['NaN-like', 'x'],
  ])('rejects invalid waitRunningMs (%s) before running anything', async (_label, waitRunningMs) => {
    const exec = vi.fn().mockResolvedValue(accepted);
    const res = await call(make(exec), { ...launch, waitRunningMs });
    expect(res).toEqual({ status: 400, body: { code: 'VERSE_INVALID', error: 'invalid app action' } });
    expect(exec).not.toHaveBeenCalled();
  });

  it('rejects wait on focus and accepts the 30000 maximum', async () => {
    const exec = vi.fn().mockResolvedValue(status(true));
    expect((await call(make(exec), { app: 'Codex', action: 'focus', waitRunningMs: 100 })).status).toBe(400);
    expect(exec).not.toHaveBeenCalled();
    exec.mockResolvedValueOnce(accepted);
    expect((await call(make(exec), { ...launch, waitRunningMs: 30_000 })).body.confirmation.confirmed).toBe(true);
  });

  it('never starts or polls for unauthorized, remote, mobile or disabled requests', async () => {
    const exec = vi.fn().mockResolvedValue(accepted);
    const api = make(exec);
    const body = { ...launch, waitRunningMs: 100 };
    expect((await call(api, body, { token: '' })).status).toBe(401);
    expect((await call(api, body, { allowDispatch: false })).status).toBe(404);
    expect((await call(api, body, { address: '192.0.2.1' })).status).toBe(403);
    expect((await call(api, body, { channel: 'mobile' })).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });
});
