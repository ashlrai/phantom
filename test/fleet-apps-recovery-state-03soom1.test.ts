import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { createAppsWatchPublisher } from '../src/core/fleet/apps-watch-bus.js';
import { readAppsRecoveryHistory } from '../src/core/fleet/apps-recovery-history.js';
import { readAppsRecoveryInvocations } from '../src/core/fleet/apps-recovery-invocations.js';
import { cmdFleetAppsRecoveryState } from '../src/cli/fleet-apps-recovery-state.js';

const roots: string[] = [];
function root() { const path = mkdtempSync(join(tmpdir(), 'fake-recovery-')); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); vi.restoreAllMocks(); });
const observation = { kind: 'apps-watch.observation.v1' as const, cycle: 1, healthy: false, recoveries: 1,
  consecutiveFailures: 1, totalFailedCycles: 1, observedState: [{ app: 'Phantom', observedRunning: false }] };

describe('retained recovery invocations', () => {
  it('groups interleaved real events and retains terminal evidence', () => {
    const dir = root(), a = createAppsWatchPublisher(dir), b = createAppsWatchPublisher(dir);
    expect(a(observation)).toBe(true);
    expect(b(observation)).toBe(true);
    expect(appendBusInbox({ id: 'fake-unrelated', from: 'fake', to: 'leaders', priority: 'P2', ttl: 60000, body: { fake: true } }, { root: dir }).status).toBe('posted');
    expect(a({ kind: 'apps-watch.summary.v1', apps: ['Phantom'], outcome: 'completed', cycles: 1,
      recoveries: 2, consecutiveFailures: 0, totalFailedCycles: 1, lastObservedState: observation.observedState })).toBe(true);
    expect(readAppsRecoveryHistory(dir, 0, 100).events).toHaveLength(3);
    const result = readAppsRecoveryInvocations(dir);
    expect(result).toMatchObject({ availability: 'available', truncated: false, scannedEvents: 3 });
    expect(result.invocations.map(row => row.terminalOutcome)).toEqual(['completed', null]);
    expect(result.invocations[0]).toMatchObject({ observedApps: ['Phantom'], recoveries: 2 });
    expect(result.invocations[0]!.latestCursor).toBeGreaterThan(result.invocations[1]!.latestCursor);
  });
  it('distinguishes empty and unavailable and returns CLI status', async () => {
    const dir = root();
    expect(readAppsRecoveryInvocations(dir)).toMatchObject({ availability: 'available', invocations: [], truncated: false });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetAppsRecoveryState(['--root', dir, '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({ availability: 'available', invocations: [] });
    mkdirSync(join(dir, 'bus-inbox'), { mode: 0o700 });
    writeFileSync(join(dir, 'bus-inbox', 'messages.json'), 'invalid', { mode: 0o600 });
    expect(await cmdFleetAppsRecoveryState(['--root', dir, '--json'])).toBe(1);
    expect(readAppsRecoveryInvocations(dir)).toMatchObject({ availability: 'unavailable', truncated: true });
  });
  it('signals bounded groups and keeps an observed summary after a later observation', () => {
    const dir = root();
    const event = (cursor: number, id: string, kind: string) => ({ cursor, receivedAt: cursor, invocationId: id, kind,
      recoveries: 0, consecutiveFailures: 0, totalFailedCycles: 0, observedState: null, lastObservedState: null, outcome: 'failed' });
    const events = [event(1, 'first', 'apps-watch.summary.v1'), event(2, 'first', 'apps-watch.observation.v1'),
      ...Array.from({ length: 100 }, (_, i) => event(i + 3, `fake-${i}`, 'apps-watch.observation.v1'))];
    const reader: typeof readAppsRecoveryHistory = (_root, after, limit) => {
      const page = events.filter(row => row.cursor > after).slice(0, limit);
      return { v: 1, availability: 'available', events: page, nextCursor: page.at(-1)?.cursor ?? after, hasMore: page.length === limit };
    };
    const partial = readAppsRecoveryInvocations(dir, (_root, after, limit) => reader(_root, after, Math.min(limit, 2)));
    expect(partial).toMatchObject({ truncated: true, scanCursor: 102 });
    expect(partial.invocations).toHaveLength(100);
    const short = readAppsRecoveryInvocations(dir, (_root, after, limit) => {
      const page = reader(_root, after, limit);
      return { ...page, events: page.events.slice(0, 2), nextCursor: 2, hasMore: false };
    });
    expect(short.invocations[0]!.terminalOutcome).toBe('failed');
  });
});
