import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { FleetQueuePane } from './FleetQueuePane.js';
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it.each([true, false])('renders optional drop jobs when route present=%s', async present => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/drop-jobs')) return Response.json(present ? { v: 1, items: [{ id: 'ABC', lane: 'devin', tier: 'mid', title: 'Useful job', bytes: 60, ageSeconds: 120 }] } : {}, { status: present ? 200 : 404 });
    if (url.includes('/queue?')) return Response.json({ v: 1, generatedAt: '2026-11-01', sources: { ready: 'healthy', skips: 'healthy' }, total: 0, ready: 0, parked: 0, malformed: 0, skipsLast24h: null, byLane: [], groups: [], skips: [] });
    return Response.json({}, { status: 404 });
  }));
  render(<FleetQueuePane {...{ visible: true } as PaneProps} />);
  const button = await screen.findByRole('button', { name: 'New job' });
  if (present) {
    expect(await within(await screen.findByRole('region', { name: 'Waiting in drop' })).findByText('ABC · devin · mid · Useful job · 2 min ago')).toBeInTheDocument();
    expect(button).toBeEnabled();
  } else {
    await waitFor(() => expect(button).toHaveAttribute('title', 'Update Phantom to write jobs from here'));
    expect(button).toBeDisabled();
    expect(screen.queryByRole('region', { name: 'Waiting in drop' })).not.toBeInTheDocument();
  }
});
