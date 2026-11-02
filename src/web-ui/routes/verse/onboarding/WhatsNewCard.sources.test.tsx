import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { getVerseUiState, resetVerseUi, VERSE_ANCHOR_EVENT } from '../verse-ui-store.js';
import { subscribeAnchorRequests } from '../shell/anchor-requests.js';
import { WhatsNewCard } from './WhatsNewCard.js';

const requests = vi.hoisted(() => vi.fn());
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: { sources: { runsDir: 'missing' } } }) }));
vi.mock('./onboarding-store.js', () => ({ markReleaseSeen: vi.fn() }));
vi.mock('../shell/anchor-requests.js', () => ({
  subscribeAnchorRequests: (eventName: string) => {
    const listener = (event: Event) => requests((event as CustomEvent<unknown>).detail);
    window.addEventListener(eventName, listener);
    return () => window.removeEventListener(eventName, listener);
  },
}));

afterEach(() => { cleanup(); resetVerseUi(); });

it('opens Settings and requests the Fleet sources anchor', () => {
  const unsubscribe = subscribeAnchorRequests(VERSE_ANCHOR_EVENT);
  render(<WhatsNewCard />);
  fireEvent.click(screen.getByRole('button', { name: 'Open Settings ▸ Fleet sources' }));
  expect(getVerseUiState().section).toBe('settings');
  expect(requests).toHaveBeenCalledExactlyOnceWith({ section: 'settings', anchor: 'fleet-sources' });
  unsubscribe();
});
