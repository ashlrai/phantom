import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WorklogView } from './WorklogView.js';

vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn(async (path: string) => {
  if (path !== '/api/worklog') throw new Error('Unexpected path');
  return { malformedLines: 0, entries: [
    { job: 'J1', repo: 'phantom', lane: 'work', model: 'm', mergedAt: '2026-11-09', openToMergeSeconds: 60, url: null },
    { job: 'J2', repo: 'locus', lane: 'work', model: 'm', mergedAt: '2026-11-09', openToMergeSeconds: 120, url: null },
    { job: 'J3', repo: 'phantom', lane: 'fast', model: null, mergedAt: '2026-11-09', openToMergeSeconds: null, url: null },
  ] };
}) }));

describe('Work log lane summary', () => {
  it('summarizes the filtered API entries and selects a lane', async () => {
    render(<WorklogView />);
    const heading = await screen.findByRole('heading', { name: 'By lane' });
    const table = heading.nextElementSibling as HTMLElement;
    expect(within(table).getByRole('button', { name: 'work' }).closest('tr')?.textContent).toContain('work21 min0m');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'phantom' } });
    expect(within(table).getByRole('button', { name: 'work' }).closest('tr')?.textContent).toContain('work11 min0m');
    fireEvent.click(within(table).getByRole('button', { name: 'fast' }));
    expect((screen.getByLabelText('Lane') as HTMLSelectElement).value).toBe('fast');
    expect(within(table).queryByRole('button', { name: 'work' })).toBeNull();
    expect(screen.queryByText('J1')).toBeNull();
  });
});
