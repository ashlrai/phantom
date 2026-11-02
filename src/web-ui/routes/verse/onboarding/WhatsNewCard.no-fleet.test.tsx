import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WhatsNewCard } from './WhatsNewCard.js';
import { APP_VERSION } from '../sections/app-version.js';

const mocks = vi.hoisted(() => ({ data: undefined as unknown, section: vi.fn(), open: vi.fn(), seen: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: mocks.data }) }));
vi.mock('../verse-ui-store.js', () => ({ setVerseSection: mocks.section }));
vi.mock('../dock/dock-store.js', () => ({ openFleetWorkspace: mocks.open }));
vi.mock('../panes/index.js', () => ({ listPanes: vi.fn(() => []) }));
vi.mock('./onboarding-store.js', () => ({ markReleaseSeen: mocks.seen }));

beforeEach(() => { vi.clearAllMocks(); mocks.data = { sources: { runsDir: 'missing' } }; });
afterEach(cleanup);

it.each(['missing', 'unknown'])('opens Settings without fleet panes when presence is %s', presence => {
  if (presence === 'unknown') mocks.data = undefined;
  render(<WhatsNewCard />);
  expect(screen.queryByText(/Fleet workspace:|Leaders' inbox:/)).toBeNull();
  expect(screen.getByText('Update now in Settings ▸ Desktop')).toBeTruthy();
  expect(screen.getByText('Open dock panes with /pane; ⌘/ lists keyboard shortcuts.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: presence === 'missing' ? 'Open Settings ▸ Fleet sources' : 'Open Settings' }));
  if (presence === 'missing') expect(mocks.section).toHaveBeenCalledWith('settings', 'fleet-sources');
  else expect(mocks.section).toHaveBeenCalledWith('settings');
  expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.seen).toHaveBeenCalledWith(APP_VERSION);
});

it.each(['Later', 'Escape'])('still acknowledges with %s without navigating', action => {
  render(<WhatsNewCard />);
  if (action === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: action }));
  expect(mocks.seen).toHaveBeenCalledWith(APP_VERSION);
  expect(mocks.section).not.toHaveBeenCalled();
  expect(mocks.open).not.toHaveBeenCalled();
});
