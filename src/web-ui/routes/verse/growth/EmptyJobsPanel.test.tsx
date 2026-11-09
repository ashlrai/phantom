import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { EmptyJobsPanel } from './EmptyJobsPanel.js';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows the shared report counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'jobs.empty.v1', hours: 24, total: 3, counts: { 'already-done': 2, 'blocked-by-env': 1, 'missing-input': 0, 'scope-too-cautious': 0, other: 0 }, jobs: [] }), { status: 200 })));
  render(<SectionVisibilityProvider visible><EmptyJobsPanel /></SectionVisibilityProvider>);
  expect(await screen.findByText('Already done: 2')).toBeInTheDocument();
  expect(screen.getByText('Environment blocked: 1')).toBeInTheDocument();
});
it('shows unavailable when the ledger cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
  render(<SectionVisibilityProvider visible><EmptyJobsPanel /></SectionVisibilityProvider>);
  expect(await screen.findByText('Job reasons are unavailable.')).toBeInTheDocument();
});
