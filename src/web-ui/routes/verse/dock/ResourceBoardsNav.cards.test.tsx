/**
 * dock/ResourceBoardsNav.cards.test.tsx — J, K, G and Shift+G inside a resource
 * board, driven through the real dock: the keys step through the elements a
 * board marks `data-board-card`, the row says which one holds the keyboard,
 * and every board on the row marks its cards.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dockPresentation } from '../shell/dock-catalog.js';
import { mockViewport, type ViewportMock } from '../shell/viewport.test-support.js';
import { registerPane, resetPaneRegistry, type PaneContext, type PaneProps } from '../panes/pane-registry.js';
import { boardCards, cardMove, cardTarget } from './board-cards.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { getDockState, openDockPane, resetDockStore } from './dock-store.js';
import { TasksGlyph } from './dock-icons.js';
import { RESOURCE_BOARDS } from './resource-boards.js';

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

/** A stand-in board of three cards (the second holds a control), one more inside a hidden block, and a text field. */
function Board(_props: PaneProps) {
  return <div>
    <input aria-label="filter" />
    <ul>
      <li data-board-card aria-label="first card">one</li>
      <li data-board-card aria-label="second card"><button type="button">inside second</button></li>
      <li data-board-card aria-label="third card">three</li>
    </ul>
    <div hidden><ul><li data-board-card aria-label="folded card">four</li></ul></div>
  </div>;
}
function Bare(_props: PaneProps) { return <p>no cards yet</p>; }

function Harness() {
  return <Dock presentation={dockPresentation(1440, 'right')} windowWidth={1440} columnWidth={440} columnHeight={900} pane={PANE_CONTEXT} />;
}
const nav = () => screen.getByRole('navigation', { name: 'Resource boards' });
const card = (name: string) => screen.getByRole('listitem', { name });
const position = () => nav().querySelector('[data-card-position]')?.textContent ?? null;
const press = (target: Element, key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(target, { key, ...init });

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  vp = mockViewport(1440);
  resetPaneRegistry();
  disposers = [
    registerPane({ id: 'fleet-pools', title: 'Pools', icon: TasksGlyph, component: Board, needsSession: false }),
    registerPane({ id: 'fleet-usage', title: 'Usage', icon: TasksGlyph, component: Bare, needsSession: false }),
  ];
  act(() => { openDockPane('fleet-pools'); });
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  vp?.restore();
  vp = null;
});

describe('cards of a resource board from the keyboard', () => {
  it('steps through the cards with J and K, stops at both ends, and says which card holds the keyboard', () => {
    render(<Harness />);
    expect(position()).toBeNull();
    press(document.body, 'j');
    expect(card('first card')).toHaveFocus();
    expect(position()).toBe('Card 1 of 3');
    press(document.activeElement!, 'j');
    press(document.activeElement!, 'j');
    expect(card('third card')).toHaveFocus();
    expect(position()).toBe('Card 3 of 3');
    // The last card: J stays, and the folded card inside a hidden block is never a stop.
    press(document.activeElement!, 'j');
    expect(card('third card')).toHaveFocus();
    press(document.activeElement!, 'k');
    expect(card('second card')).toHaveFocus();
    press(document.activeElement!, 'k');
    press(document.activeElement!, 'k');
    expect(card('first card')).toHaveFocus();
    expect(position()).toBe('Card 1 of 3');
  });

  it('jumps to the first and last card with G and Shift+G', () => {
    render(<Harness />);
    press(document.body, 'G', { shiftKey: true });
    expect(card('third card')).toHaveFocus();
    press(document.activeElement!, 'g');
    expect(card('first card')).toHaveFocus();
    // Caps Lock sends the capital without Shift: still "first".
    act(() => { card('third card').focus(); });
    press(document.activeElement!, 'G');
    expect(card('first card')).toHaveFocus();
  });

  it('steps from the card a focused control sits in, and counts that card as held', () => {
    render(<Harness />);
    const inside = screen.getByRole('button', { name: 'inside second' });
    act(() => { inside.focus(); });
    expect(position()).toBe('Card 2 of 3');
    press(inside, 'j');
    expect(card('third card')).toHaveFocus();
    // Focus leaving every card clears the count.
    act(() => { screen.getByRole('textbox', { name: 'filter' }).focus(); });
    expect(position()).toBeNull();
  });

  it('leaves the keys alone in a text field, with a modifier, and outside the board', () => {
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'filter' });
    act(() => { field.focus(); });
    expect(press(field, 'j')).toBe(true);
    expect(field).toHaveFocus();
    expect(press(document.body, 'j', { metaKey: true })).toBe(true);
    expect(press(document.body, 'J', { shiftKey: true })).toBe(true);
    expect(press(screen.getByRole('tab', { name: 'Pools' }), 'j')).toBe(true);
    expect(field).toHaveFocus();
    expect(position()).toBeNull();
    // Inside the board the key is taken, so nothing else on the page answers it.
    expect(press(document.body, 'j')).toBe(false);
  });

  it('does nothing, and takes no key, on a board that has drawn no card', () => {
    render(<Harness />);
    fireEvent.click(within(nav()).getByRole('button', { name: 'Usage' }));
    expect(getDockState().active).toBe('fleet-usage');
    expect(press(document.body, 'j')).toBe(true);
    expect(position()).toBeNull();
    // The hint is still on the row: it names the keys, not a count.
    expect(nav().querySelector('[data-keys="cards"]')).toHaveTextContent('JK');
  });
});

describe('board-cards', () => {
  it('reads only J, K and G as moves', () => {
    expect(cardMove({ key: 'j', shiftKey: false })).toBe('next');
    expect(cardMove({ key: 'k', shiftKey: false })).toBe('prev');
    expect(cardMove({ key: 'g', shiftKey: false })).toBe('first');
    expect(cardMove({ key: 'G', shiftKey: true })).toBe('last');
    expect(cardMove({ key: 'K', shiftKey: true })).toBeNull();
    expect(cardMove({ key: 'ArrowDown', shiftKey: false })).toBeNull();
  });

  it('starts at the first card still below the switcher when no card is held', () => {
    const root = document.createElement('div');
    root.innerHTML = '<p data-board-card></p><p data-board-card></p><p data-board-card></p>';
    const cards = boardCards(root);
    // The first card has scrolled under the switcher (its bottom is above the edge); the other two have not.
    cards.forEach((el, index) => { el.getBoundingClientRect = () => ({ bottom: index === 0 ? 20 : 200 + index * 100 }) as DOMRect; });
    expect(cardTarget(cards, null, 'next', 40)).toBe(cards[1]);
    expect(cardTarget(cards, null, 'prev', 40)).toBe(cards[1]);
    expect(cardTarget(cards, cards[1]!, 'next', 40)).toBe(cards[2]);
    expect(cardTarget(cards, cards[2]!, 'next', 40)).toBeNull();
    expect(cardTarget(cards, cards[0]!, 'first', 40)).toBeNull();
    expect(cardTarget([], null, 'next')).toBeNull();
  });

  it('every board on the switcher row marks its cards', () => {
    // The file that draws each board's cards. A board added to the row must mark its cards and be listed here.
    const files: Record<string, string> = {
      'fleet-pools': 'fleet-pools/PoolItem.tsx', 'fleet-usage': 'fleet-usage/FleetUsagePane.tsx', 'fleet-router': 'fleet-router/FleetRouterPane.tsx',
      models: 'models/ModelsPane.tsx', 'fleet-lanes': 'fleet-lanes/FleetLanesPane.tsx', 'fleet-capacity': 'fleet-capacity/LaneCapacityCard.tsx',
      'fleet-supply': 'fleet-supply/FleetSupplyPane.tsx', 'fleet-throughput': 'fleet-throughput/ThroughputBoard.tsx',
    };
    for (const { id } of RESOURCE_BOARDS) {
      expect(files[id], `${id} has no card file listed`).toBeDefined();
      expect(readFileSync(resolve(process.cwd(), 'src/web-ui/routes/verse', files[id]!), 'utf8'), id).toContain('data-board-card');
    }
  });
});
