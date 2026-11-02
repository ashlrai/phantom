import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { evictAll } from '../../../data/cache.js';
import { LeaderPasses } from './LeaderPasses.js';

beforeEach(() => evictAll());
afterEach(() => { cleanup(); evictAll(); vi.unstubAllGlobals(); });

it('shows overdue passes in the danger tone', async () => {
  const fetcher = vi.fn(async (_input: RequestInfo | URL) => Response.json({
    generatedAt: new Date().toISOString(), sources: { workers: 'healthy', runsDir: 'healthy' },
    leaders: [{ label: 'sol-leader', ageSeconds: 48 * 60 }],
  }));
  vi.stubGlobal('fetch', fetcher);
  render(<LeaderPasses />);
  const due = await screen.findByText(/pass overdue by \d+ min/);
  expect(due.parentElement).toHaveAttribute('data-tone', 'danger');
  expect(due.closest('[data-tone]')?.parentElement?.parentElement).toHaveTextContent('sol-leader');
  expect(fetcher.mock.calls[0]?.[0]).toContain('/api/verse/fleet/runs');
});
