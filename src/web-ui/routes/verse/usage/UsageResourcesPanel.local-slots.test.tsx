/**
 * RQ-PHX-LOCALSLOTSROW50: the Local cell says "No quota" and shows live slot
 * use instead of "No reader yet" copy and never draws a meter.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { USAGE_RESOURCES } from '../../../../core/usage/resource-usage-types.js';
import { VERSE_FLEET_RUNS_PATH } from '../../../../core/verse/fleet-runs-types.js';
import { UsageResourcesPanel } from './UsageResourcesPanel.js';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const resources = {
  v: 1,
  generatedAt: '2026-11-02T12:00:00.000Z',
  resources: USAGE_RESOURCES.map(({ id, label }) => ({
    id, label, state: 'no-reader', used: null, limit: null, unit: null,
    resetsAt: null, source: null, asOf: null, reason: null,
  })),
};

function runs(lanes: unknown[]) {
  return {
    v: 1, generatedAt: new Date().toISOString(),
    sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
    lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
    lanes, workers: [], leaders: [], orchestratorAgents: null, publishesLastHour: [],
    mergesLastHour: { count: null, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
  };
}

function stub(runsBody: unknown, runsStatus = 200) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/verse/usage-resources') return json(resources);
    if (url === VERSE_FLEET_RUNS_PATH) return json(runsBody, runsStatus);
    return json({ error: 'not found' }, 404);
  }));
}

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

describe('UsageResourcesPanel local slots', () => {
  it('shows no quota and live slot use with no meter', async () => {
    stub(runs([{ lane: 'codex-local', running: 14, target: 13, queued: 4, held: false, heldReason: null,
      tokensLastHour: null, merged24h: null, mergeRate24h: null }]));
    render(<UsageResourcesPanel />);
    await screen.findByRole('list');
    const cell = document.querySelector('[data-resource="local"]') as HTMLElement;
    expect(await within(cell).findByText('14 of 13 slots busy · 4 queued')).toBeInTheDocument();
    expect(within(cell).getByText('No quota · runs on this Mac')).toBeInTheDocument();
    expect(cell).toHaveAttribute('data-state', 'local-slots');
    expect(within(cell).queryByRole('meter')).toBeNull();
  });

  it('says slot use is unknown when the lanes read fails, and leaves other rows alone', async () => {
    stub({ error: 'nope' }, 500);
    render(<UsageResourcesPanel />);
    await screen.findByRole('list');
    const cell = document.querySelector('[data-resource="local"]') as HTMLElement;
    expect(await within(cell).findByText('Slot use unknown')).toBeInTheDocument();
    const zai = document.querySelector('[data-resource="zai"]') as HTMLElement;
    expect(within(zai).getByText('No reader yet')).toBeInTheDocument();
    expect(zai).toHaveAttribute('data-state', 'no-reader');
  });
});
