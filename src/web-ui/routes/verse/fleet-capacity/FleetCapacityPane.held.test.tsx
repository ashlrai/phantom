import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { FleetCapacityPane } from './FleetCapacityPane.js';

beforeEach(() => { evictAll(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('shows the current hold below its lane chart only', async () => {
  const now = Date.now();
  const lanes = [
    { lane: 'codex-personal', running: 0, target: 2, queued: 1, held: true, heldReason: 'usage_limit' },
    { lane: 'devin', running: 1, target: 1, queued: 0, held: false, heldReason: null },
  ];
  const history = {
    v: 1, generatedAt: new Date(now).toISOString(), from: new Date(now - 60_000).toISOString(), to: new Date(now).toISOString(), sourceState: 'healthy', dropped: 0,
    samples: [{ at: new Date(now).toISOString(), workers: 1, leaders: 1, paused: false, lanes }],
  };
  const snapshot = { lanes, codexPersonal: { resetsAt: '2026-11-04T06:41:00Z' } };
  vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => Response.json(String(url).endsWith('/fleet/runs') ? snapshot : history)));
  render(<FleetCapacityPane visible />);
  const held = await screen.findByTestId('lane-held');
  const personalRow = screen.getByRole('button', { name: 'Open codex-personal in Lanes' }).closest('li')!;
  const devinRow = screen.getByRole('button', { name: 'Open devin in Lanes' }).closest('li')!;
  expect(within(personalRow).getByTestId('lane-held')).toBe(held);
  expect(held).toHaveTextContent('held: usage_limit · resumes Nov 4 01:41 ET');
  expect(within(devinRow).queryByTestId('lane-held')).not.toBeInTheDocument();
});
