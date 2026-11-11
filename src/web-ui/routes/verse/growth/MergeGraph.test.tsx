import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MergeGraph } from './MergeGraph.js';
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ status: 'ready', data: { schema: 'metrics.merges.v1', known: true, lanes: [{ lane: 'work', buckets: [{ start: '2026-11-09T11:00:00.000Z', merges: 0, medianSeconds: null }] }] } }) }));
describe('merge graph', () => {
  it('shows zero merges and unknown missing median values', () => {
    render(<MergeGraph />);
    expect(screen.getByLabelText('Lane')).toHaveValue('work');
    expect(screen.getByRole('cell', { name: '0', hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'unknown', hidden: true })).toBeInTheDocument();
  });
});
