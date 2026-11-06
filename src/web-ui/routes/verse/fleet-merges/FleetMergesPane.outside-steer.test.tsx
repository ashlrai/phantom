import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { openInterjectDialog } from '../fleet/interject-dialog-store.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetMergesPane } from './FleetMergesPane.js';

vi.mock('../fleet/interject-dialog-store.js', () => ({ openInterjectDialog: vi.fn() }));

const merges = { mergesLastHour: { count: 0, items: [] }, publishesLastHour: [], lanes: [], sources: { merges: 'healthy' } };
const outside = {
  sourceState: 'healthy', repos: [{ repo: 'acme/widgets', prs: [
    { number: 43, title: 'Separate change', author: 'example', head: 'feature/separate', updatedAt: '2026-10-31T12:00:00Z', files: ['other.ts'], overlaps: [] },
    { number: 42, title: 'Shared change', author: 'example', head: 'feature/shared', updatedAt: '2026-10-31T11:00:00Z', files: ['a.ts', 'b.ts', 'c.ts'], overlaps: [{ job: 'RQ-PHX-ABC31', paths: ['a.ts', 'b.ts', 'c.ts'] }] },
  ] }],
};

function stubFetch(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url === '/api/verse/fleet/live/outside-prs' ? body : merges)));
}

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('puts the collision first and opens an interjection with its PR and shared paths', async () => {
  stubFetch(outside);
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  const list = within(await screen.findByRole('list', { name: 'Outside PRs' }));
  const rows = list.getAllByRole('listitem');
  expect(rows[0]).toHaveTextContent('acme/widgets #42');
  expect(rows[1]).toHaveTextContent('acme/widgets #43');
  expect(screen.getByText('1 outside PR touches files of running jobs')).toBeInTheDocument();
  within(rows[0]!).getByRole('button', { name: 'Steer RQ-PHX-ABC31 about PR #42' }).click();
  expect(openInterjectDialog).toHaveBeenCalledWith({ prefill: expect.stringContaining('RQ-PHX-ABC31') });
  const prefill = vi.mocked(openInterjectDialog).mock.calls[0]![0]!.prefill!;
  expect(prefill).toContain('#42');
  for (const path of ['a.ts', 'b.ts', 'c.ts']) expect(prefill).toContain(path);
});

it('reports missing gh and offers no steer action even if stale PRs are present', async () => {
  stubFetch({ ...outside, sourceState: 'missing' });
  render(<FleetMergesPane {...{ visible: true } as PaneProps} />);
  expect(await screen.findByText('Outside PRs unread (gh missing)')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Steer .* about PR/ })).not.toBeInTheDocument();
});
