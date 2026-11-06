import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { leaderCeoSummary } from './leader-ceo-model.js';
import { LeaderThreadPane } from './LeaderThreadPane.js';

const journal = {
  v: 1 as const, generatedAt: '2026-11-05T12:00:00Z',
  sources: { planLog: 'healthy' as const, orchestration: 'missing' as const, ingestLog: 'missing' as const, ingested: 'missing' as const },
  notes: [], ingest: [], ingested: [], rejectedLastHour: null,
  passes: [{ at: '2026-11-05T11:00:00Z', sections: [
    { title: 'CEO summary', bullets: ['Synthetic shipping summary', 'Synthetic next priority'] },
    { title: 'Current bottleneck', bullets: ['Synthetic fixture verification capacity'] },
  ] }, { at: '2026-11-04T11:00:00Z', sections: [{ title: 'CEO summary', bullets: ['Older fixture summary'] }] }],
};

beforeEach(() => evictAll());
afterEach(() => vi.unstubAllGlobals());

describe('Leader CEO overview', () => {
  it('shows the newest CEO lines, current bottleneck and measured lane health beside the durable outbox', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/ops/leader-journal': journal,
      '/api/verse/leader/thread': { messages: [] },
      '/api/verse/leader/directives': { directives: [] },
      '/api/verse/fleet/runs': { inbox: [], outbox: [{ at: '2026-11-05T11:30:00Z', text: 'Synthetic outbox reply' }] },
    } });
    render(<LeaderThreadPane visible />);
    const overview = screen.getByRole('region', { name: 'Leader overview' });
    expect(await within(overview).findByText('Synthetic shipping summary')).toBeInTheDocument();
    expect(within(overview).getByText('Synthetic next priority')).toBeInTheDocument();
    expect(within(overview).getByText(/Synthetic fixture verification capacity/)).toBeInTheDocument();
    expect(within(overview).queryByText('Older fixture summary')).not.toBeInTheDocument();
    expect(within(overview).getByText('Lane health')).toBeInTheDocument();
    expect(overview).toHaveTextContent(/calls? · .* errors · .* p50/);
    expect(await screen.findByText('Synthetic outbox reply')).toBeInTheDocument();
  });

  it('reports missing sources honestly and keeps the composer available', async () => {
    stubSurfaceFetch({ routes: {
      '/api/verse/ops/leader-journal': null,
      '/api/verse/leader': null,
      '/api/verse/fleet/live': null,
      '/api/verse/fleet/runs': { inbox: [] },
    } });
    render(<LeaderThreadPane visible />);
    expect(await screen.findByText('CEO summary unavailable.')).toBeInTheDocument();
    expect(screen.getByText(/Current bottleneck:/).closest('p')).toHaveTextContent('Current bottleneck: Unknown');
    expect(screen.getByText('Lane health unavailable.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reply to the Leader' })).toBeEnabled();
  });

  it('does not present stale plan data as a current CEO summary', () => {
    expect(leaderCeoSummary({ ...journal, sources: { ...journal.sources, planLog: 'degraded' } })).toEqual({ lines: [], bottleneck: null });
    expect(leaderCeoSummary(null)).toEqual({ lines: [], bottleneck: null });
  });
});
