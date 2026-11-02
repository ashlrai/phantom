import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { evictAll } from '../../../data/cache.js';
import { FleetGraphPane } from './FleetGraphPane.js';

const fixture: FleetRunsV1 = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [{ lane: 'codex-personal', running: 1, target: 2, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null }],
  workers: [{ job: 'job-1', lane: 'codex-personal', repo: 'example/project', tier: 'frontier', ageSeconds: 10_000 }],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 2, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};

beforeEach(() => { evictAll(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('shows stuck workers in the graph header', async () => {
  render(<FleetGraphPane visible />);
  expect(await screen.findByText(/1 looks stuck/)).toBeInTheDocument();
  expect(screen.getByLabelText('Fleet graph').querySelector('header')).toHaveTextContent('1 looks stuck');
});
