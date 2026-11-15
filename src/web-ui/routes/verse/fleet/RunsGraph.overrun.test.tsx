import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { evictAll } from '../../../data/cache.js';
import { RunsGraph } from './RunsGraph.js';

const data = {
  v: 1,
  workers: [
    { job: 'job-1', model: 'codex', lane: 'devin', overrun: { ratio: 2.4, medianMs: 2_400_000 } },
    { job: 'job-2', model: 'codex', lane: 'devin' },
  ],
  leaders: [{}], mergesLastHour: { count: 0 }, switches: [],
};

beforeEach(() => { evictAll(); vi.stubGlobal('fetch', vi.fn(async () => Response.json(data))); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('Runs graph overrun chip', () => {
  it('shows a warning chip on an overrun run row and none on a normal row', async () => {
    const { container } = render(<RunsGraph />);
    const chip = await screen.findByText('Overrun 2.4x');
    expect(chip).toHaveAttribute('title', 'Lane median 40 min');
    const flagged = screen.getByRole('button', { name: 'Inspect workspace node run:job-1' });
    const normal = screen.getByRole('button', { name: 'Inspect workspace node run:job-2' });
    expect(flagged.contains(chip)).toBe(true);
    expect(normal.querySelector('span[data-overrun]')).toBeNull();
    expect(container.querySelectorAll('span[data-overrun]')).toHaveLength(1);
  });
});
