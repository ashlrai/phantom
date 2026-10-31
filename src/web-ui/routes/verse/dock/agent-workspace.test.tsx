import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { agentWorkspaceEnabled, AGENT_WORKSPACE_KEY, setAgentWorkspace, useAgentWorkspace, WORKSPACE_PANES } from './agent-workspace.js';
import { Dock, type DockPaneContext } from './Dock.js';
import { getDockState, openDockPane, resetDockStore } from './dock-store.js';
import { registerPane } from '../panes/index.js';
import { TasksGlyph } from './dock-icons.js';
import { VERSE_UI_STORAGE_KEY } from '../shell/dock-catalog.js';

beforeEach(() => { localStorage.clear(); resetDockStore(); });
afterEach(cleanup);

it('persists the layout across unmounts, scoped per chat, and restores the flag off', () => {
  function Probe({ id }: { id: string }) { return <p>{useAgentWorkspace(id) ? 'split' : 'tabs'}</p>; }
  const first = render(<Probe id="one" />);
  act(() => setAgentWorkspace('one', true));
  expect(screen.getByText('split')).toBeInTheDocument();
  first.unmount();
  render(<Probe id="one" />);
  expect(screen.getByText('split')).toBeInTheDocument();
  expect(agentWorkspaceEnabled('two')).toBe(false);
  act(() => setAgentWorkspace('one', false));
  expect(screen.getByText('tabs')).toBeInTheDocument();
});

it.each(['null', '[]', '{', '{"one":"true"}'])('fails closed for invalid persisted data %s', (value) => {
  localStorage.setItem(AGENT_WORKSPACE_KEY, value);
  expect(agentWorkspaceEnabled('one')).toBe(false);
});

it('shows terminal, browser, computer use and diff together after remount, with mobile falling back to tabs', () => {
  const disposers = WORKSPACE_PANES.map((id) => registerPane({ id, title: id, icon: TasksGlyph,
    component: ({ visible }) => <p>{id} {visible ? 'visible' : 'hidden'}</p> }));
  const pane: DockPaneContext = { sessionId: 'one', session: null, roots: [], events: [], turnFiles: [], host: {
    sendToChat() {}, addToMessage() {}, openPane() {}, closePane() {}, openTerminal() {}, openTerminalBelow() {}, openDiff() {}, openSession() {},
  } };
  try {
    setAgentWorkspace('one', true);
    for (const id of WORKSPACE_PANES) openDockPane(id);
    openDockPane('terminal');
    const first = render(<Dock presentation="column" windowWidth={1600} columnWidth={800} pane={pane} />);
    for (const id of WORKSPACE_PANES) expect(screen.getByText(`${id} visible`)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Split the dock' })).not.toBeInTheDocument();
    first.unmount();
    localStorage.setItem(VERSE_UI_STORAGE_KEY, JSON.stringify({ dock: getDockState() }));
    resetDockStore();
    const second = render(<Dock presentation="column" windowWidth={1600} columnWidth={800} pane={pane} />);
    for (const id of WORKSPACE_PANES) expect(screen.getByText(`${id} visible`)).toBeVisible();
    second.rerender(<Dock presentation="sheet" windowWidth={800} columnWidth={440} pane={pane} />);
    expect(screen.getByText('terminal visible')).toBeVisible();
    expect(screen.queryByText('computer visible')).not.toBeInTheDocument();
    expect(screen.getByText('computer hidden')).not.toBeVisible();
    second.rerender(<Dock presentation="column" windowWidth={1600} columnWidth={800} pane={pane} />);
    act(() => setAgentWorkspace('one', false));
    expect(screen.getByText('terminal visible')).toBeVisible();
    for (const id of ['browser', 'computer', 'diff']) expect(screen.getByText(`${id} hidden`)).not.toBeVisible();
  } finally { for (const dispose of disposers) dispose(); }
});
