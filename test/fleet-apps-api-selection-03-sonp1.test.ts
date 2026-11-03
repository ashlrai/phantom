import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FleetAppExec } from '../src/cli/fleet-app.js';
import { createFleetAppsApi, FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const PATH = '/api/verse/fleet/apps';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function call(api: ApiModule, query = '', action?: object) {
  const req = Object.assign(new PassThrough(), {
    url: PATH + query, headers: { 'x-ashlr-token': 'test', 'content-type': 'application/json' },
    socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const pending = api({ allowDispatch: true, token: 'test' } as VerseApiContext, req, res, action ? `${PATH}/action` : PATH, action ? 'POST' : 'GET');
  (req as unknown as PassThrough).end(action ? JSON.stringify(action) : '');
  await pending;
  return { status, body: JSON.parse(text) as { apps: Array<{ app: string; running: boolean | null }> } };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-select-')); dirs.push(dir);
  let holdStatus = false, holdAction = false;
  const held: Array<() => void> = [];
  const exec = vi.fn<FleetAppExec>((_file, argv) => {
    const action = argv[2];
    const result = { stdout: JSON.stringify(action === 'status' ? { ok: true, running: true } : { ok: true, code: 'accepted' }), stderr: '' };
    return (action === 'status' ? holdStatus : holdAction) ? new Promise(resolve => held.push(() => resolve(result))) : Promise.resolve(result);
  });
  const locate = vi.fn(() => '/script');
  return { api: createFleetAppsApi({ exec, locateScript: locate, runsDir: dir }), exec, locate,
    holdStatus: (value: boolean) => { holdStatus = value; }, holdAction: (value: boolean) => { holdAction = value; },
    release: () => { held.splice(0).forEach(resolve => resolve()); } };
}
const names = (result: Awaited<ReturnType<typeof call>>) => result.body.apps.map(row => row.app);
const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

describe('fleet apps API selection', () => {
  it('defaults to eight probes and canonical rows', async () => {
    const { api, exec } = setup();
    expect(names(await call(api))).toEqual([...FLEET_APPS]);
    expect(exec).toHaveBeenCalledTimes(8);
  });
  it('shares pending and cached canonical selections, including duplicates', async () => {
    const { api, exec, holdStatus, release } = setup(); holdStatus(true);
    const first = call(api, '?app=Cursor&app=Phantom&app=Cursor');
    const second = call(api, '?app=Phantom&app=Cursor');
    await flush(); expect(exec).toHaveBeenCalledTimes(2);
    holdStatus(false); release();
    expect(names(await first)).toEqual(['Phantom', 'Cursor']);
    expect(names(await second)).toEqual(['Phantom', 'Cursor']);
    await call(api, '?app=Cursor&app=Phantom');
    expect(exec).toHaveBeenCalledTimes(2);
    expect(exec.mock.calls.map(call => call[1][3])).toEqual(['Phantom', 'Cursor']);
  });
  it.each(['?app=', '?app=unknown', '?app=Phantom&app=unknown'])('rejects invalid selection %s before lookup', async query => {
    const { api, exec, locate } = setup();
    expect(await call(api, query)).toEqual({ status: 400, body: { code: 'VERSE_INVALID', error: 'invalid app selection' } });
    expect(exec).not.toHaveBeenCalled(); expect(locate).not.toHaveBeenCalled();
  });
  it('isolates overlapping and completed subset and full inventories', async () => {
    const { api, exec, holdStatus, release } = setup(); holdStatus(true);
    const subset = call(api, '?app=Cursor'); const full = call(api);
    await flush(); expect(exec).toHaveBeenCalledTimes(3);
    holdStatus(false); release();
    expect(names(await subset)).toEqual(['Cursor']); expect(names(await full)).toEqual([...FLEET_APPS]);
    expect(exec).toHaveBeenCalledTimes(9);
    expect(names(await call(api))).toEqual([...FLEET_APPS]);
    expect(exec).toHaveBeenCalledTimes(9);
  });
  it('invalidates all selections and prevents stale pending work from caching across an action', async () => {
    const { api, exec, holdStatus, holdAction, release } = setup();
    await call(api); await call(api, '?app=Cursor');
    holdStatus(true);
    const stale = call(api, '?app=Phantom&app=Cursor'); await flush();
    holdAction(true);
    const action = call(api, '', { app: 'Codex', action: 'launch' }); await flush();
    const during = await call(api, '?app=Cursor');
    expect(during.body.apps.every(row => row.running === null)).toBe(true);
    holdStatus(false); holdAction(false); release();
    expect((await action).status).toBe(202);
    expect((await stale).body.apps.every(row => row.running === null)).toBe(true);
    const before = exec.mock.calls.length;
    await call(api, '?app=Phantom&app=Cursor'); await call(api, '?app=Cursor'); await call(api);
    expect(exec).toHaveBeenCalledTimes(before + 2 + 1 + 8);
  });
});
