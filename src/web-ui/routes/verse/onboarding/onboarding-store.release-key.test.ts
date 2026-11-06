import { expect, it } from 'vitest';
import { releaseKey, whatsNewPending } from './onboarding-store.js';

it.each([['3.30.0', '3.30'], ['3.29.15', '3.29'], ['3.30.1', '3.30'], [null, null], ['invalid', null]])('releaseKey(%s) = %s', (version, expected) => {
  expect(releaseKey(version)).toBe(expected);
});

it('does not repeat the copy for patch upgrades', () => {
  expect(whatsNewPending({ completedAt: 'yesterday', dismissedAt: null, seenRelease: '3.30.0' }, '3.30.1')).toBe(false);
});

it('offers the new minor release to a 3.29.15 upgrader', () => {
  expect(whatsNewPending({ completedAt: null, dismissedAt: 'yesterday', seenRelease: '3.29.15' }, '3.30.0')).toBe(true);
});

it('never offers release copy on first run', () => {
  expect(whatsNewPending({ completedAt: null, dismissedAt: null, seenRelease: '3.29.15' }, '3.30.0')).toBe(false);
});
