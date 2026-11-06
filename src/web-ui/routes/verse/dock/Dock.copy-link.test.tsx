import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerPane } from '../panes/index.js';
import { parseDeepLink } from '../shell/deep-link.js';
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
let dispose: () => void;
let writeText: ReturnType<typeof vi.fn>;
let clipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  dispose = registerPane({ id: 'fleet-lanes', title: 'Lanes', icon: TasksGlyph, component: Probe, needsSession: false });
  writeText = vi.fn().mockResolvedValue(undefined);
  clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  act(() => openDockPane('fleet-lanes'));
  render(<Dock presentation="column" windowWidth={1440} columnWidth={440} pane={pane} />);
});

afterEach(() => {
  dispose();
  if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
  else Reflect.deleteProperty(navigator, 'clipboard');
  vi.useRealTimers();
});

describe('Dock pane links', () => {
  it('copies a session-free link from the active tab and clears the notice after 1.5 seconds', async () => {
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy link to Lanes' })); });
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    const url = new URL(writeText.mock.calls[0]![0] as string);
    expect(parseDeepLink(url.search)).toEqual({ paneId: 'fleet-lanes', sessionId: null });
    expect(url.searchParams.has('chat')).toBe(false);
    act(() => vi.advanceTimersByTime(1499));
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('button', { name: 'Copy link to Lanes' })).toBeInTheDocument();
  });

  it('copies with Mod+Shift+C without intercepting plain Mod+C', async () => {
    const tab = screen.getByRole('tab', { name: 'Lanes' });
    expect(fireEvent.keyDown(tab, { key: 'c', metaKey: true, cancelable: true })).toBe(true);
    expect(writeText).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(tab, { key: 'C', metaKey: true, shiftKey: true, cancelable: true })).toBe(false);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(parseDeepLink(new URL(writeText.mock.calls[0]![0] as string).search)).toEqual({ paneId: 'fleet-lanes', sessionId: null });
  });

  it('reports a rejected clipboard write', async () => {
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy link to Lanes' }));
    expect(await screen.findByRole('button', { name: 'Copy failed' })).toBeInTheDocument();
  });

  it('includes the active session for a session-dependent pane', async () => {
    const remove = registerPane({ id: 'test-session', title: 'Session pane', icon: TasksGlyph, component: Probe, needsSession: true });
    try {
      act(() => openDockPane('test-session'));
      expect(screen.queryByRole('button', { name: 'Copy link to Lanes' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Copy link to Session pane' }));
      await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
      expect(parseDeepLink(new URL(writeText.mock.calls[0]![0] as string).search)).toEqual({ paneId: 'test-session', sessionId: 'chat-42' });
    } finally {
      act(remove);
    }
  });
});
