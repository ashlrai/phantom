/**
 * panes/retired-panes-20.test.ts — RQ-PHX-PANERETIRE20: panes retired for
 * duplicating another surface stay gone, and a dock layout saved before the
 * upgrade still restores (the registry prune drops unknown ids silently).
 *
 * fleet-bus-map retired 2026-11-04: every fact it drew came from the same
 * reads the Bus pane (fleet-bus/FleetBusPane.tsx) already shows — the
 * busFeedQuery header totals (hops, in/out tokens, agents, dropped) and the
 * per-hop from→to rows in its feed, plus the durable agent-bus page its own
 * "Durable bus" view renders (also merged into the fleet-events feed).
 *
 * fleet-decisions retired 2026-11-04: a pure readout of opsFleetQuery whose
 * facts — the production hold, router tick, held items and launched/skipped
 * router decisions with reasons — are all on the Ops surface's "Fleet and
 * router" panel (ops/OpsFleet.tsx, under the Ops tray section).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, type DockState } from '../shell/dock-catalog.js';
import { getDockState, hydrateDockState, resetDockStore } from '../dock/dock-store.js';
import { hubTiles } from '../fleet-hub/fleet-hub-model.js';
import { VERSE_SECTIONS } from '../verse-ui-store.js';
import './index.js';
import { getPane, listPanes } from './pane-registry.js';

const RETIRED_PANE_IDS = ['fleet-bus-map', 'fleet-decisions'] as const;

/** The live surfaces that still show each retired pane's facts. */
const SURVIVING_PANE_IDS = ['fleet-bus'] as const;
const SURVIVING_SECTION_IDS = ['ops'] as const;

/** A dock field as 3.29.15's verse-ui-store persisted it, naming panes that no longer exist. */
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

describe('retired fleet panes (RQ-PHX-PANERETIRE20)', () => {
  beforeEach(() => { localStorage.clear(); resetDockStore(); });

  it('leaves each retired id unregistered after the pane index loads', () => {
    for (const id of RETIRED_PANE_IDS) expect(getPane(id), `pane "${id}" is still registered`).toBeNull();
  });

  it('keeps the duplicate surfaces that show the same facts', () => {
    for (const id of SURVIVING_PANE_IDS) expect(getPane(id), `pane "${id}" is not registered`).not.toBeNull();
    for (const id of SURVIVING_SECTION_IDS) {
      expect(VERSE_SECTIONS.some((section) => section.id === id), `section "${id}" is gone`).toBe(true);
    }
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
