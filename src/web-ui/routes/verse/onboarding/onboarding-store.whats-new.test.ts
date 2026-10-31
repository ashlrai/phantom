import { beforeEach, expect, it, vi } from 'vitest';
import { APP_VERSION } from '../sections/app-version.js';
import { completeOnboarding, dismissOnboarding, getOnboardingState, markReleaseSeen, resetOnboarding, VERSE_ONBOARDING_STORAGE_KEY, whatsNewPending } from './onboarding-store.js';

beforeEach(() => { localStorage.clear(); resetOnboarding(); });

it('offers an unseen release only after the tour has been answered', () => {
  const record = { completedAt: null, dismissedAt: null, seenRelease: null };
  expect(whatsNewPending(record, APP_VERSION)).toBe(false);
  expect(whatsNewPending({ ...record, completedAt: 'yesterday' }, APP_VERSION)).toBe(true);
  expect(whatsNewPending({ ...record, dismissedAt: 'yesterday' }, APP_VERSION)).toBe(true);
});

it.each([completeOnboarding, dismissOnboarding])('answering the tour acknowledges the current release', (answer) => {
  answer();
  expect(getOnboardingState().seenRelease).toBe(APP_VERSION);
  expect(whatsNewPending(getOnboardingState(), APP_VERSION)).toBe(false);
});

it('persists acknowledgment across reloads and offers the next release', async () => {
  completeOnboarding();
  markReleaseSeen('next');
  expect(JSON.parse(localStorage.getItem(VERSE_ONBOARDING_STORAGE_KEY)!)).toMatchObject({ seenRelease: 'next' });
  vi.resetModules();
  const fresh = await import('./onboarding-store.js');
  expect(fresh.whatsNewPending(fresh.getOnboardingState(), 'next')).toBe(false);
  expect(fresh.whatsNewPending(fresh.getOnboardingState(), 'future')).toBe(true);
});

it('loads a legacy completed tour with a null release', async () => {
  localStorage.setItem(VERSE_ONBOARDING_STORAGE_KEY, JSON.stringify({ completedAt: 'yesterday', dismissedAt: null }));
  vi.resetModules();
  const fresh = await import('./onboarding-store.js');
  expect(fresh.getOnboardingState().seenRelease).toBeNull();
  expect(fresh.whatsNewPending(fresh.getOnboardingState(), APP_VERSION)).toBe(true);
});
