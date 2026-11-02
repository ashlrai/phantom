import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { isFleetRuns } from '../ops/ops-runs-model.js';
import { FleetLanesPane } from './FleetLanesPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows live lane burn and the fleet total', async () => {
  const fixture = withLane(fleetRunsFixture({ claudeLane: null }), { lane: 'codex-personal', tokensLastHour: 1_300_000, merged24h: 9 });
  expect(isFleetRuns(fixture)).toBe(true);
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture, { status: 200 })));
  render(<FleetLanesPane visible />);
  expect(await screen.findByText('1.3M tokens in the last hour across 1 reporting lane')).toBeInTheDocument();
  const reportingLane = screen.getByText('codex-personal').closest('li')!;
  expect(within(reportingLane).getByText(/1\.3M tok\/h · 9 merged\/24 h/)).toBeInTheDocument();
  const missingLane = screen.getByText('devin').closest('li')!;
  expect(within(missingLane).getByText(/— tok\/h/)).toBeInTheDocument();
});
