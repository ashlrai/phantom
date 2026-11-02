import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UI_STATE_3_29_15 } from './fixtures/ui-state-3-29-15.test-support.js';

const UI_KEY = 'ashlr.verse.ui.v3';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 20, 12));
});

afterEach(() => vi.useRealTimers());

describe('3.29.15 desktop recent actions upgrade', () => {
  it('migrates and deduplicates pane actions while preserving the rest of the saved state', async () => {
    const previous = {
      ...UI_STATE_3_29_15,
      recentActions: ['pane.preview', 'fleet.digest', 'pane.preview', 'pane.fleet-lanes'],
    };
    localStorage.setItem(UI_KEY, JSON.stringify(previous));

    // Fresh imports exercise the launch write and dock hydration together.
    const ui = await import('./verse-ui-store.js');
    const dock = await import('./dock/dock-store.js');
    const expectedActions = ['pane.browser', 'fleet.digest', 'pane.fleet-lanes'];
    const expectedDock = {
      ...previous.dock,
      tabs: ['browser', 'terminal', 'fleet-lanes', 'gone-pane'],
      active: 'browser',
      byChat: { 'chat-2': { open: true, tabs: ['terminal', 'browser'], active: 'browser', splitWith: 'terminal' } },
    };
    const expectedSaved = { ...previous, recentActions: expectedActions, dock: expectedDock };

    expect(ui.loadVerseUi()).toMatchObject({
      section: previous.section,
      railExpanded: previous.railExpanded,
      sidebarWidth: previous.sidebarWidth,
      sidebarCollapsed: previous.sidebarCollapsed,
      resourcesOpen: previous.resourcesOpen,
      resourcesWidth: previous.resourcesWidth,
      recentActions: expectedActions,
      recentChats: previous.recentChats,
    });
    expect(dock.getDockState()).toEqual(expectedDock);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toEqual(expectedSaved);
    dock.resetDockStore();
    ui.reloadVerseUiForTest();
    expect(ui.loadVerseUi().recentActions).toEqual(expectedActions);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toEqual(expectedSaved);
  });

  it('retains the original fixture action and non-default layout preferences', async () => {
    const previous = { ...UI_STATE_3_29_15, sidebarCollapsed: true, resourcesOpen: false };
    localStorage.setItem(UI_KEY, JSON.stringify(previous));
    const ui = await import('./verse-ui-store.js');
    expect(ui.loadVerseUi()).toMatchObject({
      recentActions: previous.recentActions,
      recentChats: previous.recentChats,
      sidebarCollapsed: true,
      resourcesOpen: false,
    });
    expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({
      recentActions: previous.recentActions,
      recentChats: previous.recentChats,
      sidebarCollapsed: true,
      resourcesOpen: false,
    });
  });

  it('keeps unknown valid actions and applies the limit after normalization and deduplication', async () => {
    localStorage.setItem(UI_KEY, JSON.stringify({
      ...UI_STATE_3_29_15,
      recentActions: ['pane.preview', 'pane.browser', 'pane.future-pane', 'pane.future.action', 'bad action', 'fleet.digest', 'pane.fleet-lanes', 'chat.new'],
    }));
    const ui = await import('./verse-ui-store.js');
    const expected = ['pane.browser', 'pane.future-pane', 'pane.future.action', 'fleet.digest', 'pane.fleet-lanes'];
    expect(ui.loadVerseUi().recentActions).toEqual(expected);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!).recentActions).toEqual(expected);
  });

  it('keeps a fresh store empty', async () => {
    const ui = await import('./verse-ui-store.js');
    expect(ui.loadVerseUi()).toMatchObject({ section: 'chat', recentActions: [], recentChats: [] });
    expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({ section: 'chat', recentActions: [], recentChats: [] });
  });
});
