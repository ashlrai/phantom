import { Suspense } from 'react';
import './WhatsNewCard.js';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../sections/app-version.js';
import { OnboardingGate } from './OnboardingGate.js';
import { completeOnboarding, markReleaseSeen, replayOnboarding, resetOnboarding } from './onboarding-store.js';

const mocks = vi.hoisted(() => ({ open: vi.fn(), section: vi.fn(), panes: vi.fn() }));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: { sources: { runsDir: 'healthy' } } }) }));
vi.mock('./OnboardingFlow.js', () => ({ OnboardingFlow: () => <h2>Tour</h2> }));
vi.mock('../dock/dock-store.js', () => ({ openFleetWorkspace: mocks.open }));
vi.mock('../panes/index.js', () => ({ listPanes: mocks.panes }));
vi.mock('../verse-ui-store.js', () => ({ setVerseSection: mocks.section }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetOnboarding();
  completeOnboarding();
  markReleaseSeen('previous');
  mocks.panes.mockReturnValue([{ id: 'fleet-merges' }, { id: 'chat' }, { id: 'fleet-hub' }]);
});
afterEach(cleanup);

async function showCard() {
  await act(async () => { render(<Suspense fallback={null}><OnboardingGate /></Suspense>); });
  await screen.findByRole('heading', { name: `What's new in Phantom ${APP_VERSION}` });
}

it('renders the version and all four release highlights', async () => {
  await showCard();
  expect(screen.getByText('Open Lanes, Merges and Queue as dock panes with /pane.')).toBeTruthy();
  expect(screen.getByText('The Inbox pane sends messages to MASON-INBOX.md.')).toBeTruthy();
  expect(screen.getByText('The notification bell shows fleet, merge and update alerts.')).toBeTruthy();
  expect(screen.getByText('Pair a device to use the mobile remote at /verse/m/.')).toBeTruthy();
});

it.each(['Open fleet workspace', 'Later', 'Escape'])('%s acknowledges the release and removes the card', async (action) => {
  await showCard();
  if (action === 'Escape') fireEvent.keyDown(window, { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: action }));
  await waitFor(() => expect(screen.queryByRole('heading')).toBeNull());
  expect(JSON.parse(localStorage.getItem('ashlr.verse.onboarding.v1')!).seenRelease).toBe(APP_VERSION);
  if (action === 'Open fleet workspace') expect(mocks.open).toHaveBeenCalledWith(['fleet-hub', 'fleet-merges']);
  else expect(mocks.open).not.toHaveBeenCalled();
  expect(mocks.section).not.toHaveBeenCalled();
});

it('opens the fleet section when no fleet panes are registered', async () => {
  mocks.panes.mockReturnValue([{ id: 'chat' }]);
  await showCard();
  fireEvent.click(screen.getByRole('button', { name: 'Open fleet workspace' }));
  expect(mocks.section).toHaveBeenCalledWith('fleet');
  expect(mocks.open).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole('heading')).toBeNull());
});

it.each(['first run', 'replay'])('keeps the release card behind the %s tour', async (mode) => {
  if (mode === 'first run') resetOnboarding();
  else replayOnboarding();
  await act(async () => { render(<Suspense fallback={null}><OnboardingGate /></Suspense>); });
  await screen.findByRole('heading', { name: 'Tour' });
  expect(screen.queryByRole('button', { name: 'Open fleet workspace' })).toBeNull();
});
