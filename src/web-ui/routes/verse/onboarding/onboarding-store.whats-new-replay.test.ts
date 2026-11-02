/**
 * onboarding-store.whats-new-replay.test.ts — Settings ▸ "Show what's new
 * again": clearing the acknowledged release re-arms the card without
 * touching the tour's stored answer or opening the flow.
 */
import { beforeEach, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../sections/app-version.js';
import {
  VERSE_ONBOARDING_STORAGE_KEY,
  dismissOnboarding,
  completeOnboarding,
  getOnboardingState,
  markReleaseSeen,
  replayOnboarding,
  replayWhatsNew,
  resetOnboarding,
  subscribeOnboarding,
  whatsNewPending,
  whatsNewSeen,
} from './onboarding-store.js';

beforeEach(() => {
  localStorage.clear();
  resetOnboarding();
});

it('clears the acknowledged release so the card returns, and persists that', () => {
  // The card is never owed on a first run (whatsNewPending is false while
  // completedAt and dismissedAt are both null), so the tour must be answered
  // before a "seen" release means anything.
  dismissOnboarding();
  markReleaseSeen('3.30.0');
  expect(whatsNewPending(getOnboardingState(), '3.30.0')).toBe(false);

  const listener = vi.fn();
  subscribeOnboarding(listener);
  replayWhatsNew();

  expect(listener).toHaveBeenCalledTimes(1);
  const state = getOnboardingState();
  expect(state.seenRelease).toBeNull();
  expect(whatsNewPending(state, APP_VERSION)).toBe(true);
  expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toMatchObject({ seenRelease: null });
  // The stored tour answer survives: this cannot re-arm the first run.
  expect(state.dismissedAt).not.toBeNull();
});

it('collapses the tour back to the chip if it is showing, without closing or answering it', () => {
  completeOnboarding();
  markReleaseSeen(APP_VERSION);
  replayOnboarding();
  expect(getOnboardingState()).toMatchObject({ open: true, expanded: true });

  replayWhatsNew();
  const state = getOnboardingState();
  expect(state.open).toBe(true);
  expect(state.expanded).toBe(false);
  expect(state.completedAt).not.toBeNull();
  expect(whatsNewPending(state, APP_VERSION)).toBe(true);
});

it('leaves a closed tour closed', () => {
  dismissOnboarding();
  replayWhatsNew();
  expect(getOnboardingState().open).toBe(false);
});

it('does nothing — and notifies nothing — when the card is already owed', () => {
  dismissOnboarding();
  replayWhatsNew();
  expect(whatsNewPending(getOnboardingState(), APP_VERSION)).toBe(true);

  const listener = vi.fn();
  subscribeOnboarding(listener);
  replayWhatsNew();
  expect(listener).not.toHaveBeenCalled();
  expect(whatsNewPending(getOnboardingState(), APP_VERSION)).toBe(true);
});

it.each([
  { seenRelease: null, completedAt: null, dismissedAt: null },
  { seenRelease: null, completedAt: null, dismissedAt: 'yesterday' },
  { seenRelease: null, completedAt: 'yesterday', dismissedAt: null },
  { seenRelease: APP_VERSION, completedAt: null, dismissedAt: 'yesterday' },
  { seenRelease: '3.29.0', completedAt: 'yesterday', dismissedAt: null },
])('whatsNewSeen mirrors whatsNewPending for record %j', (record) => {
  expect(whatsNewSeen(record, APP_VERSION)).toBe(!whatsNewPending(record, APP_VERSION));
});
