import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { FleetAppExec } from '../src/cli/fleet-app.js';
import { createFleetAppsApi, FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/fleet/apps';
const SCRIPT = '/script';
const ROOT = '/root';
const START = 100_000;

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
  return { status, body: JSON.parse(text) as { apps: Array<{ app: string; running: boolean | null }> } & Record<string, unknown> };
}

/** Lets settled promises and the probe workers run; uses no fake timers and no real wait. */
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/**
 * Fake desktop host. Status replies reflect `running` at call time, so a probe held open across an action
 * carries the pre-action truth. `hold(true)` keeps every exec pending until `release()`.
 */
function fakeHost() {
  const running = new Map<string, boolean | undefined>(FLEET_APPS.map(app => [app, false]));
  const held: Array<() => void> = [];
  let holding = false;
  let actionReport: Record<string, unknown> = { ok: true, code: 'launch_requested' };
  const exec = vi.fn<FleetAppExec>((_file, argv) => {
    const [action, app] = [argv[2]!, argv[3]!];
    const report = action === 'status' ? { ok: true, code: 'ok', running: running.get(app) } : actionReport;
    const result = { stdout: JSON.stringify(report), stderr: 'never echo' };
    if (!holding) return Promise.resolve(result);
    return new Promise(resolve => held.push(() => resolve(result)));
  });
  return {
    exec,
    running,
    hold(on: boolean) { holding = on; },
    release() { held.splice(0).forEach(settle => settle()); },
    setActionReport(report: Record<string, unknown>) { actionReport = report; },
  };
}

function setup() {
  let time = START;
  const host = fakeHost();
  const api = createFleetAppsApi({ exec: host.exec, locateScript: () => SCRIPT, runsDir: ROOT, now: () => time });
  return { api, ...host, advance: (ms: number) => { time += ms; } };
}

const runningOf = (body: { apps: Array<{ app: string; running: boolean | null }> }, app: string) =>
  body.apps.find(row => row.app === app)?.running;

describe('fleet apps inventory generations', () => {
  it('shares one pending inventory across polls with two probes in flight and no TTL on sharing', async () => {
    const { api, exec, hold, release, advance } = setup();
    hold(true);
    const polls = [call(api), call(api), call(api)];
    await flush();
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec).toHaveBeenNthCalledWith(1, 'python3', ['-I', SCRIPT, 'status', 'Phantom', '--output-dir', ROOT], expect.objectContaining({ timeout: expect.any(Number) }));
    expect(exec).toHaveBeenNthCalledWith(2, 'python3', ['-I', SCRIPT, 'status', 'Codex', '--output-dir', ROOT], expect.objectContaining({ timeout: expect.any(Number) }));
    advance(60_000);
    polls.push(call(api));
    await flush();
    expect(exec).toHaveBeenCalledTimes(2);
    hold(false);
    release();
    const results = await Promise.all(polls);
    expect(results.every(result => result.status === 200)).toBe(true);
    expect(new Set(results.map(result => JSON.stringify(result.body))).size).toBe(1);
    expect(results[0]!.body.apps.map(row => row.app)).toEqual([...FLEET_APPS]);
    expect(exec).toHaveBeenCalledTimes(8);
    await call(api);
    expect(exec).toHaveBeenCalledTimes(8);
  });

  it('counts the 30 s settled TTL from completion rather than from snapshot start', async () => {
    const { api, exec, hold, release, advance } = setup();
    hold(true);
    const poll = call(api);
    await flush();
    advance(25_000);
    hold(false);
    release();
    await poll;
    expect(exec).toHaveBeenCalledTimes(8);
    advance(20_000);
    await call(api);
    expect(exec).toHaveBeenCalledTimes(8);
    advance(10_000);
    await call(api);
    expect(exec).toHaveBeenCalledTimes(16);
  });

  it('a successful action invalidates the settled inventory so the next poll observes fresh state', async () => {
    const { api, exec, running } = setup();
    const before = await call(api);
    expect(runningOf(before.body, 'Codex')).toBe(false);
    running.set('Codex', true);
    expect((await call(api, { app: 'Codex', action: 'launch' })).status).toBe(202);
    const after = await call(api);
    expect(runningOf(after.body, 'Codex')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(8 + 1 + 8);
  });

  it('a pre-action inventory resolving after the action neither overwrites nor populates the cache', async () => {
    const { api, exec, running, hold, release } = setup();
    running.set('Phantom', true);
    hold(true);
    const pre = call(api);
    await flush();
    expect(exec).toHaveBeenCalledTimes(2);
    hold(false);
    running.set('Phantom', false);
    expect((await call(api, { app: 'Codex', action: 'launch' })).status).toBe(202);
    release();
    const stale = await pre;
    expect(stale.status).toBe(200);
    expect(runningOf(stale.body, 'Phantom')).toBeNull();
    expect(exec).toHaveBeenCalledTimes(3);
    const fresh = await call(api);
    expect(runningOf(fresh.body, 'Phantom')).toBe(false);
    expect(exec).toHaveBeenCalledTimes(3 + 8);
  });

  it('a poll during an action answers unknown without probing and caches nothing', async () => {
    const { api, exec, hold, release } = setup();
    hold(true);
    const action = call(api, { app: 'Codex', action: 'launch' });
    await flush();
    expect(exec).toHaveBeenCalledTimes(1);
    const during = await call(api);
    expect(during.status).toBe(200);
    expect(during.body.apps.every(row => row.running === null)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    hold(false);
    release();
    expect((await action).status).toBe(202);
    await call(api);
    expect(exec).toHaveBeenCalledTimes(1 + 8);
  });

  it('a refused action also invalidates the settled inventory', async () => {
    const { api, exec, running, setActionReport } = setup();
    await call(api);
    setActionReport({ ok: false, code: 'permission_denied', needs_mason_written: true });
    expect(await call(api, { app: 'Codex', action: 'focus' })).toMatchObject({ status: 422, body: { code: 'permission_denied', needsMason: true } });
    running.set('Codex', true);
    expect(runningOf((await call(api)).body, 'Codex')).toBe(true);
    expect(exec).toHaveBeenCalledTimes(8 + 1 + 8);
  });

  it('keeps a row unknown, never stopped, when its post-action reading is unreadable', async () => {
    const { api, running } = setup();
    await call(api);
    running.set('Codex', undefined);
    expect(await call(api, { app: 'Codex', action: 'launch' })).toMatchObject({ status: 202 });
    const body = (await call(api)).body;
    expect(runningOf(body, 'Codex')).toBeNull();
    expect(runningOf(body, 'Phantom')).toBe(false);
  });

  it('unauthorized and mobile mutations never execute and leave the settled inventory valid', async () => {
    const { api, exec } = setup();
    await call(api);
    const body = { app: 'Codex', action: 'launch' };
    expect((await call(api, body, '127.0.0.1', '')).status).toBe(401);
    expect((await call(api, body, '192.0.2.1')).status).toBe(403);
    expect((await call(api, body, '127.0.0.1', 'test', 'mobile')).status).toBe(403);
    expect(exec).toHaveBeenCalledTimes(8);
    await call(api);
    expect(exec).toHaveBeenCalledTimes(8);
  });
});
