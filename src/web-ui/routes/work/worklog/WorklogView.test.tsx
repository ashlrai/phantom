import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorklogView } from './WorklogView.js';
vi.mock('../../../data/hooks.js', () => ({ useQuery: () => ({ data: { malformedLines: 1, entries: [
  { job: 'J1', repo: 'phantom', lane: 'work', model: null, mergedAt: '2026-11-09', openToMergeSeconds: 42, url: null },
  { job: 'J2', repo: 'locus', lane: 'fast', model: 'm', mergedAt: '2026-11-08', openToMergeSeconds: null, url: null },
] } }) }));
describe('Work log', () => {
  it('filters by repo and lane and shows missing fields', () => {
    render(<WorklogView />);
    expect(screen.getByText('1 malformed lines skipped.')).toBeTruthy();
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'phantom' } });
    expect(screen.queryByText('J2')).toBeNull();
    fireEvent.change(screen.getByLabelText('Lane'), { target: { value: 'fast' } });
    expect(screen.queryByText('J1')).toBeNull();
  });
});
