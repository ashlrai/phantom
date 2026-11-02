import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

const mergesFixture = () => ({
  mergesLastHour: { count: 0, items: [] },
  publishesLastHour: [],
  lanes: [],
  sources: { merges: 'healthy' },
});

const outsideFixture = () => ({
  v: 1,
  generatedAt: '2026-10-31T12:00:00Z',
  sourceState: 'healthy',
  repos: [{
    repo: 'acme/widgets',
    state: 'healthy',
    prs: [{
      number: 42,
      title: 'outside change',
      author: 'mason',
      head: 'feature/touch-a',
      updatedAt: '2026-10-31T11:00:00Z',
      files: ['src/a.ts', 'src/b.ts'],
      overlaps: [{ job: 'RQ-FAKE-1', paths: ['src/a.ts'] }],
    }],
  }],
});

function stubFetch(outsideBody: unknown = outsideFixture()) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    Response.json(url === '/api/verse/fleet/live/outside-prs' ? outsideBody : mergesFixture())));
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('renders the outside PR row and a collision chip that opens the job log', async () => {
  stubFetch();
  const openPane = vi.fn();
  const props = { visible: true, host: { openPane } } as unknown as PaneProps;
  render(<FleetMergesPane {...props} />);
  const list = within(await screen.findByRole('list', { name: 'Outside PRs' }));
  const row = list.getAllByRole('listitem')[0]!;
  expect(within(row).getByRole('link', { name: 'acme/widgets #42' })).toHaveAttribute('href', 'https://github.com/acme/widgets/pull/42');
  expect(row).toHaveTextContent('outside change');
  expect(row).toHaveTextContent('mason');
  const chip = within(row).getByRole('button', { name: /collides with RQ-FAKE-1/ });
  chip.click();
  expect(openPane).toHaveBeenCalledWith('worker-log');
});

it('renders no collision chip when the outside PR touches other files', async () => {
  stubFetch({ ...outsideFixture(), repos: [{ ...outsideFixture().repos[0]!, prs: [{ ...outsideFixture().repos[0]!.prs[0]!, overlaps: [] }] }] });
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  const list = within(await screen.findByRole('list', { name: 'Outside PRs' }));
  expect(list.queryByRole('button', { name: /collides with/ })).not.toBeInTheDocument();
});

it('reports a missing gh and hides the section when the route is absent', async () => {
  stubFetch({ v: 1, generatedAt: '2026-10-31T12:00:00Z', sourceState: 'missing', repos: [] });
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('Outside PR check unavailable (gh missing).')).toBeInTheDocument();
  cleanup();
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === '/api/verse/fleet/live/outside-prs' ? Response.json({}, { status: 404 }) : Response.json(mergesFixture())));
  evictAll();
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  await screen.findByText('No merged PRs reported.');
  expect(screen.queryByText('Outside PRs')).not.toBeInTheDocument();
});
