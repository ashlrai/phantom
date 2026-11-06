import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { FleetStandbyExec } from '../src/cli/fleet-standby.js';
import { createFleetStandbyApi } from '../src/core/verse/fleet-standby-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const BUDGET = 30_000;
const CACHE_TTL = 30_000;
const config = { v: 1, db: '/fake-private/lease.sqlite', snapshotStore: '/fake-private/snapshots', primary: 'primary-fake', role: 'worker-fake', host: 'standby-fake', maxAgeSec: 300 };
const report = { ready: true, blockers: [], leaseHolder: 'primary-fake', snapshotAgeSec: 240 };
const never = () => new Promise<never>(() => {});
const unavailable = { v: 1, configured: true, available: false };
const ok = () => ({ stdout: JSON.stringify(report), stderr: 'fake private diagnostics' });
let runsDir: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  runsDir = await mkdtemp(join(tmpdir(), 'standby-read-bound-'));
  await writeFile(join(runsDir, 'standby.json'), JSON.stringify(config));
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(runsDir, { recursive: true, force: true });
});

async function call(api: ApiModule) {
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/standby', 'GET');
  expect(handled).toBe(true);
  expect(text).not.toContain(config.db);
  expect(text).not.toContain(config.snapshotStore);
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}

// Config read is real file I/O and finishes outside fake time, so each test waits for the lazy step it
// gates on to start before advancing the clock.
function gate() {
  let fire!: () => void;
  const reached = new Promise<void>(resolve => { fire = resolve; });
  return { reached, fire };
}

it('bounds a hung discovery and reports unavailable without starting a child', async () => {
  const started = gate();
  const exec = vi.fn<FleetStandbyExec>(async () => ok());
  const api = createFleetStandbyApi({ runsDir, exec, locateScript: () => { started.fire(); return never(); } });
  const pending = call(api);
  let settled = false;
  pending.then(() => { settled = true; });
  await started.reached;
  await vi.advanceTimersByTimeAsync(BUDGET - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ status: 200, body: unavailable });
  expect(exec).not.toHaveBeenCalled();
});

it('bounds a hung child and reports unavailable, never ready', async () => {
  const started = gate();
  const exec = vi.fn<FleetStandbyExec>(() => { started.fire(); return never(); });
  const api = createFleetStandbyApi({ runsDir, exec, locateScript: () => '/fake-script' });
  const pending = call(api);
  await started.reached;
  await vi.advanceTimersByTimeAsync(BUDGET);
  const response = await pending;
  expect(response.body).toEqual({ ...unavailable, generatedAt: new Date(0).toISOString() });
  expect(response.body).not.toHaveProperty('ready');
  expect(exec).toHaveBeenCalledTimes(1);
});

it('passes only the remaining budget to the child', async () => {
  const started = gate();
  const exec = vi.fn<FleetStandbyExec>(async () => ok());
  const locateScript = () => { started.fire(); return new Promise<string>(resolve => setTimeout(() => resolve('/fake-script'), 10_000)); };
  const api = createFleetStandbyApi({ runsDir, exec, locateScript });
  const pending = call(api);
  await started.reached;
  await vi.advanceTimersByTimeAsync(10_000);
  expect((await pending).body).toMatchObject({ available: true, ready: true });
  expect(exec.mock.calls[0]?.[2]).toMatchObject({ timeout: BUDGET - 10_000 });
});

it('launches no child when discovery resolves after expiry', async () => {
  const started = gate();
  let resolveScript!: (value: string) => void;
  const exec = vi.fn<FleetStandbyExec>(async () => ok());
  const api = createFleetStandbyApi({ runsDir, exec, locateScript: () => { started.fire(); return new Promise<string>(resolve => { resolveScript = resolve; }); } });
  const pending = call(api);
  await started.reached;
  await vi.advanceTimersByTimeAsync(BUDGET);
  expect((await pending).body).toMatchObject(unavailable);
  resolveScript('/fake-script');
  await vi.runAllTimersAsync();
  expect(exec).not.toHaveBeenCalled();
});

it('drops a late child result and consumes its late rejection', async () => {
  const started = gate();
  let rejectChild!: (error: Error) => void;
  const exec = vi.fn<FleetStandbyExec>(() => { started.fire(); return new Promise((_resolve, reject) => { rejectChild = reject; }); });
  const api = createFleetStandbyApi({ runsDir, exec, locateScript: () => '/fake-script' });
  const pending = call(api);
  await started.reached;
  await vi.advanceTimersByTimeAsync(BUDGET);
  expect((await pending).body).toMatchObject(unavailable);
  rejectChild(new Error(config.db));
  await vi.runAllTimersAsync();
  expect(exec).toHaveBeenCalledTimes(1);
});

it('keeps existing ready fields on a timely report', async () => {
  const api = createFleetStandbyApi({ runsDir, exec: vi.fn<FleetStandbyExec>(async () => ok()), locateScript: () => '/fake-script' });
  expect((await call(api)).body).toEqual({ v: 1, generatedAt: new Date(0).toISOString(), configured: true, available: true, ready: true, blocker: null, leaseHolder: 'primary-fake', snapshotAgeSec: 240 });
});

it('recovers after cache expiry once a probe succeeds', async () => {
  const started = gate();
  const exec = vi.fn<FleetStandbyExec>(async () => ok());
  let attempts = 0;
  const api = createFleetStandbyApi({ runsDir, exec, locateScript: () => { if (attempts++ === 0) { started.fire(); return never(); } return '/fake-script'; } });
  const first = call(api);
  await started.reached;
  await vi.advanceTimersByTimeAsync(BUDGET);
  expect((await first).body).toMatchObject(unavailable);
  await vi.advanceTimersByTimeAsync(CACHE_TTL);
  expect((await call(api)).body).toMatchObject({ available: true, ready: true });
  expect(exec).toHaveBeenCalledTimes(1);
});

it('shares one probe between simultaneous requests', async () => {
  const locateScript = vi.fn(() => '/fake-script');
  const exec = vi.fn<FleetStandbyExec>(async () => ok());
  const api = createFleetStandbyApi({ runsDir, exec, locateScript });
  const [first, second] = await Promise.all([call(api), call(api)]);
  expect(first).toEqual(second);
  expect(locateScript).toHaveBeenCalledTimes(1);
  expect(exec).toHaveBeenCalledTimes(1);
});
