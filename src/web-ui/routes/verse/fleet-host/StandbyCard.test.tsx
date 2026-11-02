import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { StandbyCard } from './StandbyCard.js';
const base = { v: 1, generatedAt: '2026-11-02T00:00:00Z' };
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it.each([
  [{ ...base, configured: false }, 'Second computer: not set up. Run ashlr fleet standby --help.', 'muted'],
  [{ ...base, configured: true, available: true, ready: true, blocker: null, leaseHolder: 'primary-fake', snapshotAgeSec: 240 }, 'Second computer can take over. Up to 4m of work would be lost.', 'ok'],
])('renders a mocked reading without buttons', async (body, text, tone) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
  render(<StandbyCard visible />);
  expect(await screen.findByText(text as string)).toHaveAttribute('data-tone', tone);
  expect(screen.queryByRole('button')).toBeNull();
});
