/**
 * panes/retired-panes-17.test.ts — RQ-PHX-PANERETIRE17: panes retired for
 * duplicating another surface stay gone, and a dock layout saved before the
 * upgrade still restores (the registry prune drops unknown ids silently).
 *
 * fleet-experiments retired 2026-11-04: a pure planner readout (no operator
 * action) whose calibration A/B facts were already on the Ops surface's
 * "A/B results" (ops/OpsFleet.tsx) and the Growth section's ForestPlot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, type DockState } from '../shell/dock-catalog.js';
import { getDockState, hydrateDockState, resetDockStore } from '../dock/dock-store.js';
import { hubTiles } from '../fleet-hub/fleet-hub-model.js';
import './index.js';
import { getPane, listPanes } from './pane-registry.js';

const RETIRED_PANE_IDS = ['fleet-experiments'] as const;

/** A dock field as 3.29.15's verse-ui-store persisted it, naming a pane that no longer exists. */
const SAVED_3_29_15: DockState = {
  ...DEFAULT_DOCK_STATE,
  open: true,
  tabs: ['fleet-hub', ...RETIRED_PANE_IDS, 'terminal'],
  active: RETIRED_PANE_IDS[0],
  splitWith: 'fleet-hub',
  byChat: {
    'session-a1': { open: true, tabs: [...RETIRED_PANE_IDS, 'tasks'], active: RETIRED_PANE_IDS[0], splitWith: null },
  },
};

describe('retired fleet panes (RQ-PHX-PANERETIRE17)', () => {
  beforeEach(() => { localStorage.clear(); resetDockStore(); });

  it('leaves each retired id unregistered after the pane index loads', () => {
    for (const id of RETIRED_PANE_IDS) expect(getPane(id), `pane "${id}" is still registered`).toBeNull();
  });

  it('names no retired id in another pane’s copy or a hub tile', () => {
    for (const pane of listPanes()) {
      for (const id of RETIRED_PANE_IDS) {
        expect(pane.title, `pane "${pane.id}" title names "${id}"`).not.toContain(id);
        expect(pane.description ?? '', `pane "${pane.id}" description names "${id}"`).not.toContain(id);
      }
    }
    for (const tile of hubTiles(null, listPanes())) {
      for (const id of RETIRED_PANE_IDS) {
        expect(tile.id, `hub tile "${tile.id}"`).not.toBe(id);
        expect(tile.title, `hub tile "${tile.title}"`).not.toContain(id);
      }
    }
  });

  it('restores a saved layout naming the retired ids, keeping the survivors', async () => {
    expect(() => hydrateDockState(SAVED_3_29_15)).not.toThrow();
    await Promise.resolve();
    const restored = getDockState();
    for (const id of RETIRED_PANE_IDS) {
      expect(restored.tabs).not.toContain(id);
      expect(restored.active).not.toBe(id);
      expect(restored.splitWith).not.toBe(id);
      for (const saved of Object.values(restored.byChat)) {
        expect(saved.tabs).not.toContain(id);
        expect(saved.active).not.toBe(id);
        expect(saved.splitWith).not.toBe(id);
      }
    }
    expect(restored.tabs).toContain('fleet-hub');
    expect(restored.active).toBe('fleet-hub');
    expect(restored.byChat['session-a1']?.tabs).toEqual(['tasks']);
  });
});
