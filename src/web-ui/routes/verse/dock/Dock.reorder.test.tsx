import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerPane } from '../panes/index.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { openDockPane, resetDockStore } from './dock-store.js';
import { TasksGlyph } from './dock-icons.js';

const pane: DockPaneContext = {
  sessionId: 'chat-42', session: null, roots: [], events: [], turnFiles: [],
  host: {
    sendToChat: () => undefined, addToMessage: () => undefined, openPane: () => undefined, closePane: () => undefined,
    openTerminal: () => undefined, openTerminalBelow: () => undefined, openDiff: () => undefined, openSession: () => undefined,
  },
};
const Probe = () => <div>Pane</div>;
let disposers: Array<() => void>;

function tabOrder() {
  return within(screen.getByRole('tablist', { name: 'Dock panes' })).getAllByRole('tab').map((tab) => tab.textContent);
}

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  disposers = ['Alpha', 'Bravo', 'Charlie'].map((title) => registerPane({
    id: title.toLowerCase(), title, icon: TasksGlyph, component: Probe, needsSession: false,
  }));
  act(() => { openDockPane('alpha'); openDockPane('bravo'); openDockPane('charlie'); openDockPane('bravo'); });
  render(<Dock presentation="column" windowWidth={1440} columnWidth={440} pane={pane} />);
});

afterEach(() => { for (const dispose of disposers) dispose(); });

describe('Dock tab reordering', () => {
  it('moves a tab from its context menu without changing the active pane', () => {
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Bravo' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move left' }));
    expect(tabOrder()).toEqual(['Bravo', 'Alpha', 'Charlie']);
    expect(screen.getByRole('tab', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Bravo' }));
    expect(screen.getByRole('menuitem', { name: 'Move left' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('menuitem', { name: 'Move right' })).not.toHaveAttribute('aria-disabled');
  });

  it('moves a focused tab with Alt+Arrow while respecting the boundaries', () => {
    const tab = screen.getByRole('tab', { name: 'Charlie' });
    tab.focus();
    expect(fireEvent.keyDown(tab, { key: 'ArrowRight', altKey: true, cancelable: true })).toBe(false);
    expect(tabOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(fireEvent.keyDown(tab, { key: 'ArrowLeft', altKey: true, cancelable: true })).toBe(false);
    expect(tabOrder()).toEqual(['Alpha', 'Charlie', 'Bravo']);
    expect(tab).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Bravo' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tab, { key: 'ArrowRight', altKey: true });
    expect(tabOrder()).toEqual(['Alpha', 'Bravo', 'Charlie']);
    expect(tab).toHaveFocus();
  });
});
