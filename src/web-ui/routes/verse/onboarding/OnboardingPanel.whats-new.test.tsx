/**
 * OnboardingPanel.whats-new.test.tsx — Settings ▸ "Show what's new again":
 * the row re-arms the release card after a "Later" or Escape, then disables
 * itself while the card is owed — and never while the tour is on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { APP_VERSION } from '../sections/app-version.js';
import { resetVerseUi } from '../verse-ui-store.js';
import {
  completeOnboarding,
  dismissOnboarding,
  getOnboardingState,
  markReleaseSeen,
  replayOnboarding,
  replayWhatsNew,
  resetOnboarding,
  whatsNewPending,
} from './onboarding-store.js';
import { OnboardingPanel } from './OnboardingPanel.js';

beforeEach(() => {
  localStorage.clear();
  evictAll();
  resetVerseUi();
  resetOnboarding();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"not found"}', { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('OnboardingPanel — show what\'s new again', () => {
  it('re-arms the card once the release was seen, then reports it not dismissed yet', () => {
    completeOnboarding();
    markReleaseSeen(APP_VERSION);
    render(<OnboardingPanel />);

    const show = screen.getByRole('button', { name: 'Show' });
    expect(show).toBeEnabled();
    expect(screen.getByText(new RegExp(`'What's new in Phantom ${APP_VERSION}' card`))).toBeInTheDocument();
    expect(screen.getByText(/Seen\./)).toBeInTheDocument();

    fireEvent.click(show);

    expect(whatsNewPending(getOnboardingState(), APP_VERSION)).toBe(true);
    expect(show).toBeDisabled();
    expect(screen.getByText(/Not dismissed yet\./)).toBeInTheDocument();
  });

  it('is disabled while the card is already owed', () => {
    dismissOnboarding();
    replayWhatsNew();
    render(<OnboardingPanel />);
    expect(screen.getByRole('button', { name: 'Show' })).toBeDisabled();
    expect(screen.getByText(/Not dismissed yet\./)).toBeInTheDocument();
  });

  it('is disabled while the tour is on screen', () => {
    completeOnboarding();
    markReleaseSeen(APP_VERSION);
    replayOnboarding();
    render(<OnboardingPanel />);
    expect(screen.getByRole('button', { name: 'Show' })).toBeDisabled();
  });
});
