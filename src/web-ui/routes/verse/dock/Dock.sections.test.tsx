import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { Dock, type DockPaneContext } from './Dock.js';
import { openDockPane, resetDockStore } from './dock-store.js';

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
  act(() => openDockPane('context'));
});

async function openMenu() {
  const user = userEvent.setup();
  render(<Dock presentation="column" windowWidth={1440} columnWidth={440} pane={pane} />);
  await user.click(screen.getByRole('button', { name: 'Add a pane' }));
  return { user, menu: screen.getByRole('dialog', { name: 'Add a pane' }) };
}

describe('Dock add pane menu sections', () => {
  it('renders the section headings in MetaMuse order, ending with Fleet', async () => {
    const { menu } = await openMenu();
    const headings = within(menu).getAllByRole('region').map((region) => region.getAttribute('aria-label'));
    const order = ['Chat', 'Feed', 'Ideas', 'Goals', 'Library', 'Fleet'];
    expect(headings).toEqual(order.filter((name) => headings.includes(name)));
    expect(headings.at(-1)).toBe('Fleet');
  });

  it('filters down to the matching section and hides the empty ones', async () => {
    const { user, menu } = await openMenu();
    await user.type(within(menu).getByRole('textbox', { name: 'Search panes' }), 'FLEET-BUS');
    expect(within(menu).getAllByRole('region').map((region) => region.getAttribute('aria-label'))).toEqual(['Feed']);
    expect(within(menu).queryByRole('region', { name: 'Fleet' })).not.toBeInTheDocument();
  });

  it('tabs from the filter box through panes across headings', async () => {
    const { user, menu } = await openMenu();
    await user.tab();
    const first = within(menu).getAllByRole('button')[0]!;
    expect(first).toHaveFocus();
    await user.keyboard('{Tab}');
    expect(within(menu).getAllByRole('button')[1]).toHaveFocus();
  });
});
