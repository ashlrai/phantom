import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
