import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_3_29_15, UI_STATE_3_29_15 } from './fixtures/ui-state-3-29-15.test-support.js';

const UI_KEY = 'ashlr.verse.ui.v3';
const ONBOARDING_KEY = 'ashlr.verse.onboarding.v1';

beforeEach(() => {
  localStorage.clear();
  vi.resetModules();
});

describe('3.29.15 desktop state upgrade', () => {
  it('loads and re-saves the section, dock and completed onboarding on launch', async () => {
    localStorage.setItem(UI_KEY, JSON.stringify(UI_STATE_3_29_15));
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(ONBOARDING_3_29_15));
    // Fresh imports exercise the actual launch order, including the first write.
    const ui = await import('./verse-ui-store.js');
    const dock = await import('./dock/dock-store.js');
    const onboarding = await import('./onboarding/onboarding-store.js');

    expect(ui.loadVerseUi()).toMatchObject({ section: 'fleet', railExpanded: true, sidebarWidth: 264, resourcesWidth: 320 });
    expect(onboarding.getOnboardingState()).toMatchObject({ completedAt: ONBOARDING_3_29_15.completedAt, open: false });
    const expectedDock = {
      ...UI_STATE_3_29_15.dock,
      tabs: ['browser', 'terminal', 'fleet-lanes', 'gone-pane'],
      active: 'browser',
      byChat: { 'chat-2': { open: true, tabs: ['terminal', 'browser'], active: 'browser', splitWith: 'terminal' } },
    };
    // Unknown, well-formed IDs are retained for late registration; Dock hides them.
    expect(dock.getDockState()).toEqual(expectedDock);
    const saved = JSON.parse(localStorage.getItem(UI_KEY)!) as Record<string, unknown>;
    expect(saved).toMatchObject({ version: 3, section: 'fleet', dock: expectedDock });
    dock.resetDockStore();
    ui.reloadVerseUiForTest();
    expect(ui.loadVerseUi().section).toBe('fleet');
    expect(dock.getDockState()).toEqual(expectedDock);
    expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({ version: 3, section: 'fleet', dock: expectedDock });
  });

  it('clamps saved custom widths to current bounds instead of resetting them', async () => {
    localStorage.setItem(UI_KEY, JSON.stringify({ ...UI_STATE_3_29_15, sidebarWidth: 999, resourcesWidth: 200 }));
    const ui = await import('./verse-ui-store.js');
    expect(ui.loadVerseUi()).toMatchObject({ section: 'fleet', sidebarWidth: 360, resourcesWidth: 260 });
    expect(JSON.parse(localStorage.getItem(UI_KEY)!)).toMatchObject({ sidebarWidth: 360, resourcesWidth: 260 });
  });
});
