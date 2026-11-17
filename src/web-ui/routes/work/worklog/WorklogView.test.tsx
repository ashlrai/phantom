import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiGet } from '../../../data/client.js';
import { evictAll } from '../../../data/cache.js';
import type { WorklogEntry, WorklogReport } from '../../../../core/fleet/worklog.js';
import { WorklogView } from './WorklogView.js';
vi.mock('../../../data/client.js', () => ({ apiGet: vi.fn() }));
const entry = (kind: WorklogEntry['kind'], job: string, repo = 'phantom', lane = 'work'): WorklogEntry => ({
  kind, job, repo, lane, model: null, at: '2026-11-09T10:00:00Z', mergedAt: kind === 'merged' ? '2026-11-09T10:00:00Z' : null, openToMergeSeconds: null, url: null,
});
const report = (entries: WorklogEntry[] = []): WorklogReport => ({ schema: 'worklog.v2', malformedLines: 1, entries });
beforeEach(() => { evictAll(); vi.mocked(apiGet).mockReset(); });
afterEach(() => { vi.useRealTimers(); });
describe('Work log', () => {
  it('renders each event type and filters by repo and lane', async () => {
    vi.mocked(apiGet).mockResolvedValue(report([
      entry('merged', 'J1'), entry('pr', 'J2'), entry('empty', 'J3'), entry('failed', 'J4'), entry('finished', 'J5'), entry('launch', 'J6', 'locus', 'fast'),
    ]));
    render(<WorklogView />);
    const table = await screen.findByRole('table', { name: 'Work events' });
    for (const label of ['Merged', 'PR opened', 'Empty', 'Failed', 'Finished', 'Launched']) expect(within(table).getByText(label)).toBeTruthy();
    expect(screen.getByText('1 unreadable records skipped.')).toBeTruthy();
    expect(screen.getAllByText('unknown').length).toBeGreaterThan(0);
    expect(table.querySelector('time')?.dateTime).toBe('2026-11-09T10:00:00Z');
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'phantom' } });
    expect(screen.queryByText('J6')).toBeNull();
    fireEvent.change(screen.getByLabelText('Lane'), { target: { value: 'fast' } });
    expect(screen.queryByText('J1')).toBeNull();
    expect(screen.getByText('No work events match these filters.')).toBeTruthy();
  });
  it('renders an empty state', async () => {
    vi.mocked(apiGet).mockResolvedValue(report()); render(<WorklogView />);
    expect(await screen.findByText('No work events in the last 24 hours. New events will appear here.')).toBeTruthy();
  });
  it('updates live, preserves filters and stops polling after unmount', async () => {
    vi.useFakeTimers(); vi.mocked(apiGet).mockResolvedValue(report([entry('launch', 'J1')]));
    const view = render(<WorklogView />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    fireEvent.change(screen.getByLabelText('Repo'), { target: { value: 'phantom' } });
    vi.mocked(apiGet).mockResolvedValue(report([entry('pr', 'J2'), entry('launch', 'J1')]));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByText('J2')).toBeTruthy();
    expect(screen.getByLabelText('Repo')).toHaveValue('phantom');
    view.unmount(); const calls = vi.mocked(apiGet).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000); expect(apiGet).toHaveBeenCalledTimes(calls);
  });
  it('shows refresh failure while keeping the last events and allows retry', async () => {
    vi.useFakeTimers(); vi.mocked(apiGet).mockResolvedValue(report([entry('launch', 'J1')]));
    render(<WorklogView />); await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    vi.mocked(apiGet).mockRejectedValue(new Error('offline'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByRole('alert')).toHaveTextContent('Showing the last available events.');
    expect(screen.getByText('J1')).toBeTruthy();
    vi.mocked(apiGet).mockResolvedValue(report([entry('merged', 'J2')]));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry' })); });
    expect(screen.getByText('J2')).toBeTruthy(); expect(screen.queryByRole('alert')).toBeNull();
  });
});
