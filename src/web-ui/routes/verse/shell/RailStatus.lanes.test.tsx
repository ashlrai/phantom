import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { fleetRunsFixture, withLane } from '../fleet/fleet-runs-fixtures.test-support.js';
import { RailBadgeMark, railBadgeFor } from './RailStatus.js';

afterEach(() => { vi.unstubAllGlobals(); evictAll(); });

it('shows live fleet lane counts and warning tone on the rail badge', async () => {
  const input = withLane(fleetRunsFixture({ switches: [] }), { lane: 'codex-personal', running: 24, target: 24 });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(input), { status: 200 })));
  const badge = railBadgeFor('fleet', null)!;
  const { container } = render(<RailBadgeMark badge={badge} />);
  const mark = await screen.findByTitle(/personal 24\/24/);
  expect(mark).toHaveAttribute('aria-label', expect.stringContaining('personal 24/24'));
  expect(mark).toHaveAttribute('data-tone', 'warning');
  expect(mark).toHaveTextContent('1');
  await waitFor(() => expect(container.querySelector('[data-badge="count"]')).toBe(mark));
});

it('shows a warning when no workers are running and autonomy is unavailable', async () => {
  const input = fleetRunsFixture({ workers: [], switches: [] });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(input), { status: 200 })));
  render(<RailBadgeMark badge={railBadgeFor('fleet', null)!} />);
  const mark = await screen.findByTitle(/personal 3\/4/);
  expect(mark).toHaveTextContent('0');
  expect(mark).toHaveAttribute('data-tone', 'warning');
});
