import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { WorkersCard } from './WorkersCard.js';

const snapshot = { v: 1, generatedAt: 'now', sources: { workers: 'healthy', runsDir: 'healthy' },
  workers: [], publishesLastHour: [], switches: [], paused: false };
beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); });

it.each([
  [{ switches: ['HOLD'] }, 'Dispatch is paused by HOLD', 'danger'],
  [{ paused: true }, 'The dispatcher is paused', 'warning'],
  [{ sources: { workers: 'healthy', runsDir: 'missing' } }, 'No fleet on this Mac yet (~/.ashlr-runs not found)', 'neutral'],
  [{}, 'No workers running. Leaders write jobs every 15 minutes.', 'neutral'],
])('renders the empty reason for %o', async (overrides, text, tone) => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot, ...overrides })));
  render(<SectionVisibilityProvider visible><WorkersCard /></SectionVisibilityProvider>);
  expect(await screen.findByText(text)).toHaveAttribute('data-tone', tone);
});

it('shows the short lane label with the original id as its title', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...snapshot,
    workers: [{ job: 'job-one', repo: 'repo', lane: 'personal', tier: 'mid', ageSeconds: 10 }] })));
  render(<SectionVisibilityProvider visible><WorkersCard /></SectionVisibilityProvider>);
  expect(await screen.findByText('PERS')).toHaveAttribute('title', 'personal');
});
