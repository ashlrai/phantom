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
      if (url.startsWith('/api/fleet-activity')) data = { recentMerges: [{ ts: '2026-01-02T00:00:00Z', repo: 'phantom', engine: 'agent' }], recentTicks: [], recentActions: [] };
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
    await waitFor(() => expect(screen.getByText('Merged in phantom')).toBeInTheDocument());
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('phantom')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause story' }));
    expect(screen.getByText('PAUSED')).toBeInTheDocument();
  });
  it('reports unavailable sources instead of presenting an empty fleet as fact', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 500 })));
    render(<ShowView />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('data sources unavailable'));
    expect(screen.getByText('Merge activity unavailable.')).toBeInTheDocument();
  });
});
