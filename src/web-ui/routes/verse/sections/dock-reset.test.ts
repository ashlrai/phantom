import { afterEach, expect, it, vi } from 'vitest';
import { getDockState, hydrateDockState } from '../dock/dock-store.js';
import { VERSE_UI_STORAGE_KEY, VERSE_UI_STORAGE_KEY_V2 } from '../shell/dock-catalog.js';
import { resetDockLayout } from './dock-reset.js';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it('resets before opening registered curated panes and removes legacy storage', () => {
  localStorage.setItem(VERSE_UI_STORAGE_KEY_V2, 'legacy');
  const reset = vi.fn();
  const open = vi.fn();
  expect(resetDockLayout({ reset, open, panes: () => ['fleet-usage', 'other', 'fleet-lanes'] }))
    .toEqual(['fleet-lanes', 'fleet-usage']);
  expect(reset).toHaveBeenCalledOnce();
  expect(open).toHaveBeenCalledWith(['fleet-lanes', 'fleet-usage']);
  expect(reset.mock.invocationCallOrder[0]).toBeLessThan(open.mock.invocationCallOrder[0]!);
  expect(localStorage.getItem(VERSE_UI_STORAGE_KEY_V2)).toBeNull();
});

it('tolerates unavailable storage', () => {
  vi.stubGlobal('localStorage', undefined);
  expect(() => resetDockLayout({ reset: vi.fn(), open: vi.fn(), panes: () => [] })).not.toThrow();
});

it('forgets persisted tabs, splits, sizes and per-chat layouts', () => {
  localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ dock: { open: true, tabs: ['files'], active: 'files', splitWith: null, size: 700, byChat: { old: { tabs: ['files'], active: 'files' } } } }));
  hydrateDockState(JSON.parse(localStorage.getItem(VERSE_UI_STORAGE_KEY)!).dock);
  resetDockLayout();
  expect(getDockState().tabs).not.toContain('files');
  expect(getDockState().byChat).toEqual({});
});
