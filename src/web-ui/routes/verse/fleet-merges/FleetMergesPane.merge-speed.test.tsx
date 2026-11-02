import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

const props = { visible: true } as PaneProps;
const item = { repo: 'org/repo', number: 1, title: 'Fix' };
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); evictAll(); });

it('shows the duration in the row and aggregate speed beside the count', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mergesLastHour: { count: 1, perHour: 42, medianOpenToMergeMs: 1_860_000, items: [{ ...item, openToMergeMs: 720_000 }] }, sources: { merges: 'healthy' } })));
  render(<FleetMergesPane {...props} />);
  expect(await screen.findByText('median 31 min · 42/h')).toBeInTheDocument();
  expect(screen.getByText(/1 merged in the last hour/)).toBeInTheDocument();
  expect(within(screen.getByRole('list', { name: 'Merged PRs' })).getByRole('listitem')).toHaveTextContent('open → merge 12 min');
});

it('reports missing timing without inventing a row duration', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ mergesLastHour: { count: 1, items: [item] }, publishesLastHour: [{ at: '2026-11-01T04:00:00Z', url: 'https://github.com/org/repo/pull/1' }], sources: { merges: 'healthy' } })));
  render(<FleetMergesPane {...props} />);
  expect(await screen.findByText(/no timing in this snapshot yet/)).toBeInTheDocument();
  const row = within(screen.getByRole('list', { name: 'Merged PRs' })).getByRole('listitem');
  expect(row).toHaveTextContent('merged');
  expect(row).not.toHaveTextContent('open → merge');
});
