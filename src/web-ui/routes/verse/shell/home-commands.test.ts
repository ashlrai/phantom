import { afterEach, beforeEach, expect, it } from 'vitest';
import { getVerseUiState, openVerseOverlay, resetVerseUi, setVerseSection } from '../verse-ui-store.js';
import { resetCommandBus } from './command-bus.js';
import { HOME_VIEW_STORAGE_KEY, resetHomeChoice } from './home-view-store.js';
import { resolveHomeView } from './home-view.js';
import { executeCatalogCommand, registerShellCommandHandlers } from './run-command.js';

beforeEach(() => {
  localStorage.clear();
  resetHomeChoice();
  resetVerseUi();
  resetCommandBus();
});
afterEach(() => { resetCommandBus(); resetHomeChoice(); });

it('opens Feed and then Leader from another section, closing overlays and replacing the saved choice', () => {
  const unregister = registerShellCommandHandlers();
  setVerseSection('fleet');
  openVerseOverlay('palette');
  expect(executeCatalogCommand('home.feed', { via: 'palette' })).toBe(true);
  expect(getVerseUiState()).toMatchObject({ section: 'live', overlay: null });
  expect(localStorage.getItem(HOME_VIEW_STORAGE_KEY)).toBe('feed');
  openVerseOverlay('shortcuts');
  expect(executeCatalogCommand('home.leader')).toBe(true);
  expect(getVerseUiState()).toMatchObject({ section: 'live', overlay: null });
  const persisted = localStorage.getItem(HOME_VIEW_STORAGE_KEY);
  expect(persisted).toBe('leader');
  expect(resolveHomeView({ persisted, width: 1000, hasLeaderThread: true }).view).toBe('leader');
  unregister();
});
