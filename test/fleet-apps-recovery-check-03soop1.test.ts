import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';
import { appsRecoveryVerdict } from '../src/core/fleet/apps-recovery-verdict.js';
import { cmdFleetAppsRecoveryCheck } from '../src/cli/fleet-apps-recovery-check.js';

const id = '12345678-1234-4123-8123-123456789abc';
const other = '12345678-1234-4123-8123-123456789abd';
const roots: string[] = [];
function root() { const dir = mkdtempSync(join(tmpdir(), 'verdict-')); roots.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const row = { invocationId: id, latestCursor: 1, latestTime: 1000, observedApps: ['Phantom'],
  retainedObservedState: [{ app: 'Phantom', observedRunning: true }], retainedDiagnostics: null,
  retainedHealthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, terminalOutcome: null };
const projection: ReturnType<typeof readAppsRecoveryInvocations> = { v: 1, availability: 'available', truncated: false, scanCursor: 1, scannedEvents: 1, invocations: [row] };
const verdict = (p = projection, now = 1100) => appsRecoveryVerdict(p, id, 100, now).verdict;

it('uses freshness and treats incomplete or contradictory evidence conservatively', () => {
  expect(verdict()).toBe('healthy');
  expect(verdict(projection, 1101)).toBe('stale');
  for (const latestTime of [NaN, Infinity, 1101, -1]) expect(verdict({ ...projection, invocations: [{ ...row, latestTime }] })).toBe('unknown');
  expect(appsRecoveryVerdict(projection, other, 100, 1100).verdict).toBe('unknown');
  expect(verdict({ ...projection, availability: 'unavailable' })).toBe('unknown');
  expect(verdict({ ...projection, truncated: true })).toBe('unknown');
  expect(verdict({ ...projection, invocations: [{ ...row, retainedHealthy: false, retainedObservedState: [{ app: 'Phantom', observedRunning: false }] }] })).toBe('unhealthy');
  expect(verdict({ ...projection, invocations: [{ ...row, retainedHealthy: false, retainedObservedState: [{ app: 'Phantom', observedRunning: null }] }] })).toBe('unhealthy');
  expect(verdict({ ...projection, invocations: [{ ...row, retainedObservedState: [] }] })).toBe('unknown');
  expect(verdict({ ...projection, invocations: [{ ...row, retainedDiagnostics: [{ app: 'Phantom', outcome: 'unknown' }] }] })).toBe('unknown');
  expect(verdict({ ...projection, invocations: [{ ...row, terminalOutcome: 'failed' }] }, 99999)).toBe('terminal');
});

it('reads isolated real bus evidence and validates arguments before reading', async () => {
  const dir = root(), empty = root();
  const append = (n: number, body: object) => expect(appendBusInbox({ id: `fake-${n}`, from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root: dir }).status).toBe('posted');
  const counts = { invocationId: id, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
  append(1, { ...counts, kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, observedState: row.retainedObservedState });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const args = ['--invocation', id, '--max-age-ms', '60000', '--root', dir, '--json'];
  expect(await cmdFleetAppsRecoveryCheck(args)).toBe(0);
  expect(JSON.parse(String(log.mock.lastCall![0]))).toMatchObject({ v: 1, invocationId: id, verdict: 'healthy', latestCursor: 1, terminalOutcome: null, truncated: false });
  expect(await cmdFleetAppsRecoveryCheck(['--invocation', id, '--max-age-ms', '1', '--root', empty])).toBe(1);
  expect(JSON.parse(String(log.mock.lastCall![0])).verdict).toBe('unknown');
  append(2, { ...counts, kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome: 'completed', cycles: 1, lastObservedState: row.retainedObservedState });
  expect(await cmdFleetAppsRecoveryCheck(args)).toBe(1);
  expect(JSON.parse(String(log.mock.lastCall![0]))).toMatchObject({ verdict: 'terminal', terminalOutcome: 'completed', latestCursor: 2 });
  for (const invalid of [[], ['--invocation', id], ['--max-age-ms', '1'], ['--invocation', other.replace('4123', '1123'), '--max-age-ms', '1'], ['--invocation', id, '--max-age-ms', '1e3'], ['--invocation', id, '--max-age-ms', '0'], [...args, '--json'], [...args, '--unknown']]) {
    expect(await cmdFleetAppsRecoveryCheck(invalid)).toBe(2);
  }
});
