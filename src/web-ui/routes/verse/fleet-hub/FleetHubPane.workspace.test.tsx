import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openDockPane, openFleetWorkspace } from '../dock/dock-store.js';
import { registerPane } from '../panes/pane-registry.js';
import { FleetHubPane } from './FleetHubPane.js';

vi.mock('../dock/dock-store.js', () => ({ openDockPane: vi.fn(), openFleetWorkspace: vi.fn() }));

let unregister: (() => void)[] = [];
beforeEach(() => {
  evictAll(); vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ lanes: [], workers: [], leaders: [], events: [], inbox: [], mergesLastHour: { count: 0 } })));
});
afterEach(() => { unregister.forEach((remove) => remove()); unregister = []; vi.unstubAllGlobals(); });

function addPane(id: string, title: string) {
  unregister.push(registerPane({ id, title, needsSession: false, icon: () => null, component: () => null }));
}

it('opens the curated workspace, all present panes, and individual tiles', () => {
  addPane('fleet-events', 'Events');
  addPane('fleet-lanes', 'Lanes');
  addPane('fleet-inbox', 'Inbox');
  addPane('fleet-releases', 'Releases');
  addPane('leader-journal', 'Leader journal');
  addPane('terminal', 'Terminal');
  render(<FleetHubPane visible />);
  fireEvent.click(screen.getByRole('button', { name: 'Open fleet workspace' }));
  expect(openFleetWorkspace).toHaveBeenLastCalledWith(['fleet-lanes', 'fleet-inbox', 'fleet-releases']);
  fireEvent.click(screen.getByRole('button', { name: 'Open all fleet panes' }));
  expect(openFleetWorkspace).toHaveBeenLastCalledWith(['fleet-lanes', 'fleet-events', 'fleet-inbox', 'leader-journal', 'fleet-releases']);
  fireEvent.click(screen.getByRole('button', { name: 'Leader journal —' }));
  expect(openDockPane).toHaveBeenCalledWith('leader-journal');
});

it('disables each workspace action when its own list is empty', () => {
  const view = render(<FleetHubPane visible />);
  expect(screen.getByRole('button', { name: 'Open fleet workspace' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Open all fleet panes' })).toBeDisabled();
  view.unmount();
  addPane('leader-journal', 'Leader journal');
  render(<FleetHubPane visible />);
  expect(screen.getByRole('button', { name: 'Open fleet workspace' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Open all fleet panes' })).toBeEnabled();
});
