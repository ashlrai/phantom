import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { QueueResourceRows } from './QueueResources.js';
it('shows measured remaining usage, reset and live jobs, with explicit unknowns', () => {
  render(<QueueResourceRows value={{ schema: 'app.resources.v1', resources: [
    { pool: 'codex-personal', remainingPercent: 12, resetAt: '2026-11-02T17:25:00.000Z', liveJobs: 2 },
    { pool: 'devin', remainingPercent: null, resetAt: null, liveJobs: null },
  ] }} />);
  expect(screen.getByRole('button', { name: /codex-personal: 12% left.*live jobs 2/ })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'devin: unknown · reset unknown · live jobs unknown' })).toBeTruthy();
  expect(screen.queryByText(/0%/)).toBeNull();
});
