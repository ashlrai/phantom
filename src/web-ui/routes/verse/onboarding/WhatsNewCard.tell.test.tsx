import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evict } from '../../../data/cache.js';
import { APP_VERSION } from '../sections/app-version.js';
import { WhatsNewCard } from './WhatsNewCard.js';

const mocks = vi.hoisted(() => ({ open: vi.fn(), seen: vi.fn() }));
vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: mocks.open }));
vi.mock('./onboarding-store.js', () => ({ markReleaseSeen: mocks.seen }));

afterEach(() => {
  cleanup();
  evict('verse-fleet-runs');
  vi.unstubAllGlobals();
});

it('opens the interject dialog before acknowledging the release when a fleet is present', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources: { runsDir: 'healthy' } })));
  render(<WhatsNewCard />);
  fireEvent.click(await screen.findByRole('button', { name: 'Tell the leaders' }));
  expect(mocks.open).toHaveBeenCalledExactlyOnceWith({ prefill: '' });
  expect(mocks.seen).toHaveBeenCalledExactlyOnceWith(APP_VERSION);
  expect(mocks.open.mock.invocationCallOrder[0]).toBeLessThan(mocks.seen.mock.invocationCallOrder[0]!);
});

it('does not offer to tell the leaders when the fleet is missing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ sources: { runsDir: 'missing' } })));
  render(<WhatsNewCard />);
  await screen.findByRole('button', { name: 'Open Settings ▸ Fleet sources' });
  expect(screen.queryByRole('button', { name: 'Tell the leaders' })).toBeNull();
});
