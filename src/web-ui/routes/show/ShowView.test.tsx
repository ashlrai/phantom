import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../data/cache.js';
import { ShowView } from './ShowView.js';

describe('ShowView', () => {
  beforeEach(() => {
    evictAll();
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      let data: unknown;
      if (url.startsWith('/api/fleet/lanes')) data = { lanes: [
        { lane: 'claude', credit: { state: 'observed', label: '64% weekly', remainingPct: 64, resetAt: null }, hold: null },
        { lane: 'codex', credit: { state: 'unknown', label: 'unknown', remainingPct: null, resetAt: null }, hold: null },
      ] };
      else if (url.startsWith('/api/fleet-activity')) data = {
        recentMerges: [{ ts: '2026-01-02T00:00:00Z', repo: 'phantom', engine: 'agent' }],
        recentTicks: [],
        recentActions: [{ ts: '2026-01-02T01:00:00Z', outcome: 'verified', action: 'verify', summary: 'Verified the change', repo: 'phantom' }],
      };
      else if (url.startsWith('/api/fleet')) data = { queue: { backlogItems: 7 }, merges: { recent: 3 } };
      else if (url.startsWith('/api/logs-observation')) data = { entries: [] };
      else if (url.startsWith('/api/runs')) data = [];
      else if (url.startsWith('/api/inbox')) data = { pending: 2, proposals: [] };
      else return new Response('missing', { status: 404 });
      return new Response(JSON.stringify(data), { status: 200 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());
  it('shows observed metrics and merges and lets the viewer pause', async () => {
    render(<ShowView />);
    await waitFor(() => expect(screen.getAllByText('Merged in phantom').length).toBeGreaterThan(0));
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getAllByText('phantom').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Pause story' }));
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });
  it('renders the agent feed, win feed and only observed quota gauges', async () => {
    render(<ShowView />);
    const feed = await screen.findByRole('region', { name: 'Agent feed' });
    await waitFor(() => expect(feed).toHaveTextContent('Verified the change'));
    expect(screen.getByRole('region', { name: 'Win feed' })).toHaveTextContent('Merged in phantom');
    const gauges = await screen.findByRole('region', { name: 'Quota gauges' });
    await waitFor(() => expect(gauges).toHaveTextContent('64% weekly'));
    expect(screen.getByRole('meter', { name: 'claude remaining' })).toHaveAttribute('aria-valuenow', '64');
    expect(gauges).not.toHaveTextContent('codex');
  });
  it('reports unavailable sources instead of presenting an empty fleet as fact', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
    render(<ShowView />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('data sources unavailable'));
    expect(screen.getByText('Merge activity unavailable.')).toBeInTheDocument();
    expect(screen.getByText('Quota readings unavailable.')).toBeInTheDocument();
  });
});
