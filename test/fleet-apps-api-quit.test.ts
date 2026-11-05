import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps/action';
const out = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' });
const stopped = out({ ok: true, code: 'stopped' });
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
const quit = { app: 'Cursor', action: 'quit' };

describe('fleet apps quit action', () => {
  it('accepts quit, reports the script code and uses exact argv', async () => {
    const exec = vi.fn().mockResolvedValue(stopped);
    const res = await call(make(exec), quit);
    expect(res).toEqual({ status: 202, body: { ...quit, code: 'stopped', at: new Date(0).toISOString() } });
    expect(exec).toHaveBeenCalledExactlyOnceWith('python3', ['-I', '/fake/script', 'quit', 'Cursor', '--output-dir', '/fake/runs'],
      expect.objectContaining({ timeout: 30_000 }));
  });

  it('refuses to quit Phantom without ever running the script', async () => {
    const exec = vi.fn();
    const api = make(exec);
    const refused = { status: 400, body: { code: 'VERSE_INVALID', error: 'Phantom cannot quit itself from here' } };
    expect(await call(api, { app: 'Phantom', action: 'quit' })).toEqual(refused);
    expect(await call(api, { app: 'Phantom', action: 'quit', waitRunningMs: 5000 })).toEqual(refused);
    expect(exec).not.toHaveBeenCalled();
  });

  it.each([['not_running', 'app is not running'], ['quit_timeout', 'app did not quit in time']] as const)(
    'maps the script %s refusal to 422', async (code, error) => {
      const exec = vi.fn().mockResolvedValue(out({ ok: false, code }));
      expect(await call(make(exec), quit)).toEqual({ status: 422, body: { code, error } });
    });

  it('keeps every gate ahead of the action', async () => {
    const exec = vi.fn().mockResolvedValue(stopped);
    const api = make(exec);
    expect((await call(api, quit, { token: '' })).status).toBe(401);
    expect((await call(api, quit, { allowDispatch: false })).status).toBe(404);
    expect((await call(api, quit, { address: '192.0.2.1' })).status).toBe(403);
    expect((await call(api, quit, { channel: 'mobile' })).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });

  it('confirms the stopped state with observe-only status probes', async () => {
    const exec = vi.fn().mockResolvedValueOnce(stopped).mockResolvedValueOnce(status(true)).mockResolvedValueOnce(status(false));
    const res = await call(make(exec), { ...quit, waitRunningMs: 5000 });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ ...quit, code: 'stopped',
      confirmation: { target: 'stopped', outcome: 'reached', attempts: 2, running: false, confirmed: true } });
    expect(verbs(exec)).toEqual(['quit', 'status', 'status']);
  });

  it('reports timeout while the app stays running and never sends a second quit', async () => {
    const exec = vi.fn().mockImplementation(async (_f, argv: string[]) => (argv[2] === 'quit' ? stopped : status(true)));
    const res = await call(make(exec), { ...quit, waitRunningMs: 60 });
    expect(res.status).toBe(202);
    expect(res.body.confirmation).toMatchObject({ target: 'stopped', outcome: 'timeout', running: true, confirmed: false });
    expect(verbs(exec).filter(v => v === 'quit')).toHaveLength(1);
  });
});
