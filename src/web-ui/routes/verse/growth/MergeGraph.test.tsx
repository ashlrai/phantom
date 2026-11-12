import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MergeGraph, mergeGraphQuery } from './MergeGraph.js';

const state = vi.hoisted(() => ({ result: { status: 'ready', data: undefined as unknown } }));
const apiGet = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => state.result }));
vi.mock('../../../data/client.js', () => ({ apiGet }));

describe('merge graph', () => {
  beforeEach(() => { apiGet.mockClear(); });

  it('reads the fleet-control merge-graph route', async () => {
    await mergeGraphQuery.fetch();
    expect(apiGet).toHaveBeenCalledWith('/api/verse/fleet/control/merge-graph', undefined);
  });

  it('shows zero merges and unknown missing median values', () => {
    state.result = { status: 'ready', data: { schema: 'metrics.merges.v1', known: true, lanes: [{ lane: 'work', buckets: [{ start: '2026-11-09T11:00:00.000Z', merges: 0, medianSeconds: null }] }] } };
    render(<MergeGraph />);
    expect(screen.getByLabelText('Lane')).toHaveValue('work');
    expect(screen.getByRole('cell', { name: '0', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'unknown', hidden: true })).toBeInTheDocument();
  });

  it('says unknown, with no lane picker or table, when the ledger is unreadable', () => {
    state.result = { status: 'ready', data: { schema: 'metrics.merges.v1', known: false, lanes: null } };
    render(<MergeGraph />);
    expect(screen.queryByLabelText('Lane')).toBeNull();
    expect(screen.queryByText('Hourly values')).toBeNull();
    expect(screen.getAllByText(/Merge data is unknown\./).length).toBeGreaterThan(0);
  });
});
