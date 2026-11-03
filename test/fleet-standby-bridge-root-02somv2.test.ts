import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetStandby, findStandbyReadinessScript, type FleetStandbyExec } from '../src/cli/fleet-standby.js';
import { cmdFleetStandbyAwait } from '../src/cli/fleet-standby-await.js';
import { createFleetStandbyApi } from '../src/core/verse/fleet-standby-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

vi.mock('../src/core/fleet/bridge-install.js', () => ({ findBridgeSource: vi.fn() }));
import { findBridgeSource } from '../src/core/fleet/bridge-install.js';

let temp: string;
let selected: string;
let defaultRoot: string;
let source: string;
const script = (root: string) => join(root, 'mac-bridge', 'current', 'standby_readiness.py');
const config = { v: 1, db: 'fake-db', snapshotStore: 'fake-store', primary: 'fake-primary', role: 'worker', host: 'fake-standby' };
const report = { version: 1, ready: true, blockers: [], wouldLoseSec: null, leaseHolder: null, snapshotAgeSec: null };

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'standby-bridge-root-'));
  selected = join(temp, 'selected');
  defaultRoot = join(temp, 'default');
  source = join(temp, 'source');
  for (const root of [selected, defaultRoot]) {
    await mkdir(join(root, 'mac-bridge', 'current'), { recursive: true });
    await writeFile(script(root), 'fake');
    await writeFile(join(root, 'standby.json'), JSON.stringify(config));
  }
  await mkdir(source);
  await writeFile(join(source, 'standby_readiness.py'), 'fake source');
  vi.mocked(findBridgeSource).mockResolvedValue(source);
  vi.stubEnv('ASHLR_RUNS_DIR', defaultRoot);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(temp, { recursive: true, force: true });
});

function executor() {
  return vi.fn<FleetStandbyExec>(async () => ({ stdout: JSON.stringify(report), stderr: '' }));
}
async function callApi(deps: Parameters<typeof createFleetStandbyApi>[0]) {
  let body = '';
  const res = { writeHead() { return this; }, end(value: string) { body = value; } } as unknown as ServerResponse;
  await createFleetStandbyApi(deps)({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/standby', 'GET');
  return JSON.parse(body) as Record<string, unknown>;
}

it('prefers an explicit root, then the environment root', async () => {
  expect(await findStandbyReadinessScript(selected)).toBe(script(selected));
  expect(await findStandbyReadinessScript()).toBe(script(defaultRoot));
  expect(findBridgeSource).not.toHaveBeenCalled();
});

it('uses checkout fallback when the selected release is missing, never the default release', async () => {
  await rm(script(selected));
  expect(await findStandbyReadinessScript(selected)).toBe(join(source, 'standby_readiness.py'));
  const exec = executor();
  expect(await cmdFleetStandby([], { runsDir: selected, exec })).toBe(0);
  expect(exec.mock.calls[0]?.[1][1]).toBe(join(source, 'standby_readiness.py'));
});

it('uses the configured root for standby, await, and the API', async () => {
  const exec = executor();
  expect(await cmdFleetStandby([], { runsDir: selected, exec })).toBe(0);
  expect(await cmdFleetStandbyAwait(['--timeout-ms', '1000'], { runsDir: selected, exec })).toBe(0);
  expect(await callApi({ runsDir: selected, exec })).toMatchObject({ configured: true, available: true });
  expect(exec.mock.calls.map(call => call[1][1])).toEqual([script(selected), script(selected), script(selected)]);
});

it('preserves zero-argument injected locators for all callers', async () => {
  const exec = executor();
  const locateScript = vi.fn(() => 'injected-script');
  expect(await cmdFleetStandby([], { runsDir: selected, exec, locateScript })).toBe(0);
  expect(await cmdFleetStandbyAwait(['--timeout-ms', '1000'], { runsDir: selected, exec, locateScript })).toBe(0);
  expect(await callApi({ runsDir: selected, exec, locateScript })).toMatchObject({ available: true });
  expect(locateScript.mock.calls).toEqual([[], [], []]);
  expect(exec.mock.calls.map(call => call[1][1])).toEqual(['injected-script', 'injected-script', 'injected-script']);
});
