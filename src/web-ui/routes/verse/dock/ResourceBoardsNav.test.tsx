/**
 * dock/ResourceBoardsNav.test.tsx — the switcher above the resource boards,
 * driven through the real dock: which panes get it, that choosing a board
 * replaces the one on screen in the same tab, and the keys.
 */
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockPresentation } from '../shell/dock-catalog.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { registerPane, resetPaneRegistry, type PaneContext, type PaneProps } from '../panes/pane-registry.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { getDockState, openDockPane, resetDockStore } from './dock-store.js';
import { TasksGlyph } from './dock-icons.js';

let vp: ViewportMock | null = null;
let disposers: Array<() => void> = [];

const NO_CHAT: PaneContext = { sessionId: null, session: null, roots: [] };
const PANE_CONTEXT: DockPaneContext = {
  ...NO_CHAT, events: [], turnFiles: [],
  host: {
    sendToChat: () => undefined, addToMessage: () => undefined, openPane: () => undefined, closePane: () => undefined,
    openTerminal: () => undefined, openTerminalBelow: () => undefined, openDiff: () => undefined, openSession: () => undefined,
  },
};

/** A stand-in board: a line of text and a field, so "typing" has somewhere to happen. */
function probe(id: string) {
  return function Probe(_props: PaneProps) {
    return <div data-testid={id}><p>{id} body</p><input aria-label={`${id} filter`} /><button type="button">{id} action</button></div>;
  };
}
const register = (id: string, title: string, description?: string) =>
  registerPane({ id, title, description, icon: TasksGlyph, component: probe(id), needsSession: false });

function Harness() {
  return <Dock presentation={dockPresentation(1440, 'right')} windowWidth={1440} columnWidth={440} columnHeight={900} pane={PANE_CONTEXT} />;
}
const nav = () => screen.getByRole('navigation', { name: 'Resource boards' });
const names = () => within(nav()).getAllByRole('button').map((button) => button.textContent);

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  vp = mockViewport(1440);
  // The dock's import registers every real pane; start from none so the row is exactly the stand-ins below.
  resetPaneRegistry();
  // Registered out of switcher order, and without Router or Supply: the row follows its own order and skips what is absent.
  disposers = [
    register('fleet-capacity', 'Capacity'),
    register('models', 'Models'),
    register('fleet-usage', 'Usage'),
    register('fleet-pools', 'Pools', 'Every pool on one board.'),
    register('fleet-lanes', 'Lanes'),
    register('fleet-sessions', 'Sessions'),
  ];
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  vp?.restore();
  vp = null;
});

describe('ResourceBoardsNav', () => {
  it('lists the registered boards in one order above a resource board and marks the one on screen', () => {
    act(() => { openDockPane('fleet-pools'); });
    render(<Harness />);
    expect(names()).toEqual(['Pools', 'Usage', 'Models', 'Lanes', 'Capacity']);
    const pools = within(nav()).getByRole('button', { name: 'Pools' });
    expect(pools).toHaveAttribute('aria-current', 'page');
    expect(pools).toHaveAttribute('title', 'What the fleet has. Every pool on one board.');
    expect(within(nav()).getByRole('button', { name: 'Usage' })).not.toHaveAttribute('aria-current');
    // One Tab stop for the row.
    expect(within(nav()).getAllByRole('button').filter((button) => button.tabIndex === 0)).toEqual([pools]);
  });

  it('is not drawn above a pane that is not a resource board', () => {
    act(() => { openDockPane('fleet-sessions'); });
    render(<Harness />);
    expect(screen.getByTestId('fleet-sessions')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Resource boards' })).toBeNull();
  });

  it('replaces the board on screen in the same tab when another is chosen', () => {
    act(() => { openDockPane('fleet-sessions'); openDockPane('fleet-pools'); });
    render(<Harness />);
    fireEvent.click(within(nav()).getByRole('button', { name: 'Lanes' }));
    expect(getDockState().tabs).toEqual(['fleet-sessions', 'fleet-lanes']);
    expect(getDockState().active).toBe('fleet-lanes');
    expect(screen.getByTestId('fleet-lanes')).toBeInTheDocument();
    expect(screen.queryByTestId('fleet-pools')).toBeNull();
    expect(within(nav()).getByRole('button', { name: 'Lanes' })).toHaveAttribute('aria-current', 'page');
  });

  it('brings a board that already has its own tab forward and keeps both tabs', () => {
    act(() => { openDockPane('fleet-usage'); openDockPane('fleet-pools'); });
    render(<Harness />);
    fireEvent.click(within(screen.getAllByRole('navigation', { name: 'Resource boards' }).find((el) => !el.closest('[hidden]'))!).getByRole('button', { name: 'Usage' }));
    expect(getDockState().tabs).toEqual(['fleet-usage', 'fleet-pools']);
    expect(getDockState().active).toBe('fleet-usage');
  });

  it('moves along the row with the arrow keys, wraps, and keeps focus on the board it opened', () => {
    act(() => { openDockPane('fleet-pools'); });
    render(<Harness />);
    const pools = within(nav()).getByRole('button', { name: 'Pools' });
    pools.focus();
    fireEvent.keyDown(pools, { key: 'ArrowRight' });
    expect(getDockState().active).toBe('fleet-usage');
    expect(within(nav()).getByRole('button', { name: 'Usage' })).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(getDockState().active).toBe('fleet-capacity');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(getDockState().active).toBe('fleet-pools');
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(getDockState().active).toBe('fleet-capacity');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(getDockState().active).toBe('fleet-pools');
    expect(getDockState().tabs).toEqual(['fleet-pools']);
  });

  it('answers [ and ] from inside the board and from an unfocused page, never from a text field', () => {
    act(() => { openDockPane('fleet-pools'); });
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'fleet-pools action' }), { key: ']' });
    expect(getDockState().active).toBe('fleet-usage');
    fireEvent.keyDown(document.body, { key: '[' });
    expect(getDockState().active).toBe('fleet-pools');
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'fleet-pools filter' }), { key: ']' });
    expect(getDockState().active).toBe('fleet-pools');
    fireEvent.keyDown(screen.getByRole('button', { name: 'fleet-pools action' }), { key: ']', metaKey: true });
    expect(getDockState().active).toBe('fleet-pools');
    // A key pressed in another part of the page (a dock tab here) is not this board's.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Pools' }), { key: ']' });
    expect(getDockState().active).toBe('fleet-pools');
  });

  it('is left out when only one board is registered', () => {
    for (const dispose of disposers.splice(0, 3)) dispose();
    disposers.splice(1, 1)[0]!();
    act(() => { openDockPane('fleet-pools'); });
    render(<Harness />);
    expect(screen.getByTestId('fleet-pools')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Resource boards' })).toBeNull();
  });
});
