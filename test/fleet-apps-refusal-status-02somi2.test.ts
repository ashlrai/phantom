import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps/action';
const at = new Date(0).toISOString();
const base = { action: 'launch', app: 'Codex' };
const out = (r: object) => ({ stdout: JSON.stringify({ ...base, ...r }), stderr: '' });
const exit1 = (r: object | string, extra: object = {}) =>
  Object.assign(new Error('Command failed: SECRET_ARGV'), { code: 1, stdout: typeof r === 'string' ? r : JSON.stringify({ ...base, ...r }), stderr: 'HOSTILE_STDERR', ...extra });

async function call(api: ReturnType<typeof createFleetAppsApi>, body: unknown = { app: 'Codex', action: 'launch' }, o: { token?: string; address?: string } = {}) {
  const req = Object.assign(new PassThrough(), {
    headers: { 'x-ashlr-token': o.token ?? 'test', 'content-type': 'application/json' },
    socket: { remoteAddress: o.address ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(c: number) { status = c; return this; }, end(v: string) { text = v; } } as unknown as ServerResponse;
  const pending = api({ allowDispatch: true, token: 'test' } as VerseApiContext, req, res, path, 'POST');
  (req as unknown as PassThrough).end(JSON.stringify(body));
  await pending;
  return { status, text, body: JSON.parse(text) };
}
const mk = (exec: ReturnType<typeof vi.fn>) => createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs', now: () => 0 });

describe('fleet app action refusal status', () => {
  it('returns 202 only for explicit ok:true', async () => {
    const api = mk(vi.fn().mockResolvedValue(out({ ok: true, code: 'launch_requested' })));
    expect(await call(api)).toMatchObject({ status: 202, body: { app: 'Codex', action: 'launch', code: 'launch_requested', at } });
  });

  it.each([
    ['permission_denied', { ok: false, code: 'permission_denied', needs_mason_written: true }, { code: 'permission_denied', error: 'app control permission required', needsMason: true }],
    ['permission_denied unwritten', { ok: false, code: 'permission_denied', needs_mason_written: false }, { code: 'permission_denied', error: 'app control permission required' }],
    ['quit_timeout', { ok: false, code: 'quit_timeout', needs_mason_written: true }, { code: 'quit_timeout', error: 'app did not quit in time' }],
    ['not_running', { ok: false, code: 'not_running' }, { code: 'not_running', error: 'app is not running' }],
  ])('maps %s to 422 via thrown exit', async (_n, result, expected) => {
    const exec = vi.fn().mockRejectedValue(exit1(result));
    const r = await call(mk(exec));
    expect(r.status).toBe(422);
    expect(r.body).toEqual(expected);
    expect(exec).toHaveBeenCalledTimes(1);
    expect(r.text).not.toMatch(/SECRET_ARGV|HOSTILE_STDERR|\/fake/);
  });

  it('maps unavailable to 503', async () => {
    const r = await call(mk(vi.fn().mockRejectedValue(exit1({ ok: false, code: 'unavailable' }))));
    expect(r).toMatchObject({ status: 503, body: { code: 'unavailable', error: 'fleet apps unavailable' } });
  });

  it.each([
    ['hostile code', exit1({ ok: false, code: '<script>HOSTILE_CODE /Users/x/secret' })],
    ['prototype key', exit1({ ok: false, code: 'toString' })],
    ['unknown code', exit1({ ok: false, code: 'something_else' })],
    ['missing ok', exit1({ code: 'permission_denied' })],
    ['ok string', { stdout: JSON.stringify({ ok: 'true', code: 'launch_requested' }) }],
    ['ok:false success code', exit1({ ok: false, code: 'launch_requested' })],
    ['ok:true no code', { stdout: JSON.stringify({ ok: true }) }],
    ['malformed json', exit1('HOSTILE_STDOUT not json')],
    ['non-object', { stdout: '[1]' }],
    ['killed', exit1({ ok: false, code: 'quit_timeout' }, { killed: true })],
    ['string exit code', exit1({ ok: false, code: 'quit_timeout' }, { code: 'ENOENT' })],
  ])('treats %s as generic unavailable', async (_n, outcome) => {
    const exec = vi.fn();
    if (outcome instanceof Error) exec.mockRejectedValue(outcome); else exec.mockResolvedValue(outcome);
    const r = await call(mk(exec));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ code: 'unavailable', error: 'fleet apps unavailable' });
    expect(r.text).not.toMatch(/HOSTILE|script|secret|SECRET/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('never exposes needsMason for other codes or non-true values', async () => {
    for (const result of [{ ok: false, code: 'quit_timeout', needs_mason_written: true }, { ok: false, code: 'permission_denied', needs_mason_written: 'true' }]) {
      const r = await call(mk(vi.fn().mockRejectedValue(exit1(result))));
      expect(r.body).not.toHaveProperty('needsMason');
    }
  });

  it('clears busy protection after a refusal so the next action proceeds once', async () => {
    const exec = vi.fn().mockRejectedValueOnce(exit1({ ok: false, code: 'quit_timeout' })).mockResolvedValue(out({ ok: true, code: 'launch_requested' }));
    const api = mk(exec);
    expect((await call(api, { app: 'Codex', action: 'restart' })).status).toBe(422);
    expect((await call(api, { app: 'Codex', action: 'launch' })).status).toBe(202);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('keeps gates ahead of execution', async () => {
    const exec = vi.fn();
    const api = mk(exec);
    expect((await call(api, undefined, { token: '' })).status).toBe(401);
    expect((await call(api, undefined, { address: '192.0.2.1' })).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });
});
