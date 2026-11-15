import { expect, it } from 'vitest';
import { appRecoveryRow } from '../src/web-ui/routes/verse/fleet-host/apps-recovery-row-model.js';
const now = 1_800_000;
const view = (outcome: string, at = now - 60_000) => ({ v: 1, apps: [{ app: 'Codex', outcome, at }] });
it('recovered includes the outcome and age without retry', () => {
  expect(appRecoveryRow(view('recovered'), 'Codex', now)).toEqual({ label: 'recovered', tone: 'success', ageText: '1m ago', canRetry: false });
});
it.each(['failed', 'gave-up'])('%s allows recovery retry', outcome => {
  expect(appRecoveryRow(view(outcome), 'Codex', now).canRetry).toBe(true);
});
it.each([null, {}, { v: 1, apps: [] }, view('unknown'), view('failed', Infinity), view('failed', now + 1)])('never-run or unreadable evidence stays quiet: %j', raw => {
  expect(appRecoveryRow(raw, 'Codex', now)).toEqual({ label: 'no recovery recorded', tone: 'muted', ageText: '', canRetry: false });
});
it('stale input preserves its age and does not imply a retryable failure', () => {
  expect(appRecoveryRow(view('stale', 0), 'Codex', 86_400_000)).toEqual({ label: 'recovery stale', tone: 'muted', ageText: '1d ago', canRetry: false });
});

// Exercise the route using retained fake history; no process probes or GUI calls.
it('route returns the newest retained outcome per app and rejects writes', async () => {
  const { vi } = await import('vitest');
  vi.resetModules();
  vi.doMock('../src/core/fleet/apps-recovery-invocations.js', () => ({ readAppsRecoveryInvocations: () => ({
    availability: 'available', truncated: false, invocations: [
      { invocationId: 'fake-new', latestCursor: 2, latestTime: now, terminalOutcome: 'failed', retainedObservedState: [{ app: 'Codex', observedRunning: false }, { app: 'Claude', observedRunning: true }] },
      { invocationId: 'fake-old', latestCursor: 1, latestTime: now - 60_000, terminalOutcome: 'completed', retainedObservedState: [{ app: 'Codex', observedRunning: true }] },
    ],
  }) }));
  const send = vi.fn();
  vi.doMock('../src/core/web/api.js', () => ({ sendJson: send }));
  try {
    const { handleFleetAppsRecoveryApi } = await import('../src/core/verse/fleet-apps-recovery-api.js');
    const call = (method: string) => handleFleetAppsRecoveryApi({} as never, {} as never, {} as never, '/api/verse/fleet/apps/recovery', method);
    expect(await call('GET')).toBe(true);
    expect(send.mock.calls[0]?.slice(1)).toEqual([200, { v: 1, apps: [{ app: 'Codex', at: now, outcome: 'gave-up' }, { app: 'Claude', at: now, outcome: 'recovered' }] }]);
    await call('POST'); expect(send.mock.calls[1]?.[1]).toBe(405);
  } finally {
    vi.doUnmock('../src/core/fleet/apps-recovery-invocations.js'); vi.doUnmock('../src/core/web/api.js'); vi.resetModules();
  }
});
