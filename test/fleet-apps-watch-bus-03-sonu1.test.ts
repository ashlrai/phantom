import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetAppsWatch } from '../src/cli/fleet-apps-watch.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'watch-bus-')); roots.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const batch = (observedRunning: unknown, launched = false) => ({ code: observedRunning === true ? 0 : 1, stdout: JSON.stringify({ ok: observedRunning === true, secret: 'private-child-data', apps: [{ app: 'Phantom', observedRunning, launched, extra: 'private-child-data' }] }) });
const read = (dir: string) => {
  const page = listBusInboxAfter(0, 100, { root: dir });
  if (page.status !== 'ok') throw new Error(page.status);
  return page.messages.map(row => row.envelope);
};

it('publishes correlated, sanitized recovery and terminal events for distinct invocations', async () => {
  const dir = root();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (let i = 0; i < 2; i++) {
    let clock = 0;
    expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '100', '--root', dir, '--bus', '--json'], {
      runChild: async () => batch(true, true), now: () => clock, sleep: async ms => { clock += ms; },
    })).toBe(0);
  }
  const messages = read(dir);
  expect(messages).toHaveLength(4);
  expect(new Set(messages.map(m => m.id)).size).toBe(4);
  expect(messages[0]).toMatchObject({ to: 'leaders', priority: 'P2', body: { kind: 'apps-watch.observation.v1', healthy: true, recoveries: 1 } });
  expect(messages[1]).toMatchObject({ body: { kind: 'apps-watch.summary.v1', outcome: 'completed', cycles: 1 } });
  const bodies = messages.map(m => m.body as Record<string, unknown>);
  expect(bodies[0]!.invocationId).toBe(bodies[1]!.invocationId);
  expect(bodies[0]!.invocationId).not.toBe(bodies[2]!.invocationId);
  expect(JSON.stringify(messages)).not.toContain('private-child-data');
});

it('records failure and unknown readings separately', async () => {
  const dir = root();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '1000', '--root', dir, '--bus', '--json'], { runChild: async () => batch(null) })).toBe(1);
  expect(read(dir).map(m => m.body)).toMatchObject([
    { healthy: false, observedState: [{ app: 'Phantom', observedRunning: null }], totalFailedCycles: 1 },
    { outcome: 'failed', lastObservedState: [{ app: 'Phantom', observedRunning: null }] },
  ]);
});

it('reports failed publication without altering supervision', async () => {
  const dir = root();
  const badRoot = join(dir, 'file'); writeFileSync(badRoot, 'x');
  let output = '', clock = 0;
  vi.spyOn(process.stdout, 'write').mockImplementation(((text: string) => { output += text; return true; }) as never);
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '100', '--root', badRoot, '--bus', '--json'], { runChild: async () => batch(true), now: () => clock, sleep: async ms => { clock += ms; } })).toBe(0);
  const summary = JSON.parse(output);
  expect(summary).toMatchObject({ outcome: 'completed', bus: { published: 0, failed: summary.cycles + 1 } });
});

it('rejects invalid bus flags before child work and emits one summary on cancellation', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const runner = vi.fn(async () => batch(true));
  for (const args of [['--bus', '--bus'], ['--bus=true']]) {
    expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '100', ...args], { runChild: runner })).toBe(2);
  }
  expect(runner).not.toHaveBeenCalled();
  const dir = root(), controller = new AbortController(); controller.abort();
  expect(await cmdFleetAppsWatch(['Phantom', '--duration-ms', '100', '--root', dir, '--bus'], { runChild: runner, signal: controller.signal })).toBe(1);
  expect(read(dir).map(m => m.body)).toMatchObject([{ kind: 'apps-watch.summary.v1', outcome: 'cancelled' }]);
});
