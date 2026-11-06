import { expect, it } from 'vitest';
import { DEFAULT_DOCK_STATE, sanitizeDockState } from '../shell/dock-catalog.js';
import { withFleetWorkspace } from './dock-store.js';

it('orders fleet tabs first, deduplicates and preserves other tabs and dimensions', () => {
  const state = { ...DEFAULT_DOCK_STATE, tabs: ['terminal', 'fleet-events', 'diff', 'fleet-hub'], width: 520 };
  const next = withFleetWorkspace(state, ['fleet-lanes', 'fleet-events', 'fleet-inbox', 'fleet-events']);
  expect(next).toMatchObject({ open: true, tabs: ['fleet-lanes', 'fleet-events', 'fleet-inbox', 'terminal', 'diff', 'fleet-hub'], active: 'fleet-lanes', splitWith: 'fleet-events', width: 520 });
  expect(state.tabs).toEqual(['terminal', 'fleet-events', 'diff', 'fleet-hub']);
  expect(sanitizeDockState(JSON.parse(JSON.stringify(next)))).toEqual(next);
});

it('uses the supplied preference order and clears a prior split for one pane', () => {
  expect(withFleetWorkspace({ ...DEFAULT_DOCK_STATE, splitWith: 'terminal' }, ['fleet-events'])).toMatchObject({ active: 'fleet-events', splitWith: null });
  expect(withFleetWorkspace(DEFAULT_DOCK_STATE, ['fleet-inbox', 'fleet-merges'])).toMatchObject({ active: 'fleet-inbox', splitWith: 'fleet-merges' });
});

it('returns the same state when no panes are available', () => {
  expect(withFleetWorkspace(DEFAULT_DOCK_STATE, [])).toBe(DEFAULT_DOCK_STATE);
});
