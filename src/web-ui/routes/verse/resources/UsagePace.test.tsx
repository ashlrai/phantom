import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { UsagePace } from './UsagePace.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());
it('shows a fresh forecast once per pool and unknown for missing or stale evidence', async () => {
  stubSurfaceFetch({ routes: { '/api/verse/usage-resources': { pace: { v: 1, asOf: new Date().toISOString(), pools: [
    { pool: 'codex-personal', projectedPercent: 64, hoursLeft: 123.6 },
    { pool: 'claude', projectedPercent: null, hoursLeft: null },
  ] } } } });
  render(<UsagePace />);
  expect(await screen.findByText(/on pace to use 64% before reset \(123.6 h left\)/)).toBeVisible();
  const section = screen.getByRole('region', { name: 'Usage pace' });
  expect(within(section).getAllByRole('listitem')).toHaveLength(4);
  expect(within(section).getAllByRole('listitem').filter(row => row.textContent?.endsWith('unknown'))).toHaveLength(3);
});
