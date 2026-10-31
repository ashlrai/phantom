import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { SectionVisibilityProvider } from '../shell/section-visibility.js';
import { BusFeed } from './BusFeed.js';
import type { BusFeedData } from './bus-feed-queries.js';

const path = '/api/verse/fleet/live/bus';
const now = Date.parse('2026-10-31T12:02:00Z');
const fixture = (): BusFeedData => ({ v: 1, hops: [{ id: 'h', from: 'leader', to: 'worker', inputTokens: 1200, outputTokens: 340 }], hopsDropped: 0, lastHopAt: '2026-10-31T12:00:00Z', events: [{ at: '2026-10-31T12:01:00Z', kind: 'incident', text: 'Worker needs attention' }], sources: { hops: 'healthy', events: 'healthy' } });
beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe('Agent bus', () => {
  it('renders healthy rows, full titles and a labelled list using GET only', async () => {
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [path]: fixture() } });
    render(<BusFeed now={now} />);
    expect(await screen.findByText('leader → worker · 1.2k in / 340 out')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Agent bus' }).children).toHaveLength(2);
    expect(screen.getByText('Worker needs attention')).toHaveAttribute('title', 'Worker needs attention');
    expect(screen.getByText('incident').closest('li')).toHaveAttribute('data-tone', 'danger');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Agent bus · 1 hops · last hop 2 m ago')).toBeInTheDocument();
    expect(String(fetchMock.mock.calls[0][0])).toContain('?limit=50');
    expect(posted).toEqual([]);
  });
  it('shows source badges', async () => {
    stubSurfaceFetch({ routes: { [path]: { ...fixture(), sources: { hops: 'missing', events: 'degraded' } } } });
    render(<BusFeed now={now} />);
    expect(await screen.findByText('hop log missing')).toBeInTheDocument();
    expect(screen.getByText('events degraded')).toBeInTheDocument();
  });
  it('treats an invalid response as unavailable', async () => {
    stubSurfaceFetch({ routes: { [path]: { v: 1 } } });
    render(<BusFeed now={now} />);
    expect(await screen.findByText('Agent bus is unavailable.')).toBeInTheDocument();
  });
  it('polls every 10 seconds only while visible', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubSurfaceFetch({ routes: { [path]: fixture() } });
    const view = render(<SectionVisibilityProvider visible><BusFeed now={now} /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.rerender(<SectionVisibilityProvider visible={false}><BusFeed now={now} /></SectionVisibilityProvider>);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('renders the quiet state', async () => {
    stubSurfaceFetch({ routes: { [path]: { ...fixture(), hops: [], events: [], lastHopAt: null } } });
    render(<BusFeed now={now} />);
    expect(await screen.findByText('The bus is quiet. Hops appear when agents message each other.')).toBeInTheDocument();
  });
  // Last: the 404 memo intentionally lasts for this module's page lifetime.
  it('remembers a 404 across polling, rerender and remount', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubSurfaceFetch({ routes: { [path]: null } });
    const view = render(<BusFeed now={now} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('Agent bus is not in this build yet.')).toBeInTheDocument();
    view.rerender(<BusFeed now={now + 60_000} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    view.unmount();
    evictAll();
    render(<BusFeed now={now} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
