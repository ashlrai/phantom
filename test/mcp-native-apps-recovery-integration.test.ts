import { registerFleetNativeTools } from '../src/core/mcp-native-fleet.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as config from '../src/core/config.js';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { waitAppsRecovery } from '../src/core/fleet/apps-recovery-wait.js';
import { callNativeTool } from '../src/core/mcp-native.js';

const id = '12345678-1234-4123-8123-123456789abc';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('uses the trusted configured root consistently for retained follow, history and check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-integration-')); roots.push(root);
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  expect(appendBusInbox({ id: 'malformed-1', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 60000, body: { invocationId: 1 } }, { root }).status).toBe('posted');
  const common = { invocationId: id, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
  const body = { ...common, kind: 'apps-watch.observation.v1', cycle: 1, healthy: true,
    observedState: [{ app: 'Phantom', observedRunning: true }] };
  expect(appendBusInbox({ id: 'retained-1', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 60000, body }, { root }).status).toBe('posted');
  const call = async (name: string, args: unknown) => {
    const result = await callNativeTool(name, args);
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content[0]!.text);
  };
  expect(await call('phantom_fleet_apps_history', { invocationId: id.toUpperCase() })).toMatchObject({ events: [{ invocationId: id, healthy: true }] });
  expect(await call('phantom_fleet_apps_recovery_check', { invocationId: id.toUpperCase(), maxAgeMs: 60000 })).toMatchObject({ verdict: 'healthy' });
  expect(await call('phantom_fleet_apps_follow', { durationMs: 1000, invocationId: id.toUpperCase(), maxEvents: 1 })).toMatchObject({
    events: [{ invocationId: id }], summary: { reason: 'event_limit', nextCursor: 2 }, exitCode: 0,
  });
});

it('sanitizes configuration failures for every new recovery tool', async () => {
  vi.spyOn(config, 'loadConfig').mockImplementation(() => { throw new Error('/private/config raw stderr'); });
  for (const [name, args] of [
    ['phantom_fleet_apps_history', {}],
    ['phantom_fleet_apps_follow', { durationMs: 1 }],
    ['phantom_fleet_apps_recovery_check', { invocationId: id, maxAgeMs: 1 }],
    ['phantom_fleet_apps_recovery_wait', { invocationId: id, maxAgeMs: 1, timeoutMs: 1 }],
    ['phantom_fleet_apps_recovery_batch', { invocationIds: [id], maxAgeMs: 1, durationMs: 1 }],
  ] as const) {
    const result = await callNativeTool(name, args);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'Fleet configuration unavailable' });
  }
});

it('does not return healthy after a synchronous evidence read crosses the wait deadline', async () => {
  let clock = 0;
  const result = await waitAppsRecovery({ root: '/fake/runs', invocation: id, maxAge: 1000, duration: 10, interval: 100 }, {
    now: () => clock, wallNow: () => 100,
    reader: () => {
      clock = 10;
      return { v: 1, availability: 'available', truncated: false, scanCursor: 1, scannedEvents: 1, invocations: [{
        invocationId: id, latestCursor: 1, latestTime: 100, observedApps: ['Phantom'],
        retainedObservedState: [{ app: 'Phantom', observedRunning: true }], retainedDiagnostics: null,
        retainedHealthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, terminalOutcome: null,
      }] };
    },
  });
  expect(result).toMatchObject({ outcome: 'timeout', elapsedMs: 10 });
});

it('groups mixed-case UUID observations into the latest retained verdict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-case-')); roots.push(root);
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  for (const [index, invocationId] of [id, id.toUpperCase()].entries()) {
    const body = { invocationId, kind: 'apps-watch.observation.v1', cycle: index + 1,
      recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, healthy: index === 1,
      observedState: [{ app: 'Phantom', observedRunning: index === 1 }] };
    expect(appendBusInbox({ id: `case-${index}`, from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 60000, body }, { root }).status).toBe('posted');
  }
  const { readAppsRecoveryInvocations } = await import('../src/core/fleet/apps-recovery-invocations.js');
  const projection = readAppsRecoveryInvocations(root);
  expect(projection.invocations).toHaveLength(1);
  expect(projection.invocations[0]).toMatchObject({ latestCursor: 2, retainedHealthy: true });
  const result = await callNativeTool('phantom_fleet_apps_recovery_check', { invocationId: id, maxAgeMs: 60000 });
  expect(JSON.parse(result.content[0]!.text)).toMatchObject({ verdict: 'healthy', latestCursor: 2 });
});

registerFleetNativeTools();
