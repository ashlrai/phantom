import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsRecoveryWait } from '../src/cli/fleet-apps-recovery-wait.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';

const id = '12345678-1234-4123-8123-123456789abc';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(healthy = false) {
  const root = mkdtempSync(join(tmpdir(), 'recovery-stop-')); roots.push(root);
  const stop = join(root, 'stop');
  if (healthy) expect(appendBusInbox({ id: 'fake-1', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000,
    body: { kind: 'apps-watch.observation.v1', invocationId: id, cycle: 1, healthy: true, observedState: [{ app: 'Phantom', observedRunning: true }], recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 } }, { root }).status).toBe('posted');
  let time = 0, output = '', reads = 0;
  const sleeps: number[] = [];
  const args = ['--invocation', id, '--max-age-ms', '60000', '--duration-ms', '1000', '--interval-ms', '60000', '--root', root, '--stop-file', relative(process.cwd(), stop), '--json'];
  const deps = { now: () => time, wallNow: () => Date.now(), reader: (dir: string) => { reads++; return readAppsRecoveryInvocations(dir); },
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; }, emit: (line: string) => { output = line; } };
  return { root, stop, args, deps, sleeps, result: () => JSON.parse(output), reads: () => reads };
}
it('stops before reading retained healthy evidence', async () => {
  const f = fixture(true); writeFileSync(f.stop, 'private');
  expect(await cmdFleetAppsRecoveryWait(f.args, f.deps)).toBe(1);
  expect(f.reads()).toBe(0);
  expect(f.result()).toMatchObject({ outcome: 'stopped', invocationId: id, elapsedMs: 0, verdict: null });
  expect(JSON.stringify(f.result())).not.toContain('private');
});
it('detects a stop during a long polling interval and removes listeners', async () => {
  const f = fixture(); const before = process.listenerCount('SIGINT');
  const sleep = async (ms: number) => { await f.deps.sleep(ms); writeFileSync(f.stop, ''); };
  expect(await cmdFleetAppsRecoveryWait(f.args, { ...f.deps, sleep })).toBe(1);
  expect(f.sleeps).toEqual([250]);
  expect(f.result()).toMatchObject({ outcome: 'stopped', elapsedMs: 250, verdict: { verdict: 'unknown' } });
  expect(process.listenerCount('SIGINT')).toBe(before);
});
it('gives a stop created by the reader precedence over healthy evidence', async () => {
  const f = fixture(true);
  const reader = (root: string) => { const projection = f.deps.reader(root); writeFileSync(f.stop, ''); return projection; };
  expect(await cmdFleetAppsRecoveryWait(f.args, { ...f.deps, reader })).toBe(1);
  expect(f.result()).toMatchObject({ outcome: 'stopped', verdict: { verdict: 'healthy' } });
});
it('allows healthy completion when the stop file is missing', async () => {
  const f = fixture(true);
  expect(await cmdFleetAppsRecoveryWait(f.args, f.deps)).toBe(0);
  expect(f.result()).toMatchObject({ outcome: 'healthy' });
});
it('rejects malformed and duplicate flags before filesystem access', async () => {
  const f = fixture(); vi.spyOn(console, 'error').mockImplementation(() => {});
  const stat = vi.fn();
  for (const args of [[...f.args, '--stop-file', f.stop], [...f.args, '--unknown'], [...f.args, '--stop-file'], f.args.slice(0, -2).concat('--stop-file')]) {
    expect(await cmdFleetAppsRecoveryWait(args, { ...f.deps, stat })).toBe(2);
  }
  expect(stat).not.toHaveBeenCalled(); expect(f.reads()).toBe(0);
});
it('sanitizes stat errors and cleans up cancellation listeners', async () => {
  const f = fixture(); const before = process.listenerCount('SIGTERM');
  expect(await cmdFleetAppsRecoveryWait(f.args, { ...f.deps, stat: () => { throw new Error('private path'); } })).toBe(1);
  expect(f.result()).toMatchObject({ outcome: 'unavailable', verdict: null });
  expect(JSON.stringify(f.result())).not.toContain('private path');
  const controller = new AbortController();
  const sleep = async (ms: number) => { await f.deps.sleep(ms); controller.abort(); };
  expect(await cmdFleetAppsRecoveryWait(f.args, { ...f.deps, signal: controller.signal, sleep })).toBe(1);
  expect(f.result()).toMatchObject({ outcome: 'cancelled' });
  expect(process.listenerCount('SIGTERM')).toBe(before);
});
