import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { apiGet } from '../../../data/client.js';
import { GoalsPane, resetPrBacklogBaseline } from './GoalsPane.js';

vi.mock('../../../data/client.js', async importOriginal => ({ ...await importOriginal<typeof import('../../../data/client.js')>(), apiGet: vi.fn() }));
const root = (name: string) => ({ path: `/x/${name}`, name, remote: { state: 'github', nameWithOwner: name, defaultBranch: 'main' } });
const mission = { schemaVersion: 1, state: 'steady', authority: 'read-only', briefing: null, sources: { briefing: null, goals: null, enrollment: null, proposals: null } };
beforeEach(() => { evictAll(); resetPrBacklogBaseline(); localStorage.clear(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { cleanup(); evictAll(); });

function stub(repos: unknown[], backlog: unknown) {
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === '/api/goals') return [];
    if (path === '/api/vision/mission') return mission;
    if (path === '/api/verse/github') return { observedAt: '', repos };
    if (path.includes('fleet-backlog')) return backlog;
    throw new Error(`unrouted ${path}`);
  });
}

it('renders the row with totals and opens Merges on click', async () => {
  stub([root('example-org/alpha')], { source: 'ok', items: [{ mergeStateStatus: 'DIRTY', updatedAt: null }, { mergeStateStatus: 'CLEAN', updatedAt: null }], counts: { mergeState: { DIRTY: 1, CLEAN: 1 } } });
  const openPane = vi.fn();
  render(<GoalsPane host={{ openPane } as never} />);
  expect(await screen.findByText('2 open · 1 DIRTY')).toBeInTheDocument();
  fireEvent.click(screen.getByText('Unresolved PRs across enrolled repos → 0'));
  expect(openPane).toHaveBeenCalledExactlyOnceWith('fleet-merges');
});

it('shows unknown, not 0, when no repo is enrolled', async () => {
  stub([], null);
  render(<GoalsPane />);
  const row = (await screen.findByText('Unresolved PRs across enrolled repos → 0')).closest('p')!;
  expect(row).toHaveTextContent('unknown');
  expect(row.textContent).not.toMatch(/\b0 open/);
});
