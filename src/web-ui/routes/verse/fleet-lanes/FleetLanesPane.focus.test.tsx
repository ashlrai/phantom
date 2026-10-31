import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import type { FleetRuns } from '../ops/ops-runs-model.js';
import { requestLaneFocus, resetLaneFocus, takeRequestedLane } from './lane-focus-request.js';
import { FleetLanesPane } from './FleetLanesPane.js';

const fixture: FleetRuns = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', sources: { runsDir: 'healthy', workers: 'healthy', inbox: 'healthy', codex: 'healthy', merges: 'healthy' },
  lastTick: null, paused: null, memFreePct: null, diskFreeGb: null, switches: [], claudeLane: null,
  lanes: [
    { lane: 'codex-personal', running: 0, target: 2, queued: 1, held: true, heldReason: 'usage_limit', tokensLastHour: null, merged24h: null, mergeRate24h: null },
    { lane: 'devin', running: 1, target: 1, queued: 0, held: true, heldReason: null, tokensLastHour: null, merged24h: null, mergeRate24h: null },
  ],
  workers: [], claimed: [],
  leaders: [], orchestratorAgents: null, publishesLastHour: [], mergesLastHour: { count: 0, items: [] }, events: [], codexPersonal: null, inbox: [], drop: null,
};
const serve = (data: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => Response.json(data, { status })));
const laneItem = async (name: string) => (await screen.findByText(name)).closest('li')!;

beforeEach(() => { evictAll(); resetLaneFocus(); });
afterEach(() => {
  resetLaneFocus();
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

it('writes the held reason under each held lane instead of hiding it in a tooltip', async () => {
  serve(fixture); render(<FleetLanesPane visible />);
  expect(await screen.findByText('Held: usage limit')).toBeInTheDocument();
  expect(screen.getByText('Held: reason not reported')).toBeInTheDocument();
  const badges = screen.getAllByText('Held');
  expect(badges).toHaveLength(2);
  expect(badges[0]).toHaveAttribute('title', 'usage_limit');
});

it('focuses a requested lane, scrolls it into view once and drains the request', async () => {
  const scrollIntoView = vi.fn();
  Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });
  requestLaneFocus('devin');
  serve(fixture); render(<FleetLanesPane visible />);
  const item = await laneItem('devin');
  await waitFor(() => expect(item).toHaveAttribute('data-focused', 'true'));
  expect(item).toHaveAttribute('aria-current', 'true');
  expect(takeRequestedLane()).toBeNull();
  expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
  expect(await laneItem('codex-personal')).not.toHaveAttribute('data-focused');
});

it('ignores an invalid requested lane', async () => {
  requestLaneFocus('../x');
  serve(fixture); render(<FleetLanesPane visible />);
  await laneItem('devin');
  expect(document.querySelector('[data-focused]')).toBeNull();
  expect(takeRequestedLane()).toBeNull();
});
