import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appsRecoveryIncident } from '../src/core/fleet/apps-recovery-glance.js';
import type { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';
import { createAppsWatchPublisher } from '../src/core/fleet/apps-watch-bus.js';
import { FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import { readOperatorGlance } from '../src/core/fleet/operator-glance-read.js';
import { formatOperatorGlance } from '../src/core/fleet/operator-glance.js';

type Projection = ReturnType<typeof readAppsRecoveryInvocations>;
const now = 4_000_000;
function projection(overrides: Partial<Projection['invocations'][number]> = {}): Projection {
  return { v: 1, availability: 'available', truncated: false, scanCursor: 1, scannedEvents: 1, invocations: [{
    invocationId: 'd1468686-cda2-4ca9-a075-5fab96d43657', latestCursor: 1, latestTime: now,
    observedApps: ['Phantom', 'Codex'], retainedObservedState: [{ app: 'Phantom', observedRunning: true }, { app: 'Codex', observedRunning: false }],
    retainedDiagnostics: null, retainedHealthy: false, recoveries: 0, consecutiveFailures: 3,
    totalFailedCycles: 3, terminalOutcome: null, ...overrides,
  }] };
}

describe('apps recovery incident', () => {
  it('names only down or unknown apps in a failed terminal invocation', () => {
    expect(appsRecoveryIncident(projection({ terminalOutcome: 'failed' }), now)).toBe('App recovery failed: Codex');
  });
  it('shows retry failures', () => {
    expect(appsRecoveryIncident(projection(), now)).toBe('App recovery retrying: Codex (3 failed)');
  });
  it('shows silent whole minutes', () => {
    expect(appsRecoveryIncident(projection({ latestTime: now - 31 * 60_000 - 1000 }), now)).toBe('App recovery silent for 31 min');
  });
  it.each(['completed', 'cancelled'] as const)('hides terminal %s', terminalOutcome => {
    expect(appsRecoveryIncident(projection({ terminalOutcome }), now)).toBeNull();
  });
  it('hides healthy, unknown, unavailable and empty projections', () => {
    expect(appsRecoveryIncident(projection({ retainedHealthy: true, retainedObservedState: [{ app: 'Codex', observedRunning: true }] }), now)).toBeNull();
    expect(appsRecoveryIncident(projection({ retainedHealthy: null }), now)).toBeNull();
    expect(appsRecoveryIncident({ ...projection(), availability: 'unavailable' }, now)).toBeNull();
    expect(appsRecoveryIncident({ ...projection(), invocations: [] }, now)).toBeNull();
  });
  it('falls back to observed apps then apps, caps names and bounds the line', () => {
    expect(appsRecoveryIncident(projection({ retainedObservedState: null, observedApps: [...FLEET_APPS] }), now)).toBe('App recovery retrying: Phantom, Codex, Claude +5 (3 failed)');
    expect(appsRecoveryIncident(projection({ retainedObservedState: null, observedApps: null }), now)).toBe('App recovery retrying: apps (3 failed)');
    expect(appsRecoveryIncident(projection({ retainedObservedState: null, observedApps: ['x'.repeat(100)] }), now)!.length).toBeLessThan(80);
  });
  it('uses only the newest invocation and honors the verdict age threshold', () => {
    const value = projection({ terminalOutcome: 'completed' });
    value.invocations.push(projection({ terminalOutcome: 'failed' }).invocations[0]!);
    expect(appsRecoveryIncident(value, now)).toBeNull();
    expect(appsRecoveryIncident(projection({ latestTime: now - 60_001 }), now, 60_000)).toBe('App recovery silent for 1 min');
  });
  it('reads a real apps-watch summary into the formatted glance before the incident cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'recovery-glance-'));
    try {
      const busRoot = join(root, 'bus');
      expect(createAppsWatchPublisher(busRoot)({ kind: 'apps-watch.summary.v1', apps: ['Codex'], outcome: 'failed',
        cycles: 3, recoveries: 0, consecutiveFailures: 3, totalFailedCycles: 3,
        lastObservedState: [{ app: 'Codex', observedRunning: false }] })).toBe(true);
      writeFileSync(join(root, 'NEEDS-MASON.md'), 'First incident\nSecond incident\nThird incident\n');
      const glance = await readOperatorGlance({ runsDir: root, busRoot, now: () => new Date() });
      expect(glance.incidents).toEqual(['App recovery failed: Codex', 'First incident', 'Second incident']);
      expect(formatOperatorGlance(glance)).toContain('App recovery failed: Codex');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
