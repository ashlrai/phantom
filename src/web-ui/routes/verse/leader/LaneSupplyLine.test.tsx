import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { LaneSupplyLine } from './LaneSupplyLine.js';

const report = (alarm: string | null) => ({ schema: 'fleet.lane-supply.v1', generatedAt: 'x', lanes: [], idle: alarm ? ['claude'] : [], alarm,
  planner: { state: 'unknown', lastPassAt: null, ageSeconds: null }, autofill: { state: 'unknown', items: null, note: null } });
const serve = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));

beforeEach(() => evictAll());
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the one alarm line when a lane is idle with usage left', async () => {
  serve(report('claude idle: 6 free slots, 68% left'));
  render(<LaneSupplyLine />);
  expect(await screen.findByText(/claude idle: 6 free slots, 68% left/)).toBeInTheDocument();
  expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/verse/fleet/lane-supply');
});

it('draws nothing when no lane is idle, or when the Mac does not answer', async () => {
  serve(report(null));
  const first = render(<LaneSupplyLine />);
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(first.container).toBeEmptyDOMElement();
  first.unmount(); evictAll();
  serve({ error: 'no' }, 503);
  const second = render(<LaneSupplyLine />);
  await vi.waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
  expect(second.container).toBeEmptyDOMElement();
});
