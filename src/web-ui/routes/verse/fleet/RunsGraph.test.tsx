import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetLive } from '../command/fixtures.test-support.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import FleetWorld from './FleetWorld.js';
import { RunsGraph } from './RunsGraph.js';
const data = { v: 1, workers: [{ job: 'job-1', model: 'codex' }], leaders: [{}], mergesLastHour: { count: 2 }, switches: ['PAUSE'] };
beforeEach(() => { evictAll(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(data))); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('Runs graph lens', () => {
  it('renders the description, graph, switch tag and native run tooltip', async () => {
    const { container } = render(<RunsGraph />);
    expect(await screen.findByText('1 leader · 1 lane · 1 job · 2 merges')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByText('Switches on: PAUSE')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inspect workspace node run:job-1' })).toHaveAttribute('title', expect.stringContaining('job-1 · unknown lane · codex'));
    expect(container.querySelector('[stroke-dasharray]')).toBeInTheDocument();
  });
  it('polls every ten seconds only while the section is visible', async () => {
    vi.useFakeTimers();
    const { rerender } = render(<SectionVisibilityProvider visible><RunsGraph /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('1 leader · 1 lane · 1 job · 2 merges')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
    rerender(<SectionVisibilityProvider visible={false}><RunsGraph /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('switches back to the existing workspace view', async () => {
    render(<FleetWorld read={{ value: fleetLive('live', Date.now()), available: true, reason: null }} agentWorkspace />);
    expect(screen.getByRole('heading', { name: 'Workspace graph' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Runs graph' }));
    await screen.findByText('1 leader · 1 lane · 1 job · 2 merges');
    fireEvent.click(screen.getByRole('radio', { name: 'Workspaces' }));
    expect(screen.getByRole('heading', { name: 'Workspace graph' })).toBeInTheDocument();
  });
  it('shows empty and read-failure states without inventing data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ...data, leaders: [], workers: [], switches: [], mergesLastHour: { count: 0 } })));
    const { unmount } = render(<RunsGraph />);
    await screen.findByText('No runs right now.'); unmount(); evictAll();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 500 })));
    render(<RunsGraph />);
    await screen.findByText('Runs could not be read.');
  });
  it('memoizes a missing route across remounts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status: 404 })));
    const { unmount } = render(<RunsGraph />);
    await screen.findByText('Not in this build yet.'); unmount(); evictAll();
    render(<RunsGraph />);
    await waitFor(() => expect(screen.getByText('Not in this build yet.')).toBeInTheDocument());
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
