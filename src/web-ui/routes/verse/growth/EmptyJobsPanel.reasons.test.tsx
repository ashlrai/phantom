import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { EmptyJobsPanel } from './EmptyJobsPanel.js';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const base = { schema: 'jobs.empty.v1', hours: 24, total: 13, counts: { 'already-done': 0, 'blocked-by-env': 0, 'missing-input': 0, 'scope-too-cautious': 0, other: 13 }, jobs: [] };
const show = (body: object) => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
  render(<SectionVisibilityProvider visible><EmptyJobsPanel /></SectionVisibilityProvider>);
};
it('renders reason chips with counts and a plain line per reason', async () => {
  show({ ...base, reasons: { by_reason: { limit: 7, 'lint-env': 3, interrupted: 1, blocked: 0, other: 2 }, recent: [] } });
  expect(await screen.findByText('limit 7 · lint-env 3 · other 2 · interrupted 1')).toBeInTheDocument();
  expect(screen.getByText(/lane hit its usage limit/)).toBeInTheDocument();
  expect(screen.queryByText(/reported it was blocked/)).toBeNull();
});
it('hides the row when reasons is absent (older server)', async () => {
  show(base);
  await screen.findByText('13 empty jobs');
  expect(screen.queryByLabelText('Why jobs ended empty')).toBeNull();
});
