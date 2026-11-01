import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll, getQuerySnapshot } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';
import { snapshot } from './merge-backlog-fixture.js';

const pairs = [
  { open: 2, openTitle: 'Fake old change', openState: 'DIRTY', mergedBy: 20, mergedTitle: 'Fake merged change', jobId: 'RQ-FAKE-ONE' },
  { open: 1, openTitle: 'Fake old clean change', openState: 'CLEAN', mergedBy: 21, mergedTitle: 'Fake merged clean change', jobId: 'RQ-FAKE-TWO' },
];

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

function mount(source: 'ok' | 'unavailable') {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(
    url.includes('fleet-backlog') ? snapshot : url.endsWith('/runs/superseded')
      ? { v: 1, generatedAt: '2026-11-01T00:00:00Z', source, openDirty: 4, pairs }
      : { mergesLastHour: { count: 0, items: [] } },
  )));
  render(<FleetMergesPane {...{ visible: true, host: { openPane: vi.fn() } } as unknown as PaneProps} />);
}

it('marks matching rows and separates superseded PRs from live DIRTY PRs', async () => {
  mount('ok');
  expect(await screen.findByText('2 superseded')).toBeInTheDocument();
  const backlog = within(screen.getByRole('list', { name: 'Merge backlog' }));
  const row = backlog.getByRole('link', { name: '#2' }).closest('li')!;
  expect(within(row).getByRole('link', { name: 'superseded by #20 (merged)' })).toHaveAttribute('href', 'https://github.com/fake/repo/pull/20');
  expect(screen.getByText('2 superseded').closest('p')).toHaveTextContent('3 open PRs · 3 DIRTY · 2 superseded · 0 BEHIND · 1 CLEAN');
  expect(backlog.getByRole('link', { name: '#3' }).closest('li')).not.toHaveTextContent('superseded');
});

it('keeps the original backlog display when the source is unavailable', async () => {
  mount('unavailable');
  expect(await screen.findByText('3 open PRs · 4 DIRTY · 0 BEHIND · 1 CLEAN')).toBeInTheDocument();
  await waitFor(() => expect(getQuerySnapshot('verse-fleet-superseded').status).toBe('success'));
  expect(screen.queryByText(/superseded/)).not.toBeInTheDocument();
});
