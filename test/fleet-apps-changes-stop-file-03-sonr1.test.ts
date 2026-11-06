import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppsChanges, type FleetAppsChangesDeps } from '../src/cli/fleet-apps-changes.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'apps-changes-'));
  dirs.push(dir);
  return join(dir, 'stop');
}
const stamp = '2026-11-01T00:00:00.000Z';
const stdout = JSON.stringify({ v: 1, available: true, generatedAt: stamp, apps: FLEET_APPS.map(app => ({ app, running: true, checkedAt: stamp })) });
async function capture(path: string, deps: FleetAppsChangesDeps) {
  const events: Record<string, unknown>[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { events.push(JSON.parse(String(chunk)) as Record<string, unknown>); return true; });
  const code = await cmdFleetAppsChanges(['--duration-ms', '1000', '--interval-ms', '500', '--stop-file', relative(process.cwd(), path), '--jsonl'], deps);
  return { code, events };
}
function summary(events: Record<string, unknown>[], outcome: string, samples: number) {
  expect(events.filter(event => event.type === 'summary')).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({ type: 'summary', outcome, samples });
}
describe('apps-changes stop file', () => {
  it('stops before spawning when the file exists', async () => {
    const path = await setup(); await writeFile(path, '');
    const runChild = vi.fn();
    const result = await capture(path, { runChild });
    expect(result.code).toBe(1); expect(runChild).not.toHaveBeenCalled(); summary(result.events, 'cancelled', 0);
  });
  it('aborts a pending child and emits nothing after the summary', async () => {
    const path = await setup(); let signal: AbortSignal | undefined;
    const result = await capture(path, { runChild: async (_args, options) => {
      signal = options.signal; await writeFile(path, ''); return new Promise(() => {});
    } });
    expect(signal?.aborted).toBe(true); summary(result.events, 'cancelled', 0);
    const count = result.events.length; await new Promise(resolve => setTimeout(resolve, 120)); expect(result.events).toHaveLength(count);
  });
  it('aborts an interval sleep', async () => {
    const path = await setup(); let signal: AbortSignal | undefined;
    const result = await capture(path, { runChild: async () => ({ code: 0, stdout }), sleep: async (_ms, s) => {
      signal = s; await writeFile(path, ''); return new Promise(() => {});
    } });
    expect(signal?.aborted).toBe(true); summary(result.events, 'cancelled', 1);
  });
  it('continues when absent and preserves external cancellation', async () => {
    const path = await setup(); const controller = new AbortController(); let calls = 0;
    const result = await capture(path, { signal: controller.signal, runChild: async () => { calls++; return { code: 0, stdout }; }, sleep: async () => { controller.abort(); } });
    expect(calls).toBe(1); summary(result.events, 'cancelled', 1);
  });
  it('reports inaccessible paths as unavailable without spawning', async () => {
    const path = await setup(); await writeFile(path, ''); const runChild = vi.fn();
    const result = await capture(join(path, 'child'), { runChild });
    expect(runChild).not.toHaveBeenCalled(); summary(result.events, 'unavailable', 0);
  });
});
