import { screen } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { deriveFleetNeedsYou } from '../shell/fleet-needs-you.js';
import { FleetAttentionCards } from './FleetAttentionCards.js';
import { renderMobile, stubFetch } from './mobile.test-support.js';
import { fleetAttention } from './needs-fleet-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot: FleetRuns = {
  v: 1, generatedAt: new Date(now).toISOString(),
  sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: '2026-10-31T11:30:00Z', paused: false, memFreePct: 50, diskFreeGb: 4,
  switches: ['HOLD'], claudeLane: 'down: quota',
  lanes: [{ lane: 'codex-personal', running: 0, target: 1, queued: 2, held: true, heldReason: 'operator hold', tokensLastHour: 0, merged24h: 0, mergeRate24h: 0 }],
  workers: [], leaders: [{ label: 'leader', ageSeconds: 30 }], orchestratorAgents: 1,
  publishesLastHour: [], mergesLastHour: { count: 1, items: [] }, events: [],
  codexPersonal: { usedPct: 97, resetsAt: null, asOf: new Date(now).toISOString() }, inbox: [], drop: null,
};

afterEach(() => { evictAll(); vi.unstubAllGlobals(); });

describe('fleet attention parity', () => {
  it('shows every desktop item with identical words and mapped severity, plus the mobile tick', () => {
    const desktop = deriveFleetNeedsYou(snapshot, now).items;
    const cards = fleetAttention(snapshot, now);
    expect(desktop.map((item) => item.id)).toEqual(expect.arrayContaining([
      'claude-lane-down', 'switches-on', 'lane-held:codex-personal', 'supply-personal-low', 'host-pressure',
    ]));
    expect(cards.map((card) => card.id).sort()).toEqual([...desktop.map((item) => item.id), 'orchestrator-tick'].sort());
    for (const item of desktop) {
      expect(cards.find((card) => card.id === item.id)).toEqual({
        id: item.id, severity: item.severity === 'urgent' ? 'high' : 'medium',
        title: item.title, detail: item.detail, next: item.nextStep,
      });
    }
  });
  it('renders the held lane and personal Codex with the desktop words', async () => {
    stubFetch({ 'GET /api/verse/fleet/runs': snapshot });
    renderMobile(createElement(FleetAttentionCards, { nowMs: now }));
    const desktop = deriveFleetNeedsYou(snapshot, now).items;
    for (const id of ['lane-held:codex-personal', 'supply-personal-low']) {
      const item = desktop.find((candidate) => candidate.id === id)!;
      expect(await screen.findByRole('heading', { name: item.title })).toBeInTheDocument();
      expect(screen.getByText(item.detail)).toBeInTheDocument();
      expect(screen.getByText(item.nextStep)).toBeInTheDocument();
    }
  });
  it('deduplicates identical desktop item ids', () => {
    const duplicate = { ...snapshot, lanes: [snapshot.lanes[0]!, snapshot.lanes[0]!] };
    expect(fleetAttention(duplicate, now).filter((card) => card.id === 'lane-held:codex-personal')).toHaveLength(1);
  });
  it('handles null and unknown snapshot shapes', () => {
    expect(fleetAttention(null, now)).toEqual([]);
    expect(fleetAttention({}, now)).toEqual([]);
    expect(deriveFleetNeedsYou({ lastTick: null }, now).items).toEqual([]);
    expect(fleetAttention({ lastTick: null }, now).map((card) => card.id)).toEqual(['orchestrator-tick']);
  });
});
