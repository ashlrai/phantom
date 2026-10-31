/**
 * dock/Dock.close-others.test.tsx — a dock tab's own menu: right-click (or
 * the keyboard's context-menu key) offers Close / Close other panes /
 * Close all panes, and shift-click on a tab's close button closes the
 * others. Three registered probe panes stand in for a fleet workspace's
 * many tabs, the same way Dock.test.tsx's two stand in for panes at large.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockPresentation, type DockPlacement } from '../shell/dock-catalog.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { registerPane, type PaneContext, type PaneProps } from '../panes/index.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { getDockState, openDockPane, resetDockStore } from './dock-store.js';
import { TasksGlyph } from './dock-icons.js';

let vp: ViewportMock | null = null;
let disposers: Array<() => void> = [];

const NO_CHAT: PaneContext = { sessionId: null, session: null, roots: [] };
const PANE_CONTEXT: DockPaneContext = {
  ...NO_CHAT,
  events: [],
  turnFiles: [],
  host: {
    sendToChat: () => undefined, addToMessage: () => undefined, openPane: () => undefined, closePane: () => undefined,
    openTerminal: () => undefined, openTerminalBelow: () => undefined, openDiff: () => undefined, openSession: () => undefined,
  },
};

/** A registry pane that shows what the dock tells it. */
function probe(id: string) {
  return function Probe({ visible, presentation }: PaneProps) {
    return <p data-testid={id} data-visible={String(visible)} data-presentation={presentation}>{id} body</p>;
  };
}

function Harness({ width, placement = 'right' }: { width: number; placement?: DockPlacement }) {
  return <Dock presentation={dockPresentation(width, placement)} windowWidth={width} columnWidth={440} columnHeight={900} pane={PANE_CONTEXT} />;
}

function openThree() {
  act(() => { openDockPane('alpha'); openDockPane('bravo'); openDockPane('charlie'); });
}

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  vp = mockViewport(1440);
  disposers = [
    registerPane({ id: 'alpha', title: 'Alpha', icon: TasksGlyph, component: probe('alpha'), needsSession: false }),
    registerPane({ id: 'bravo', title: 'Bravo', icon: TasksGlyph, component: probe('bravo'), needsSession: false }),
    registerPane({ id: 'charlie', title: 'Charlie', icon: TasksGlyph, component: probe('charlie'), needsSession: false }),
  ];
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  vp?.restore();
  vp = null;
});

describe('Dock — a tab\'s close menu', () => {
  it('closes the other tabs from the middle tab\'s menu and keeps it selected', () => {
    openThree();
    render(<Harness width={1440} />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Bravo' }));
    expect(screen.getByRole('menu', { name: 'Bravo pane' })).toBeInTheDocument();
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Close Bravo', 'Close other panes', 'Close all panes']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close other panes' }));
    expect(screen.queryByRole('menu')).toBeNull();
    expect(getDockState().tabs).toEqual(['bravo']);
    expect(getDockState().active).toBe('bravo');
    const tab = screen.getByRole('tab', { name: 'Bravo' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('bravo')).toHaveAttribute('data-visible', 'true');
  });

  it('closes every tab with "Close all panes" and the dock goes away', () => {
    openThree();
    render(<Harness width={1440} />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Bravo' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close all panes' }));
    expect(getDockState().open).toBe(false);
    expect(getDockState().tabs).toEqual([]);
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('"Close <title>" on the menu closes just that tab', () => {
    openThree();
    render(<Harness width={1440} />);
    fireEvent.contextMenu(screen.getByRole('tab', { name: 'Alpha' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Alpha' }));
    expect(getDockState().tabs).toEqual(['bravo', 'charlie']);
  });

  it('opens the same menu from the keyboard: ContextMenu key and Shift+F10', () => {
    openThree();
    render(<Harness width={1440} />);
    const tab = screen.getByRole('tab', { name: 'Bravo' });
    fireEvent.keyDown(tab, { key: 'ContextMenu' });
    expect(screen.getByRole('menu', { name: 'Bravo pane' })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('menu', { name: 'Bravo pane' }), { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    fireEvent.keyDown(tab, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'Bravo pane' })).toBeInTheDocument();
  });
});

describe('Dock — shift-click closes the others', () => {
  it('leaves the shift-clicked tab as the only one, with its aria-label unchanged', () => {
    openThree();
    render(<Harness width={1440} />);
    const close = screen.getByRole('button', { name: 'Close Bravo' });
    expect(close).toHaveAttribute('aria-label', 'Close Bravo');
    fireEvent.click(close, { shiftKey: true });
    expect(getDockState().tabs).toEqual(['bravo']);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Bravo']);
    expect(screen.getByRole('button', { name: 'Close Bravo' })).toHaveAttribute('aria-label', 'Close Bravo');
  });

  it('a plain click on the same button still closes just that tab', () => {
    openThree();
    render(<Harness width={1440} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close Bravo' }));
    expect(getDockState().tabs).toEqual(['alpha', 'charlie']);
  });
});
