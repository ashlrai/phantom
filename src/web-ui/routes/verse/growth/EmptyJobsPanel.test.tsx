import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { EmptyJobsPanel } from './EmptyJobsPanel.js';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('shows the shared report counts', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ schema: 'jobs.empty.v1', hours: 24, total: 3, counts: { duplicate: 2, 'already-done': 1, 'blocked-by-env': 0, 'missing-input': 0, 'scope-too-cautious': 0, other: 0 }, jobs: [], topCauses: [{ class: 'duplicate', label: 'Duplicate of an earlier job', count: 2, exampleJob: 'J2' }, { class: 'already-done', label: 'Work already done', count: 1, exampleJob: 'J1' }] }), { status: 200 })));
  render(<SectionVisibilityProvider visible><EmptyJobsPanel /></SectionVisibilityProvider>);
  expect(await screen.findByText('Duplicate of an earlier job: 2 · Example: J2')).toBeInTheDocument();
  expect(screen.getByText('Work already done: 1 · Example: J1')).toBeInTheDocument();
});
it('shows unavailable when the ledger cannot be read', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })));
  render(<SectionVisibilityProvider visible><EmptyJobsPanel /></SectionVisibilityProvider>);
  expect(await screen.findByText('Job reasons are unavailable.')).toBeInTheDocument();
});
