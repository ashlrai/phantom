import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FleetStandbyExec } from '../src/cli/fleet-standby.js';
import { createFleetStandbyApi } from '../src/core/verse/fleet-standby-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
let runsDir: string;
const config = { v: 1, db: '/fake-private/lease.sqlite', snapshotStore: '/fake-private/snapshots', primary: 'primary-fake', role: 'worker-fake', host: 'standby-fake', maxAgeSec: 300 };
const report = { ready: true, blockers: [], leaseHolder: 'primary-fake', snapshotAgeSec: 240 };
beforeEach(async () => { runsDir = await mkdtemp(join(tmpdir(), 'standby-api-')); });
afterEach(async () => { await rm(runsDir, { recursive: true, force: true }); });
async function call(api: ApiModule, method = 'GET', path = '/api/verse/fleet/standby') {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  expect(text).not.toContain(config.db);
  return { handled, status, body: text ? JSON.parse(text) : null };
}
async function setup(value: unknown = config, result: unknown = report) {
  await writeFile(join(runsDir, 'standby.json'), JSON.stringify(value));
  const exec = vi.fn<FleetStandbyExec>(async () => ({ stdout: JSON.stringify(result), stderr: 'fake private diagnostics' }));
  let time = 100_000;
  const api = createFleetStandbyApi({ runsDir, exec, locateScript: () => '/fake-script', now: () => time });
  return { api, exec, advance() { time += 30_000; } };
}
it('reports absent config without executing', async () => {
  const exec = vi.fn();
  expect(await call(createFleetStandbyApi({ runsDir, exec }))).toMatchObject({ status: 200, body: { configured: false } });
  expect(exec).not.toHaveBeenCalled();
});
it.each([{ ...config, host: 'bad host' }, { ...config, role: '../bad' }, { ...config, maxAgeSec: 1 }])('rejects invalid config %j', async value => {
  const { api, exec } = await setup(value);
  expect((await call(api)).body.configured).toBe(false);
  expect(exec).not.toHaveBeenCalled();
});
it('projects readiness with bounded execution and a 30 second cache', async () => {
  const { api, exec, advance } = await setup();
  const [first, second] = await Promise.all([call(api), call(api)]);
  expect(first).toEqual(second);
  expect(first.body).toEqual({ v: 1, generatedAt: new Date(100_000).toISOString(), configured: true, available: true, ready: true, blocker: null, leaseHolder: 'primary-fake', snapshotAgeSec: 240 });
  expect(exec).toHaveBeenCalledTimes(1);
  expect(exec).toHaveBeenCalledWith('python3', ['-B', '/fake-script', '--db', config.db, '--snapshot-store', config.snapshotStore, '--primary', config.primary, '--role', config.role, '--host', config.host, '--max-age', '300'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024, windowsHide: true });
  advance(); await call(api); expect(exec).toHaveBeenCalledTimes(2);
});
it('projects the first blocker', async () => {
  const { api } = await setup(config, { ...report, ready: false, blockers: ['snapshot-stale'] });
  expect((await call(api)).body).toMatchObject({ ready: false, blocker: 'snapshot-stale' });
});
it('hides execution failures and stderr', async () => {
  const { api, exec } = await setup(); exec.mockRejectedValue(new Error(config.db));
  expect((await call(api)).body).toMatchObject({ configured: true, available: false });
});
it('handles missing scripts and unreadable reports', async () => {
  const { exec } = await setup(config, { ready: 'yes' });
  expect((await call(createFleetStandbyApi({ runsDir, exec, locateScript: () => null }))).body.available).toBe(false);
  expect(exec).not.toHaveBeenCalled();
  expect((await call(createFleetStandbyApi({ runsDir, exec, locateScript: () => '/fake' }))).body.available).toBe(false);
});
it('refuses POST and leaves other paths alone', async () => {
  const { api, exec } = await setup();
  expect((await call(api, 'POST')).status).toBe(405);
  expect((await call(api, 'GET', '/elsewhere')).handled).toBe(false);
  expect(exec).not.toHaveBeenCalled();
});
it('never returns path-bearing child fields', async () => {
  const { api } = await setup(config, { ...report, blockers: [config.db] });
  expect((await call(api)).body.available).toBe(false);
});
