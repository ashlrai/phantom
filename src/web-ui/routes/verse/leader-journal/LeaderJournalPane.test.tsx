import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { PaneProps } from '../panes/pane-registry.js';
import { LeaderJournalPane } from './LeaderJournalPane.js';

const data = () => ({ v: 1, generatedAt: '2026-01-01T12:05:00Z', sources: { planLog: 'healthy', ingestLog: 'healthy', ingested: 'healthy' },
  passes: [
    { at: '2026-01-01T12:00:00Z', sections: [{ title: 'Earlier', bullets: ['Old plan'] }] },
    { at: '2026-01-01T12:04:00Z', sections: [{ title: 'Plan', bullets: ['Inspect the queue', 'Start work'] }] },
  ],
  ingest: [{ verb: 'reject', file: 'bad.json', reason: 'denied-path' }, { verb: 'reject', file: 'bad2.json', reason: 'denied-path' }, { verb: 'accept', file: 'good.json', reason: null }],
  ingested: [{ at: '2026-01-01T12:03:00Z', id: 'job-1', lane: 'main', tier: 'mid', leader: 'alpha', title: 'Test job' }], rejectedLastHour: 2 });
const props = { visible: true } as PaneProps;

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('LeaderJournalPane', () => {
  it('renders newest passes, the drop funnel and rejection details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(data())));
    render(<LeaderJournalPane {...props} />);
    expect(await screen.findByText('2 rejected in the last hour')).toBeInTheDocument();
    const passes = screen.getByRole('region', { name: 'Passes' });
    const details = passes.querySelectorAll('details');
    expect(details).toHaveLength(2);
    expect(details[0]).toHaveAttribute('open');
    expect(details[1]).not.toHaveAttribute('open');
    expect(details[0]!.querySelector('summary')).toHaveTextContent('2026-01-01T12:04:00Z · Inspect the queue');
    expect(within(details[0]!).getByRole('heading', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByText('Rejections: denied-path (2)')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Ingested jobs' })).toHaveTextContent('job-1');
    expect(screen.getByText('reject · bad.json').closest('li')).toHaveAttribute('data-tone', 'bad');
    expect(screen.getAllByText(/denied-path/)).toHaveLength(3);
  });
  it('shows loading, the 404 message and refreshes on demand', async () => {
    let resolve!: (response: Response) => void;
    const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; })).mockResolvedValue(Response.json(data()));
    vi.stubGlobal('fetch', fetcher);
    render(<LeaderJournalPane {...props} />);
    expect(screen.getByLabelText('Loading leader journal')).toBeInTheDocument();
    await act(async () => { resolve(Response.json({}, { status: 404 })); });
    expect(await screen.findByText('The leader journal API has not landed in this build yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('2 rejected in the last hour')).toBeInTheDocument();
  });
  it('displays invalid responses and server errors', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ v: 2 })).mockResolvedValueOnce(Response.json({ error: 'unavailable' }, { status: 500 }));
    vi.stubGlobal('fetch', fetcher);
    render(<LeaderJournalPane {...props} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid leader journal response.');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
  });
  it('explains missing sources and empty data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data(), sources: { planLog: 'missing', ingestLog: 'missing', ingested: 'missing' }, passes: [], ingest: [], ingested: [], rejectedLastHour: null })));
    render(<LeaderJournalPane {...props} />);
    expect(await screen.findByText('Plan log source missing.')).toBeInTheDocument();
    expect(screen.getByText('Ingest log source missing.')).toBeInTheDocument();
    expect(screen.getByText('Ingested jobs source missing.')).toBeInTheDocument();
    expect(screen.getByText('No leader passes yet.')).toBeInTheDocument();
    expect(screen.getByText('No ingested jobs recorded.')).toBeInTheDocument();
    expect(screen.getByText('No ingest events recorded.')).toBeInTheDocument();
  });
  it('polls every 30 seconds while visible and stops when hidden or unmounted', async () => {
    const fetcher = vi.fn(async () => Response.json(data()));
    vi.stubGlobal('fetch', fetcher);
    vi.useFakeTimers();
    const view = render(<LeaderJournalPane {...props} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('2 rejected in the last hour')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<LeaderJournalPane {...props} visible={false} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    view.rerender(<LeaderJournalPane {...props} visible />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
