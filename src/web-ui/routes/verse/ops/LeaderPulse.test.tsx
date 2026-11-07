import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { LeaderPulse } from './LeaderPulse.js';
import { OpsLeaders } from './OpsLeaders.js';

const snapshot = () => ({
  v: 1, generatedAt: new Date().toISOString(), lastTick: new Date(Date.now() - 60_000).toISOString(), paused: false,
  claudeLane: 'down for repair', leaders: [{ label: 'Alpha', ageSeconds: 240 }, { label: 'Beta', ageSeconds: 1200 }, { label: 'Gamma', ageSeconds: null }],
  orchestratorAgents: 12, drop: { pending: [{ lane: 'devin', file: '/tmp/one.json' }, { lane: 'codex-personal', file: 'two.json' }], done: 12 },
  sources: { runsDir: 'healthy' },
});
const channel = {
  v: 1, generatedAt: '2026-10-30T10:05:00Z', team: 'default', channel: 'leaders',
  leaders: [], channels: [{ channel: 'leaders', count: 1 }],
  messages: [{ id: 'm1', from: 'mason', at: 'today', text: 'Channel message' }],
  openHandoffs: [], pendingApprovals: [], canPost: false,
};
const wrap = (child: React.ReactNode, visible = true) => <SectionVisibilityProvider visible={visible}>{child}</SectionVisibilityProvider>;

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('LeaderPulse', () => {
  it('renders the live snapshot, stale and unknown ages, lane warning and drop files', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(snapshot())));
    render(wrap(<LeaderPulse />));
    expect(await screen.findByText(/3 leaders, newest pass 4 min ago · 12 agents · tick 1 min ago/)).toBeInTheDocument();
    expect(screen.getByText('Alpha · 4 min ago')).toBeInTheDocument();
    expect(screen.getByText('Beta · 20 min ago · stale')).toBeInTheDocument();
    expect(screen.getByText('Gamma · —')).toBeInTheDocument();
    expect(screen.getByText('down for repair')).toBeInTheDocument();
    expect(screen.getByText(/Run the lane fix script from the runs dir bin folder/)).toBeInTheDocument();
    expect(screen.getByText('Waiting for ingest: codex-personal 1 · devin 1 (12 ingested)')).toBeInTheDocument();
    expect(screen.getByText('devin: one.json')).toBeInTheDocument();
  });

  it('memoizes a 404 through rerenders and polling, and retries after reopening', async () => {
    const fetcher = vi.fn(async () => Response.json({ error: 'not found' }, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const view = render(wrap(<LeaderPulse />));
    expect(await screen.findByText('Leader passes are not in this build yet.')).toBeInTheDocument();
    view.rerender(wrap(<LeaderPulse />));
    vi.useFakeTimers();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(wrap(<LeaderPulse />, false));
    view.rerender(wrap(<LeaderPulse />, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('polls every ten seconds only while the section is visible', async () => {
    const fetcher = vi.fn(async () => Response.json(snapshot()));
    vi.stubGlobal('fetch', fetcher);
    const view = render(wrap(<LeaderPulse />));
    await screen.findByText('Alpha · 4 min ago');
    vi.useFakeTimers();
    view.rerender(wrap(<LeaderPulse />, false));
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    view.rerender(wrap(<LeaderPulse />, true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('retries other failures and shows a clear queue', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 500 }))
      .mockImplementation(async () => Response.json({ ...snapshot(), drop: { pending: [], done: 12 } }));
    vi.stubGlobal('fetch', fetcher);
    render(wrap(<LeaderPulse />));
    expect(await screen.findByText(/Leader passes unavailable/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Drop queue clear (12 ingested)')).toBeInTheDocument();
  });

  it('mounts above the existing leaders group and channel', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/verse/ops/leaders'
      ? Response.json(channel) : Response.json(snapshot())));
    render(wrap(<OpsLeaders />));
    expect(await screen.findByText('Channel message')).toBeInTheDocument();
    const section = screen.getByRole('region', { name: "Leaders' channel" });
    const headings = within(section).getAllByRole('heading').map(h => h.textContent);
    expect(headings).toEqual(["Leaders' channel", 'Leader passes', 'Leaders', '#leaders']);
    await waitFor(() => expect(screen.getByText('Alpha · 4 min ago')).toBeInTheDocument());
  });
});
