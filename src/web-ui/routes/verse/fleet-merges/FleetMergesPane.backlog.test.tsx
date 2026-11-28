import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';
import { snapshot } from './merge-backlog-fixture.js';

afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });
function mount(failed = false) {
  const openPane = vi.fn();
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.includes('fleet-backlog') ? failed ? { source: 'gh-failed', reason: 'gh-pr-list-not-json', error: 'gh-pr-list-not-json' } : snapshot : { mergesLastHour: { count: 0, items: [] } }, { status: url.includes('fleet-backlog') && failed ? 503 : 200 })));
  render(<FleetMergesPane {...{ visible: true, host: { openPane } } as unknown as PaneProps} />);
  return openPane;
}
it('renders backlog rows, danger at half and the Outcomes navigation', async () => {
  const openPane = mount();
  expect(await screen.findByText('Hot files: fleet.ts in 2 of 4 DIRTY PRs')).toHaveAttribute('data-tone', 'danger');
  expect(screen.getByText('#2').closest('a')).toHaveAttribute('href', 'https://github.com/fake/repo/pull/2');
  fireEvent.click(screen.getAllByText('Recut in Outcomes')[0]!);
  expect(openPane).toHaveBeenCalledWith('fleet-outcomes');
});
it('shows the GitHub failure reason', async () => {
  mount(true);
  expect(await screen.findByText('GitHub read failed: gh-pr-list-not-json')).toBeInTheDocument();
});
it('discloses selected PR evidence without inventing conflict hunks or triggering actions', async () => {
  const openPane = mount();
  const summary = await screen.findByText('Merge evidence for #2', { selector: 'summary' });
  const details = summary.closest('details')!;
  expect(details).not.toHaveAttribute('open');
  fireEvent.click(summary);
  expect(details).toHaveAttribute('open');
  const row = within(details);
  expect(row.getByText('GitHub reports a merge conflict.', { exact: false })).toBeInTheDocument();
  expect(row.getByText('src/cli/fleet.ts')).toBeInTheDocument();
  expect(row.getByText('The snapshot does not identify conflicting lines.', { exact: false })).toBeInTheDocument();
  expect(row.getByText('Review a conflict recut in Outcomes.', { exact: false })).toBeInTheDocument();
  expect(row.queryByRole('button')).not.toBeInTheDocument();
  expect(openPane).not.toHaveBeenCalled();

  const other = screen.getByText('Merge evidence for #3', { selector: 'summary' });
  const otherDetails = other.closest('details')!;
  expect(otherDetails).toHaveAttribute('name', details.getAttribute('name'));
  fireEvent.click(other);
  expect(within(otherDetails).getByText('Reason unknown in this snapshot.', { exact: false })).toBeInTheDocument();
});
