import { render, screen, within } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { UI_STATE_3_29_15 } from '../fixtures/ui-state-3-29-15.test-support.js';
import { registerBuiltinPanes } from '../panes/index.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { getDockState, hydrateDockState, resetDockStore } from './dock-store.js';

const pane: DockPaneContext = {
  sessionId: null, session: null, roots: [], events: [], turnFiles: [],
  host: {
    sendToChat: () => undefined, addToMessage: () => undefined, openPane: () => undefined, closePane: () => undefined,
    openTerminal: () => undefined, openTerminalBelow: () => undefined, openDiff: () => undefined, openSession: () => undefined,
  },
};

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  registerBuiltinPanes();
  hydrateDockState(UI_STATE_3_29_15.dock);
});

it('renders the upgraded tabs and hides unavailable panes without an error', () => {
  render(<Dock presentation="column" windowWidth={1440} columnWidth={440} columnHeight={900} pane={pane} />);
  const dock = screen.getByRole('complementary', { name: 'Dock: Browser' });
  expect(within(dock).getByRole('tab', { name: 'Browser' })).toHaveAttribute('aria-selected', 'true');
  expect(within(dock).getByRole('tab', { name: 'Terminal' })).toBeInTheDocument();
  expect(within(dock).queryByRole('tab', { name: /gone-pane/i })).not.toBeInTheDocument();
  expect(getDockState().tabs).toContain('gone-pane');
  expect(within(dock).queryByText(/could not load/i)).not.toBeInTheDocument();
  expect(within(dock).queryByRole('alert')).not.toBeInTheDocument();
});
