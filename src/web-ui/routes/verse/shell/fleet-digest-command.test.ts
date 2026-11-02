import { waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll, runQuery } from '../../../data/cache.js';
import { opsRunsQuery } from '../ops/ops-runs-queries.js';
import { findCommand } from './command-catalog.js';
import { resetCommandBus } from './command-bus.js';
import { executeCatalogCommand, registerShellCommandHandlers, setShellNotifier } from './run-command.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';

const fixture: FleetRuns = { v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' }, lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null, lanes: [], workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null };

const writeText = vi.fn().mockResolvedValue(undefined);
const notify = vi.fn();
beforeEach(() => {
  evictAll(); vi.clearAllMocks();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  setShellNotifier(notify); registerShellCommandHandlers();
});
afterEach(() => { resetCommandBus(); setShellNotifier(null); vi.restoreAllMocks(); });
describe('fleet digest command', () => {
  it('copies a fresh snapshot without fetching', async () => {
    await runQuery(opsRunsQuery.key, async () => fixture);
    const fetch = vi.spyOn(opsRunsQuery, 'fetch');
    expect(findCommand('fleet.digest')).toMatchObject({ group: 'actions', scope: 'global' });
    expect(executeCatalogCommand('fleet.digest', { via: 'palette' })).toBe(true);
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain('Phantom fleet');
    expect(fetch).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('Fleet digest copied', 'success');
  });
  it('fetches once when no snapshot exists', async () => {
    const fetch = vi.spyOn(opsRunsQuery, 'fetch').mockResolvedValue(fixture);
    executeCatalogCommand('fleet.digest', { via: 'palette' });
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('refreshes a stale snapshot and does not copy it on failure', async () => {
    await runQuery(opsRunsQuery.key, async () => fixture);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 30_000);
    const fetch = vi.spyOn(opsRunsQuery, 'fetch').mockRejectedValue(new Error('offline'));
    executeCatalogCommand('fleet.digest', { via: 'palette' });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Nothing to copy: fleet data unavailable', 'danger'));
    expect(fetch).toHaveBeenCalledOnce();
    expect(writeText).not.toHaveBeenCalled();
    clock.mockRestore();
  });
  it('reports a failed query without copying', async () => {
    vi.spyOn(opsRunsQuery, 'fetch').mockRejectedValue(new Error('offline'));
    executeCatalogCommand('fleet.digest', { via: 'palette' });
    await waitFor(() => expect(notify).toHaveBeenCalledWith('Nothing to copy: fleet data unavailable', 'danger'));
    expect(writeText).not.toHaveBeenCalled();
  });
});
