import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';
import { appsRecoveryVerdict } from '../src/core/fleet/apps-recovery-verdict.js';
import { createFleetAppsApi } from '../src/core/verse/fleet-apps-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const path = '/api/verse/fleet/apps/recovery/check';
const id = '12345678-1234-4123-8123-123456789abc';
const query = `invocation=${id}&maxAgeMs=100`;
const row = { invocationId: id, latestCursor: 1, latestTime: 1000, observedApps: ['Phantom'],
  retainedObservedState: [{ app: 'Phantom', observedRunning: true }], retainedDiagnostics: null,
  retainedHealthy: true, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, terminalOutcome: null };
const projection: ReturnType<typeof readAppsRecoveryInvocations> = { v: 1, availability: 'available', truncated: false, scanCursor: 1, scannedEvents: 1, invocations: [row] };
async function call(api: ReturnType<typeof createFleetAppsApi>, url = `${path}?${query}`, method = 'GET') {
  const req = { url, headers: {} } as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  const handled = await api({} as VerseApiContext, req, res, url.split('?')[0]!, method);
  return { handled, status, body: text ? JSON.parse(text) as unknown : undefined, text };
}
function setup(reader: typeof readAppsRecoveryInvocations = () => projection, time = 1100) {
  const exec = vi.fn(), locateScript = vi.fn();
  const read = vi.fn(reader);
  return { api: createFleetAppsApi({ exec, locateScript, runsDir: '/fake/runs', now: () => time, readRecoveryInvocations: read }), exec, locateScript, read };
}

it('returns the shared verdict for fresh, stale, unknown, unhealthy and terminal evidence', async () => {
  const cases: Array<[ReturnType<typeof readAppsRecoveryInvocations>, number, string]> = [
    [projection, 1100, 'healthy'], [projection, 1101, 'stale'],
    [{ ...projection, invocations: [] }, 1100, 'unknown'],
    [{ ...projection, truncated: true }, 1100, 'unknown'],
    [{ ...projection, invocations: [{ ...row, retainedHealthy: false }] }, 1100, 'unhealthy'],
    [{ ...projection, invocations: [{ ...row, terminalOutcome: 'failed' }] }, 9999, 'terminal'],
  ];
  for (const [data, time, verdict] of cases) {
    const { api, read, exec, locateScript } = setup(() => data, time);
    const result = await call(api);
    expect(result).toMatchObject({ handled: true, status: 200, body: { verdict } });
    expect(result.body).toEqual(appsRecoveryVerdict(data, id, 100, time));
    expect(read).toHaveBeenCalledExactlyOnceWith('/fake/runs');
    expect(exec).not.toHaveBeenCalled(); expect(locateScript).not.toHaveBeenCalled();
  }
});

it('rejects invalid queries and methods before reading, and falls through for other routes', async () => {
  const { api, read, exec, locateScript } = setup();
  for (const q of ['', `invocation=${id}`, 'maxAgeMs=1', `invocation=${id.replace('4123', '1123')}&maxAgeMs=1`,
    `invocation=${id}&maxAgeMs=0`, `invocation=${id}&maxAgeMs=1e3`, `invocation=${id}&maxAgeMs=9007199254740992`,
    `${query}&invocation=${id}`, `${query}&maxAgeMs=1`, `${query}&root=/tmp`]) {
    expect((await call(api, `${path}?${q}`)).status).toBe(400);
  }
  expect((await call(api, `${path}?${query}`, 'POST')).status).toBe(405);
  expect(await call(api, '/api/verse/fleet/apps/recovery/other')).toMatchObject({ handled: false, status: 0 });
  expect(read).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(locateScript).not.toHaveBeenCalled();
});

it('sanitizes unavailable projections and reader exceptions', async () => {
  for (const reader of [() => ({ ...projection, availability: 'unavailable' as const }), () => { throw new Error('/private/path'); }]) {
    const { api, exec, locateScript } = setup(reader);
    const result = await call(api);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: 'recovery evidence unavailable' });
    expect(result.text).not.toContain('/private');
    expect(exec).not.toHaveBeenCalled(); expect(locateScript).not.toHaveBeenCalled();
  }
});

it('reads fake retained bus events from the configured isolated root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recovery-api-'));
  try {
    const counts = { invocationId: id, recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0 };
    const body = { ...counts, kind: 'apps-watch.observation.v1', cycle: 1, healthy: true, observedState: row.retainedObservedState };
    expect(appendBusInbox({ id: 'fake-1', from: 'apps-watch', to: 'leaders', priority: 'P2', ttl: 86400000, body }, { root }).status).toBe('posted');
    const data = readAppsRecoveryInvocations(root), time = data.invocations[0]!.latestTime;
    const exec = vi.fn(), locateScript = vi.fn();
    const api = createFleetAppsApi({ runsDir: root, now: () => time, exec, locateScript });
    const result = await call(api);
    expect(result.status).toBe(200);
    expect(result.body).toEqual(appsRecoveryVerdict(data, id, 100, time));
    expect(result.body).toMatchObject({ verdict: 'healthy' });
    expect(exec).not.toHaveBeenCalled(); expect(locateScript).not.toHaveBeenCalled();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
