import { act, render, screen, within } from '@testing-library/react';
import { expect, it } from 'vitest';
import '../fleet-inbox/fleet-inbox.pane.js';
import '../fleet-bus/fleet-bus.pane.js';
import '../fleet-events/fleet-events.pane.js';
import '../fleet-host/fleet-host.pane.js';
import '../fleet-timeline/fleet-timeline.pane.js';
import '../fleet-brief/fleet-brief.pane.js';
import '../fleet-supply/fleet-supply.pane.js';
import '../leader-thread/leader-thread.pane.js';
import '../leader-journal/leader-journal.pane.js';
import { registerPane } from '../panes/pane-registry.js';
import { FleetPaneShortcuts } from './FleetPaneShortcuts.js';

it('lists the fleet pane titles and formatted shortcuts and follows registry changes', () => {
  render(<FleetPaneShortcuts platform="mac" />);
  const group = within(screen.getByRole('region', { name: 'Fleet panes' }));
  for (const [title, chord] of [
    ["Leaders' inbox", '⌥⌘I'], ['Bus', '⌥⌘B'], ['Fleet events', '⌥⌘E'],
    ['Mac host', '⌥⌘H'], ['Worker timeline', '⌥⌘T'], ['Fleet brief', '⌥⌘F'],
    ['Supply', '⌥⌘U'], ['Leaders', '⌥⌘L'], ['Leader journal', '⌥⌘J'],
  ]) {
    const term = group.getByText(title!);
    expect(term.parentElement).toHaveTextContent(chord!);
  }
  expect(group.getAllByRole('term')).toHaveLength(9);
  const Blank = () => null;
  let dispose: () => void = () => undefined;
  act(() => { dispose = registerPane({ id: 'test-shortcut', title: 'Another pane', icon: Blank, component: Blank, shortcut: 'ctrl+shift+x' }); });
  expect(group.getByText('Another pane').parentElement).toHaveTextContent('⌃⇧X');
  act(() => dispose());
  expect(group.queryByText('Another pane')).not.toBeInTheDocument();
});
