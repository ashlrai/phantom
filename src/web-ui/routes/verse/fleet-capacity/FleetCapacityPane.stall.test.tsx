import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function fixture(queued: number) {
  const now = Date.now();
  return {
    v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 30 * 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
    samples: Array.from({ length: 7 }, (_, index) => ({ at: new Date(now - (30 - index * 5) * 60_000).toISOString(), workers: 1, leaders: 1, paused: false, lanes: [
      { lane: 'codex-personal', running: 18, target: 24, queued, held: false },
      { lane: 'devin', running: 4, target: 4, queued: 8, held: false },
    ] })),
  };
}

it('shows a warning headline and stall minutes on the affected lane', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture(8))));
  render(<FleetCapacityPane visible />);
  const headline = await screen.findByText('Launch stall: codex-personal waited 30 min with 6 open slots');
  expect(headline).toHaveAttribute('role', 'status');
  expect(headline.compareDocumentPosition(screen.getByRole('heading', { name: 'Lane capacity' })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const personal = screen.getByRole('button', { name: 'Open codex-personal in Lanes' }).closest('li')!;
  const devin = screen.getByRole('button', { name: 'Open devin in Lanes' }).closest('li')!;
  expect(within(personal).getByText(/30 min stalled/)).toBeInTheDocument();
  expect(within(devin).queryByText(/min stalled/)).not.toBeInTheDocument();
});

it('omits the headline and suffix when no lane stalled', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(fixture(0))));
  render(<FleetCapacityPane visible />);
  await screen.findByRole('heading', { name: 'Lane capacity' });
  expect(screen.queryByText(/Launch stall:/)).not.toBeInTheDocument();
  expect(screen.queryByText(/min stalled/)).not.toBeInTheDocument();
});
