import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi, FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
const PATH = '/api/verse/fleet/apps';
async function call(api: ApiModule, body?: unknown, address = '127.0.0.1', token = 'test', channel = '') {
  const req = Object.assign(new PassThrough(), {
    headers: { 'x-ashlr-token': token, 'content-type': 'application/json', 'x-ashlr-channel': channel },
    socket: { remoteAddress: address },
  }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const pending = api({ allowDispatch: true, token: 'test' } as VerseApiContext, req, res, body === undefined ? PATH : `${PATH}/action`, body === undefined ? 'GET' : 'POST');
  (req as unknown as PassThrough).end(body === undefined ? '' : JSON.stringify(body));
  await pending;
  return { status, body: JSON.parse(text) };
}
function setup() {
  let time = 100_000;
  const exec = vi.fn(async () => ({ stdout: JSON.stringify({ running: true, code: 'launch_requested' }), stderr: 'never echo' }));
  const api = createFleetAppsApi({ exec, locateScript: () => '/script', runsDir: '/root', now: () => time });
  return { api, exec, advance: () => { time += 30_000; } };
}
describe('fleet apps console API', () => {
  it('returns fixed shape and exact argv, caches concurrent polls for 30 seconds', async () => {
    const { api, exec, advance } = setup();
    const [first, second] = await Promise.all([call(api), call(api)]);
    expect(first).toEqual(second);
    expect(first).toEqual({ status: 200, body: { v: 1, available: true, generatedAt: new Date(100_000).toISOString(), apps: FLEET_APPS.map(app => ({ app, running: true, checkedAt: new Date(100_000).toISOString() })) } });
    expect(exec).toHaveBeenCalledTimes(8);
    expect(exec).toHaveBeenNthCalledWith(1, 'python3', ['-I', '/script', 'status', 'Phantom', '--output-dir', '/root'], expect.objectContaining({ timeout: expect.any(Number) }));
    await call(api); expect(exec).toHaveBeenCalledTimes(8);
    advance(); await call(api); expect(exec).toHaveBeenCalledTimes(16);
  });
  it('keeps unreadable and timed out status unknown', async () => {
    const exec = vi.fn().mockRejectedValueOnce({ killed: true }).mockResolvedValue({ stdout: 'bad json', stderr: 'private' });
    const result = await call(createFleetAppsApi({ exec, locateScript: () => '/script' }));
    expect(result.body.apps.every((row: { running: unknown }) => row.running === null)).toBe(true);
  });
  it('reports a missing script without executing', async () => {
    const exec = vi.fn(); const api = createFleetAppsApi({ exec, locateScript: () => null });
    expect(await call(api)).toMatchObject({ status: 200, body: { available: false, apps: [] } });
    expect((await call(api, { app: 'Codex', action: 'launch' })).status).toBe(503);
    expect(exec).not.toHaveBeenCalled();
  });
  it('accepts actions with exact argv and clears cached status', async () => {
    const { api, exec } = setup(); await call(api);
    expect(await call(api, { app: 'Codex', action: 'launch' })).toEqual({ status: 202, body: { app: 'Codex', action: 'launch', code: 'launch_requested', at: new Date(100_000).toISOString() } });
    expect(exec).toHaveBeenLastCalledWith('python3', ['-I', '/script', 'launch', 'Codex', '--output-dir', '/root'], expect.objectContaining({ timeout: 30_000 }));
    await call(api); expect(exec).toHaveBeenCalledTimes(17);
  });
  it.each([{ app: 'Codex', action: 'quit' }, { app: 'unknown', action: 'launch' }, { app: 'Codex', action: 'launch', extra: true }])('rejects bad input %j', async body => {
    const { api, exec } = setup(); expect((await call(api, body)).status).toBe(400); expect(exec).not.toHaveBeenCalled();
  });
  it('requires token and local desktop origin', async () => {
    const { api, exec } = setup(); const body = { app: 'Codex', action: 'launch' };
    expect((await call(api, body, '127.0.0.1', '')).status).toBe(401);
    expect((await call(api, body, '192.0.2.1')).status).toBe(403);
    expect((await call(api, body, '127.0.0.1', 'test', 'mobile')).status).toBe(403);
    expect(exec).not.toHaveBeenCalled();
  });
});
