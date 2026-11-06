import { act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clearMutationToken, markCheckComplete } from '../../../data/auth-store.js';
import { evictAll } from '../../../data/cache.js';
import { bootstrap } from '../fixtures.test-support.js';
import { resetResolvedForTest } from '../shell/resolved-store.js';
import { resetActivityForTest } from '../shell/useActivity.js';
import { activityResponse, needsItem, renderMobile, stubFetch } from './mobile.test-support.js';
import { MobileShell } from './MobileShell.js';

const originalSetAppBadge = Object.getOwnPropertyDescriptor(globalThis.navigator, 'setAppBadge');

beforeEach(() => {
  window.history.replaceState(null, '', '/verse/m/');
  evictAll();
  resetResolvedForTest();
  resetActivityForTest();
  clearMutationToken();
  act(() => markCheckComplete(true));
});

afterEach(() => {
  if (originalSetAppBadge) Object.defineProperty(globalThis.navigator, 'setAppBadge', originalSetAppBadge);
  else Reflect.deleteProperty(globalThis.navigator, 'setAppBadge');
  resetActivityForTest();
  clearMutationToken();
  act(() => markCheckComplete(false));
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
});

it('sets the app badge from the live needs-you count', async () => {
  const setAppBadge = vi.fn(async () => undefined);
  Object.defineProperty(globalThis.navigator, 'setAppBadge', { configurable: true, value: setAppBadge });
  stubFetch({
    'GET /api/verse/bootstrap': bootstrap(),
    'GET /api/verse/activity': activityResponse({ needsYou: [needsItem(), needsItem({ id: 'approvals:approval:p2' })] }),
  });
  const { unmount } = renderMobile(<MobileShell />);
  await waitFor(() => expect(setAppBadge).toHaveBeenCalledWith(2));
  unmount();
  expect(setAppBadge).toHaveBeenLastCalledWith(0);
});
