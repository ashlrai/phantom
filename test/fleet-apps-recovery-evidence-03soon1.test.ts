import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createAppsWatchPublisher } from '../src/core/fleet/apps-watch-bus.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';
import { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';
import { cmdFleetAppsRecoveryState } from '../src/cli/fleet-apps-recovery-state.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); });

it('projects latest validated evidence independently through the JSON command', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-evidence-')); roots.push(root);
  const a = createAppsWatchPublisher(root), b = createAppsWatchPublisher(root), c = createAppsWatchPublisher(root);
  const counts = { recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
  expect(a({ kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, ...counts,
    observedState: [{ app: 'Phantom', observedRunning: true }] })).toBe(true);
  expect(b({ kind: 'apps-watch.observation.v1', cycle: 1, healthy: false, ...counts,
    observedState: [{ app: 'Phantom', observedRunning: false }, { app: 'Cursor', observedRunning: true },
      { app: 'Claude', observedRunning: null }], diagnostics: [{ app: 'Phantom', outcome: 'unavailable' }] })).toBe(true);
  expect(c({ kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, ...counts,
    observedState: [{ app: 'Cursor', observedRunning: true }] })).toBe(true);
  expect(a({ kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome: 'completed', cycles: 1, ...counts,
    lastObservedState: [{ app: 'Phantom', observedRunning: false }], lastDiagnostics: [{ app: 'Phantom', outcome: 'timeout', reason: 'deadline' }] })).toBe(true);
  expect(c({ kind: 'apps-watch.summary.v1', apps: ['Cursor'], outcome: 'completed', cycles: 1, ...counts,
    lastObservedState: null, lastDiagnostics: null })).toBe(true);
  expect(appendBusInbox({ id: 'unrelated-evidence', from: 'fake', to: 'leaders', priority: 'P2', ttl: 60000,
    body: { text: 'unrelated private body' } }, { root }).status).toBe('posted');
  const events = readAppsRecoveryHistory(root, 0, 100).events;
  expect(events).toHaveLength(5);
  const result = readAppsRecoveryInvocations(root);
  expect(result).toMatchObject({ availability: 'available', truncated: false, scannedEvents: 5 });
  expect(result.invocations).toHaveLength(3);
  expect(result.invocations[0]).toMatchObject({ observedApps: ['Cursor'], terminalOutcome: 'completed',
    retainedObservedState: null, retainedDiagnostics: null, retainedHealthy: null });
  expect(result.invocations[1]).toMatchObject({ observedApps: ['Phantom'], terminalOutcome: 'completed',
    retainedObservedState: [{ app: 'Phantom', observedRunning: false }],
    retainedDiagnostics: [{ app: 'Phantom', outcome: 'timeout', reason: 'deadline' }], retainedHealthy: null });
  expect(result.invocations[2]).toMatchObject({ terminalOutcome: null, retainedHealthy: false,
    retainedObservedState: [{ app: 'Phantom', observedRunning: false }, { app: 'Cursor', observedRunning: true },
      { app: 'Claude', observedRunning: null }], retainedDiagnostics: [{ app: 'Phantom', outcome: 'unavailable' }] });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetAppsRecoveryState(['--root', root, '--json'])).toBe(0);
  const json = String(log.mock.calls[0]![0]);
  expect(JSON.parse(json)).toEqual(result);
  expect(json).not.toContain('unrelated private body');
});

it('reports absent diagnostics and an observation health claim', () => {
  const root = mkdtempSync(join(tmpdir(), 'fake-evidence-')); roots.push(root);
  const publish = createAppsWatchPublisher(root);
  expect(publish({ kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, recoveries: 0,
    consecutiveFailures: 0, totalFailedCycles: 0, observedState: [{ app: 'Cursor', observedRunning: true }] })).toBe(true);
  expect(readAppsRecoveryInvocations(root).invocations[0]).toMatchObject({ retainedHealthy: true, retainedDiagnostics: null });
});
