import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { EmptyJobsPanel } from './EmptyJobsPanel.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const base = { schema: 'jobs.empty.v1', hours: 24, total: 13, counts: { duplicate: 0, 'already-done': 0, 'blocked-by-env': 0, 'missing-input': 0, 'scope-too-cautious': 0, other: 13 }, jobs: [], topCauses: [{ class: 'other', label: 'Unknown reason', count: 13, exampleJob: 'J1' }] };
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
  await screen.findByText('13 empty jobs in the last 24 hours');
  expect(screen.queryByLabelText('Why jobs ended empty')).toBeNull();
});

it('shows family and lane advice and every job at 390 px', async () => {
  vi.stubGlobal('innerWidth', 390);
  const group = { name: 'RECUT*', total: 1, topReason: 'already-on-master', suggestion: 'stop queuing this family' };
  show({ ...base, total: 1, diagnosis: { families: [group], lanes: [{ ...group, name: 'work' }],
    jobs: [{ id: 'RECUTCOREC541', lane: 'work', family: 'RECUT*', reason: 'already-on-master' }] } });
  const panel = screen.getByRole('region', { name: 'Why jobs end empty' });
  expect(panel.querySelector('table')).toBeNull();
  const css = readFileSync(resolve('src/web-ui/routes/verse/growth/EmptyJobsPanel.module.css'), 'utf8');
  expect(css).toContain('min-width: 0; overflow-wrap: anywhere;');
  expect(css).toContain('min-height: 44px;');
  expect(await screen.findByText('By family')).toBeInTheDocument();
  expect(screen.getByText('By lane')).toBeInTheDocument();
  expect(screen.getAllByText(/Next: stop queuing this family/)).toHaveLength(2);
  expect(screen.getByText('RECUTCOREC541 (work): already-on-master')).toBeInTheDocument();
  expect(screen.queryByText(/Unknown reason/)).toBeNull();
});

it('renders the complete empty state', async () => {
  show({ ...base, total: 0, topCauses: [], diagnosis: { jobs: [], families: [], lanes: [] } });
  expect(await screen.findByText('No empty jobs in this period.')).toBeInTheDocument();
  expect(screen.queryByText('Reasons for each job')).toBeNull();
});

it('isolates malformed diagnosis data', async () => {
  show({ ...base, diagnosis: { jobs: [], families: [null], lanes: [] } });
  expect(await screen.findByText('Job reasons are unavailable.')).toBeInTheDocument();
});
