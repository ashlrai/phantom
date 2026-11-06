import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import type { GrokUltraRunway as Runway } from '../../../../core/fleet/grok-ultra-types.js';
import { evictAll } from '../../../data/cache.js';
import { stubSurfaceFetch } from '../command/fetch-stub.test-support.js';
import { GrokUltraRunway, narrowGrokUltraRunway } from './GrokUltraRunway.js';

const PATH = '/api/verse/fleet/grok-ultra';
function fixture(): Runway {
  const at = new Date().toISOString();
  return { v: 1, state: 'current', checkedAt: at, targetAt: '2026-11-02T01:21:00.000Z',
    collection: { mode: 'manual', reason: 'safe-local-source-unavailable' },
    latest: { source: 'manual', timestamp: at, remainingPoints: 750, totalPoints: 1000 },
    burnPointsPerHour: { h1: 5, h6: 7, h24: null }, projectedRemainingPoints: { h1: 50, h6: -230, h24: null }, idealPointsPerHour: 4.6 };
}

beforeEach(() => evictAll());
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Grok Ultra runway', () => {
  it('shows manual provenance, each window, deficit and the precise landing time using GET only', async () => {
    const value = fixture();
    const { fetchMock, posted } = stubSurfaceFetch({ routes: { [PATH]: value } });
    render(<GrokUltraRunway />);
    await screen.findByText('50 points remaining');
    expect(screen.getByText('230 points short')).toBeInTheDocument();
    expect(screen.getByText('5 points/hour')).toBeInTheDocument();
    expect(screen.getByText('7 points/hour')).toBeInTheDocument();
    expect(screen.getByText('4.6 points/hour')).toBeInTheDocument();
    expect(screen.getByText(/Manual readings/)).toBeInTheDocument();
    expect(screen.getByText(/Sun Nov 1, 2026, 8:21 PM ET/)).toBeInTheDocument();
    expect(screen.getByText('Last 24 hours')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(2);
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(value.latest!.timestamp);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([]);
  });

  it('withholds rates, projections and ideal pace for stale evidence while retaining the observed balance', async () => {
    const value = fixture(); value.state = 'stale';
    stubSurfaceFetch({ routes: { [PATH]: value } });
    render(<GrokUltraRunway />);
    await screen.findByText(/Reading is stale/);
    expect(screen.getByText('750')).toBeInTheDocument();
    expect(screen.queryByText('5 points/hour')).toBeNull();
    expect(screen.queryByText('230 points short')).toBeNull();
    expect(screen.getAllByText('Unknown')).toHaveLength(7);
  });

  it('shows missing manual readings as unknown instead of measured zero', async () => {
    const value = fixture(); value.state = 'manual-required'; value.latest = null;
    value.idealPointsPerHour = null;
    value.burnPointsPerHour = { h1: null, h6: null, h24: null };
    value.projectedRemainingPoints = { h1: null, h6: null, h24: null };
    stubSurfaceFetch({ routes: { [PATH]: value } });
    render(<GrokUltraRunway />);
    await screen.findByText(/Add a manual reading/);
    expect(screen.getAllByText('Unknown')).toHaveLength(7);
    expect(screen.queryByText('0 points/hour')).toBeNull();
  });

  it('handles an older server without manufacturing a reading', async () => {
    const { posted } = stubSurfaceFetch({ routes: { [PATH]: null } });
    render(<GrokUltraRunway />);
    await screen.findByText(/not in this build yet/);
    expect(screen.queryByText(/points remaining/)).toBeNull();
    expect(posted).toEqual([]);
  });

  it('refreshes usage-only evidence every 30 seconds and clears polling on unmount', async () => {
    vi.useFakeTimers();
    const { fetchMock } = stubSurfaceFetch({ routes: { [PATH]: fixture() } });
    const view = render(<GrokUltraRunway />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expires a cached current response locally after 20 minutes', async () => {
    vi.useFakeTimers();
    const value = fixture();
    stubSurfaceFetch({ routes: { [PATH]: value } });
    render(<GrokUltraRunway />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('5 points/hour')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(20 * 60_000 + 15_000); });
    expect(screen.getByText(/Reading is stale/)).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(7);
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(value.latest!.timestamp);
    expect(screen.getByText('750')).toBeInTheDocument();
  });

  it('retains the last balance and timestamp after failed refreshes without retaining live forecasts', async () => {
    vi.useFakeTimers();
    const value = fixture();
    let reads = 0;
    stubSurfaceFetch({ routes: { [PATH]: () => ++reads === 1
      ? new Response(JSON.stringify(value), { status: 200 }) : new Response('{}', { status: 503 }) } });
    render(<GrokUltraRunway />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(screen.getByText('5 points/hour')).toBeInTheDocument();
    await act(async () => { await vi.advanceTimersByTimeAsync(21 * 60_000); });
    expect(screen.getByText(/Reading is stale/)).toBeInTheDocument();
    expect(screen.getAllByText('Unknown')).toHaveLength(7);
    expect(screen.getByText('750')).toBeInTheDocument();
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe(value.latest!.timestamp);
    expect(reads).toBeGreaterThan(1);
  });

  it('rejects malformed numbers, missing current readings and unknown provenance', () => {
    expect(narrowGrokUltraRunway(fixture())).not.toBeNull();
    const value = fixture(); value.burnPointsPerHour.h1 = NaN;
    expect(narrowGrokUltraRunway(value)).toBeNull();
    expect(narrowGrokUltraRunway({ ...fixture(), latest: null })).toBeNull();
    expect(narrowGrokUltraRunway({ ...fixture(), state: 'manual-required', latest: null })).toBeNull();
    expect(narrowGrokUltraRunway({ ...fixture(), latest: { ...fixture().latest, source: 'browser' } })).toBeNull();
    expect(narrowGrokUltraRunway({ ...fixture(), latest: { ...fixture().latest, remainingPoints: 1001 } })).toBeNull();
  });
});
