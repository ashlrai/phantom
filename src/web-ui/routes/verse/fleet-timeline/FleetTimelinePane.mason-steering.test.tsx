import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane } from '../dock/dock-store.js';
import { requestWorkerLogJob } from '../fleet-job-log/worker-log-selection.js';
import { takeSteeringFocus } from '../fleet-steering/steering-focus.js';
import { FleetTimelinePane } from './FleetTimelinePane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn() }));
vi.mock('../fleet-job-log/worker-log-selection.js', () => ({ requestWorkerLogJob: vi.fn() }));

const at = '2026-10-31T12:30:00Z';
beforeEach(() => {
  evictAll(); localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-31T12:45:00Z'));
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json(String(url).includes('/live/bus')
    ? { v: 1, hops: [], hopsDropped: 0, lastHopAt: null, sources: { hops: 'healthy', events: 'healthy' }, events: [{ at, kind: 'inbox', text: 'INBOX Mason, inspect the fleet' }] }
    : {
      v: 1, generatedAt: '2026-10-31T12:45:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
      lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
      workers: [{ job: 'test-job', repo: 'example/repo', lane: 'codex', tier: 'work', ageSeconds: 1800 }],
      lanes: [{ lane: 'codex', running: 1, target: 1, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
      leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
    })));
});
afterEach(() => { cleanup(); takeSteeringFocus(); vi.unstubAllGlobals(); vi.restoreAllMocks(); localStorage.clear(); });

it('routes Mason to the exact steering request while worker bars still open logs', async () => {
  render(<FleetTimelinePane visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Mason: inspect the fleet' }));
  expect(openDockPane).toHaveBeenCalledWith('fleet-steering');
  expect(takeSteeringFocus()).toEqual({ at, label: 'inspect the fleet' });
  fireEvent.click(screen.getByRole('button', { name: 'codex 1/1: test-job' }));
  expect(requestWorkerLogJob).toHaveBeenCalledWith('test-job');
  expect(openDockPane).toHaveBeenLastCalledWith('worker-log');
  expect(takeSteeringFocus()).toBeNull();
});
