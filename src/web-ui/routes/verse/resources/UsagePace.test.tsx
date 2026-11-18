import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { UsagePace } from './UsagePace.js';
import { poolShareSnapshot } from '../../../../core/usage/runway.js';

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());
it('shows a fresh forecast once per pool and unknown for missing or stale evidence', async () => {
  stubSurfaceFetch({ routes: { '/api/verse/usage-resources': { pace: { v: 1, asOf: new Date().toISOString(), pools: [
    { pool: 'codex-personal', projectedPercent: 64, hoursLeft: 123.6, recommendedSlots: 18 },
    { pool: 'claude', projectedPercent: null, hoursLeft: null },
  ] } } } });
  render(<UsagePace />);
  expect(await screen.findByText(/on pace to use 64% before reset \(123.6 h left\)/)).toBeVisible();
  expect(screen.getByText(/suggested running slots: 18/)).toBeVisible();
  const section = screen.getByRole('list', { name: 'Pace by pool' });
  expect(within(section).getAllByRole('listitem')).toHaveLength(4);
  expect(within(section).getAllByRole('listitem').filter(row => row.textContent?.endsWith('unknown'))).toHaveLength(3);
  // No shares from this (older) payload: the send-work line says unknown, never a guess.
  expect(within(screen.getByRole('list', { name: 'Where to send work' })).getByRole('listitem')).toHaveTextContent('Where to send work: unknown');
});

it('shows one plain send-work line per pool from the shares the API built', async () => {
  const none = { usedPercent: null, burnPerHour: null, hoursToReset: null };
  const shares = poolShareSnapshot([{ pool: 'zai', ...none }, { pool: 'gemini', ...none },
    { pool: 'claude', usedPercent: 1, burnPerHour: 0.1, hoursToReset: 50 },
    { pool: 'codex-personal', usedPercent: 97, burnPerHour: 1, hoursToReset: 72 }], null);
  stubSurfaceFetch({ routes: { '/api/verse/usage-resources': { pace: { v: 1, asOf: new Date().toISOString(), pools: [], shares } } } });
  render(<UsagePace />);
  const list = await screen.findByRole('list', { name: 'Where to send work' });
  await within(list).findByText('Claude: 99% left, resets in 50 h, send work here');
  expect(within(list).getAllByRole('listitem').map(row => row.textContent)).toEqual([
    'Claude: 99% left, resets in 50 h, send work here',
    'Codex personal: 3% left, runs dry in 3 h, resets in 72 h, top-priority work only',
    'Gemini: unknown (no usage reading)',
    'Zai: unknown (no usage reading)',
  ]);
});
