import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { JobDetailSheet } from './JobDetailSheet.js';
import { RunsGraph } from './RunsGraph.js';

vi.mock('./JobDetailSheet.js', () => ({
  JobDetailSheet: vi.fn(({ job }: { job: string; onClose: () => void }) => <div data-testid="job-sheet">{job}</div>),
}));

beforeEach(() => {
  evictAll();
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({
    v: 1, workers: [{ job: 'RQ-PHX-FOO', lane: 'codex', repo: 'ashlrai/phantom' }], leaders: [],
    lanes: [{ lane: 'codex', running: 1, target: 2 }],
    mergesLastHour: { count: 1, items: [{ repo: 'ashlrai/phantom', number: 1719, title: 'A merge' }] }, switches: [],
  })));
});
afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('opens and closes worker details from a selected node', async () => {
  render(<RunsGraph />);
  const job = await screen.findByRole('button', { name: 'Inspect workspace node run:RQ-PHX-FOO' });
  fireEvent.click(job);
  const actions = screen.getByRole('group', { name: 'Selected node' });
  expect(within(actions).getByRole('button', { name: 'Open worker log' })).toBeInTheDocument();
  fireEvent.click(within(actions).getByRole('button', { name: 'Open details for RQ-PHX-FOO' }));
  expect(screen.getByTestId('job-sheet')).toHaveTextContent('RQ-PHX-FOO');
  act(() => { vi.mocked(JobDetailSheet).mock.lastCall![0].onClose(); });
  expect(screen.queryByTestId('job-sheet')).not.toBeInTheDocument();
});
