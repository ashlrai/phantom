import { Suspense } from 'react';
import './WhatsNewCard.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../sections/app-version.js';
import { OnboardingGate } from './OnboardingGate.js';
import { completeOnboarding, markReleaseSeen, resetOnboarding } from './onboarding-store.js';

const mocks = vi.hoisted(() => ({ notes: undefined as unknown }));
vi.mock('../../../data/hooks.js', () => ({
  useQuery: (def: { key: string }) => ({
    data: def.key.startsWith('verse-whats-new') ? mocks.notes : { sources: { runsDir: 'healthy' } },
  }),
}));
vi.mock('./OnboardingFlow.js', () => ({ OnboardingFlow: () => <h2>Tour</h2> }));
vi.mock('../dock/dock-store.js', () => ({ openFleetWorkspace: vi.fn() }));
vi.mock('../panes/index.js', () => ({ listPanes: () => [] }));
vi.mock('../verse-ui-store.js', () => ({ setVerseSection: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  resetOnboarding();
  completeOnboarding();
  markReleaseSeen('previous');
});
afterEach(cleanup);

async function showCard() {
  await act(async () => { render(<Suspense fallback={null}><OnboardingGate /></Suspense>); });
  await screen.findByRole('heading', { name: `What's new in Phantom ${APP_VERSION}` });
}

it('shows up to six changelog bullets, then "and N more", above the actions', async () => {
  mocks.notes = { version: APP_VERSION, bullets: Array.from({ length: 8 }, (_, i) => `Change ${i + 1}`) };
  await showCard();
  expect(screen.getByText('Change 1')).toBeTruthy();
  expect(screen.getByText('Change 6')).toBeTruthy();
  expect(screen.queryByText('Change 7')).toBeNull();
  expect(screen.getByText('and 2 more')).toBeTruthy();
  expect(screen.queryByText('Open Lanes, Merges and Queue as dock panes with /pane.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Later' })).toBeTruthy();
});

it.each([{ version: APP_VERSION, bullets: null }, undefined])('falls back to the presence copy for %j', async (notes) => {
  mocks.notes = notes;
  await showCard();
  expect(screen.getByText('Open Lanes, Merges and Queue as dock panes with /pane.')).toBeTruthy();
});
