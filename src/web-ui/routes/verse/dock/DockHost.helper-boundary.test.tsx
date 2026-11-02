import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { dockPresentation } from '../shell/dock-catalog.js';
import { DockHost } from './DockHost.js';
import { openDockPane, resetDockStore } from './dock-store.js';

vi.mock('./FleetWorkspaceAutoOpen.js', () => ({
  FleetWorkspaceAutoOpen: () => { throw new Error('helper failed'); },
}));

beforeEach(() => {
  localStorage.clear();
  resetDockStore();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

it('keeps the dock mounted when the auto-open helper fails', () => {
  openDockPane('tasks');
  const noop = () => undefined;
  render(<DockHost presentation={dockPresentation(1440, 'right')} windowWidth={1440} columnWidth={440}
    session={null} seats={[]} events={[]} roots={[]} rootsData={null} rootsError={null} turnFiles={[]}
    otherRunning={[]} dispatchEnabled={false} onOpenSession={noop} onHandoff={noop} onOpenAccounts={noop}
    onSendToChat={noop} onAddToMessage={noop} />);

  expect(screen.getByRole('complementary', { name: 'Dock: Tasks' })).toBeInTheDocument();
  expect(screen.getByText('A dock helper failed and was turned off for this session.')).toHaveAttribute('role', 'status');
});
