import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { panesFor } from '../panes/index.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { getDockState, openDockPane, resetDockStore } from './dock-store.js';

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

describe('Dock add pane menu', () => {
  it('groups all available closed panes and focuses search', async () => {
    const { menu } = await openMenu();
    expect(within(menu).getByRole('textbox', { name: 'Search panes' })).toHaveFocus();
    for (const name of ['Fleet', 'Merging and shipping', 'Talking to the fleet', 'Agent']) {
      expect(within(menu).getByRole('region', { name })).toBeInTheDocument();
    }
    const expected = panesFor(pane).filter((entry) => entry.id !== 'context').map((entry) => entry.title).sort();
    expect(within(menu).getAllByRole('button').map((button) => button.textContent).sort()).toEqual(expected);
  });

  it('filters across groups and Enter opens the first match', async () => {
    const { user, menu } = await openMenu();
    await user.type(within(menu).getByRole('textbox', { name: 'Search panes' }), 'merg');
    expect(within(menu).getAllByRole('button').map((button) => button.textContent)).toEqual(['Merges']);
    await user.keyboard('{Enter}');
    expect(getDockState().active).toBe('fleet-merges');
    expect(screen.queryByRole('dialog', { name: 'Add a pane' })).not.toBeInTheDocument();
  });

  it('opens and selects a result using only the keyboard', async () => {
    const user = userEvent.setup();
    render(<Dock presentation="column" windowWidth={1440} columnWidth={440} pane={pane} />);
    screen.getByRole('button', { name: 'Add a pane' }).focus();
    await user.keyboard('{Enter}');
    await user.keyboard('merg{Tab}{Enter}');
    expect(getDockState().active).toBe('fleet-merges');
  });

  it('clears a query on Escape, then closes and restores focus on Escape', async () => {
    const { user, menu } = await openMenu();
    await user.type(within(menu).getByRole('textbox', { name: 'Search panes' }), 'missing');
    expect(within(menu).getByText('No matching panes')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(within(menu).getByRole('textbox', { name: 'Search panes' })).toHaveValue('');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Add a pane' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a pane' })).toHaveFocus();
  });
});
