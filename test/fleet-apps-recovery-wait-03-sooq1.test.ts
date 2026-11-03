import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';
import { cmdFleetAppsRecoveryWait } from '../src/cli/fleet-apps-recovery-wait.js';

const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'recovery-wait-')); roots.push(root);
  let sequence = 0;
  const append = (invocationId: string, healthy: boolean | 'terminal') => {
    const state = [{ app: 'Phantom', observedRunning: healthy === true }];
    const common = { invocationId, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
    const body = healthy === 'terminal'
      ? { ...common, kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome: 'failed', cycles: 1, lastObservedState: state }
      : { ...common, kind: 'apps-watch.observation.v1', cycle: ++sequence, healthy, observedState: state };
    expect(appendBusInbox({ id: `fake-${++sequence}`, from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root }).status).toBe('posted');
  };
  return { root, append };
}
function harness(root: string, onSleep?: (n: number) => void) {
  let time = 0, output = '', reads = 0;
  const sleeps: number[] = [];
  const args = ['--invocation', id, '--max-age-ms', '60000', '--duration-ms', '250', '--interval-ms', '100', '--root', root, '--json'];
  const deps = { now: () => time, wallNow: () => Date.now(), reader: (dir: string) => { reads++; return readAppsRecoveryInvocations(dir); },
    sleep: async (ms: number) => { sleeps.push(ms); time += ms; onSleep?.(sleeps.length); }, emit: (line: string) => { output = line; } };
  return { args, deps, sleeps, result: () => JSON.parse(output), reads: () => reads };
}

it('waits through unhealthy retained history for fresh healthy evidence', async () => {
  const f = fixture(); f.append(id, false);
  const h = harness(f.root, () => f.append(id, true));
  expect(await cmdFleetAppsRecoveryWait(h.args, h.deps)).toBe(0);
  expect(h.result()).toMatchObject({ outcome: 'healthy', invocationId: id, elapsedMs: 100, verdict: { verdict: 'healthy' } });
});
it('does not accept another invocation and clamps the final sleep', async () => {
  const f = fixture(); f.append(other, true);
  const h = harness(f.root);
  expect(await cmdFleetAppsRecoveryWait(h.args, h.deps)).toBe(1);
  expect(h.sleeps).toEqual([100, 100, 50]);
  expect(h.result()).toMatchObject({ outcome: 'timeout', verdict: { verdict: 'unknown' } });
});
it('allows a missing invocation to appear and stops on terminal evidence', async () => {
  const f = fixture(); const h = harness(f.root, () => f.append(id, 'terminal'));
  expect(await cmdFleetAppsRecoveryWait(h.args, h.deps)).toBe(1);
  expect(h.result()).toMatchObject({ outcome: 'terminal', elapsedMs: 100, verdict: { verdict: 'terminal' } });
});
it('times out on stale and truncated projections', async () => {
  const f = fixture(); f.append(id, true);
  for (const truncated of [false, true]) {
    const h = harness(f.root);
    const reader = h.deps.reader;
    const deps = { ...h.deps, wallNow: () => Date.now() + 120000, reader: (dir: string) => ({ ...reader(dir), truncated }) };
    expect(await cmdFleetAppsRecoveryWait(h.args, deps)).toBe(1);
    expect(h.result()).toMatchObject({ outcome: 'timeout', verdict: { verdict: truncated ? 'unknown' : 'stale' } });
  }
});
it('rejects bad arguments and pre-cancellation without reading', async () => {
  const f = fixture(); const h = harness(f.root); vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const args of [[], [...h.args, '--json'], [...h.args, '--unknown'], h.args.slice(0, -1).concat('--interval-ms'), h.args.map(x => x === '250' ? '1e3' : x), h.args.map(x => x === '100' ? '99' : x)]) {
    expect(await cmdFleetAppsRecoveryWait(args, h.deps)).toBe(2);
  }
  const controller = new AbortController(); controller.abort();
  expect(await cmdFleetAppsRecoveryWait(h.args, { ...h.deps, signal: controller.signal })).toBe(1);
  expect(h.reads()).toBe(0);
  expect(h.result()).toMatchObject({ outcome: 'cancelled', verdict: null });
});
it('sanitizes reader exceptions', async () => {
  const f = fixture(); const h = harness(f.root);
  expect(await cmdFleetAppsRecoveryWait(h.args, { ...h.deps, reader: () => { throw new Error('private path'); } })).toBe(1);
  expect(h.result()).toMatchObject({ outcome: 'unavailable', message: 'Recovery evidence unavailable', verdict: null });
  expect(JSON.stringify(h.result())).not.toContain('private path');
});
